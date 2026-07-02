//! `git clone` for the "Get source code" wizard.
//!
//! QA testers who can't manage git themselves get their source cloned here using
//! the Azure DevOps PAT the app already holds (primary path) or arbitrary HTTPS
//! credentials (secondary path). Progress streams to the frontend over a
//! `Channel`; a kill-based cancel stops a long clone.
//!
//! Credential persistence mirrors VS Code / Git Credential Manager: the clone
//! itself carries a one-shot `http.extraHeader`, then — if the user opts in — we
//! seed the configured credential helper (`git credential approve`, secret lands
//! in the OS keychain) so later plain `git pull`/`git fetch` (which inject no
//! auth) succeed. Only when NO helper is configured do we fall back to writing an
//! org-scoped `http.<base>.extraHeader` into the repo's local config.

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::ffi::{OsStr, OsString};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};
use url::Url;

use crate::modules::ado::client::{auth_header, keyring_service, pat_account};
use crate::modules::git::hide_console;
use crate::modules::git_bin::{git_program, locate_git};

// ── Wire types ──────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CloneAuth {
    /// Use the stored Azure DevOps PAT (Basic auth, empty username).
    AdoPat,
    /// Arbitrary HTTPS Basic credentials the user typed.
    Basic { username: String, password: String },
    /// Public repo — no auth.
    None,
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CloneProgress {
    /// A parsed git progress line, e.g. phase "Receiving objects", pct 45.
    Phase { phase: String, pct: Option<u8> },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCloneResult {
    /// cloned | no-git | auth-failed | offline | exists | cancelled | error
    pub status: String,
    pub path: Option<String>,
    pub message: String,
}

impl GitCloneResult {
    fn fail(status: &str, message: impl Into<String>) -> Self {
        Self {
            status: status.to_string(),
            path: None,
            message: message.into(),
        }
    }
}

/// Auth resolved to the header used at clone time plus the material needed to
/// persist credentials afterward.
enum ResolvedAuth {
    None,
    Ado { pat: String, header: String },
    Basic {
        username: String,
        password: String,
        header: String,
    },
}

impl ResolvedAuth {
    fn header(&self) -> Option<&str> {
        match self {
            ResolvedAuth::None => None,
            ResolvedAuth::Ado { header, .. } | ResolvedAuth::Basic { header, .. } => Some(header),
        }
    }
}

// ── Cancellation registry ───────────────────────────────────────────────

struct CloneHandle {
    child: Mutex<Child>,
    cancelled: AtomicBool,
}

fn clone_registry() -> &'static Mutex<HashMap<u64, Arc<CloneHandle>>> {
    static REG: OnceLock<Mutex<HashMap<u64, Arc<CloneHandle>>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Ids cancelled before their clone registered (the clone invoke and the cancel
/// invoke can interleave). Consumed the instant the clone registers.
fn clone_precancel() -> &'static Mutex<HashSet<u64>> {
    static REG: OnceLock<Mutex<HashSet<u64>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashSet::new()))
}

struct CloneGuard(u64);
impl Drop for CloneGuard {
    fn drop(&mut self) {
        if let Ok(mut reg) = clone_registry().lock() {
            reg.remove(&self.0);
        }
    }
}

#[tauri::command]
pub fn git_clone_cancel(request_id: u64) {
    if let Ok(reg) = clone_registry().lock() {
        if let Some(handle) = reg.get(&request_id) {
            handle.cancelled.store(true, Ordering::SeqCst);
            if let Ok(mut c) = handle.child.lock() {
                let _ = c.kill();
            }
        } else if let Ok(mut pre) = clone_precancel().lock() {
            // Cancel beat registration — remember it (bounded) so the clone
            // aborts the moment it registers.
            if pre.len() > 256 {
                pre.clear();
            }
            pre.insert(request_id);
        }
    }
}

// ── Command ─────────────────────────────────────────────────────────────

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn git_clone(
    app: AppHandle,
    url: String,
    dest_parent: String,
    dir_name: String,
    auth: CloneAuth,
    persist_auth: bool,
    request_id: u64,
    on_event: Channel<CloneProgress>,
) -> Result<GitCloneResult, String> {
    if locate_git().is_none() {
        return Ok(GitCloneResult::fail(
            "no-git",
            "Git isn't installed on this machine.",
        ));
    }
    let program = git_program();

    let resolved = match auth {
        CloneAuth::None => ResolvedAuth::None,
        CloneAuth::Basic { username, password } => {
            let header = format!("Basic {}", B64.encode(format!("{username}:{password}")));
            ResolvedAuth::Basic {
                username,
                password,
                header,
            }
        }
        CloneAuth::AdoPat => {
            let pat = load_ado_pat(&app).await?;
            let Some(pat) = pat.filter(|p| !p.is_empty()) else {
                return Ok(GitCloneResult::fail(
                    "auth-failed",
                    "No Azure DevOps token is saved. Add your PAT in Settings first.",
                ));
            };
            let header = auth_header(&pat);
            ResolvedAuth::Ado { pat, header }
        }
    };

    tauri::async_runtime::spawn_blocking(move || {
        do_clone(
            program,
            url,
            dest_parent,
            dir_name,
            resolved,
            persist_auth,
            request_id,
            move |p| {
                let _ = on_event.send(p);
            },
        )
    })
    .await
    .map_err(|e| format!("git_clone join: {e}"))
}

async fn load_ado_pat(app: &AppHandle) -> Result<Option<String>, String> {
    crate::modules::secrets::secrets_get(
        app.clone(),
        app.state::<crate::modules::secrets::SecretsState>(),
        keyring_service().to_string(),
        pat_account().to_string(),
    )
    .await
}

#[allow(clippy::too_many_arguments)]
fn do_clone<E: Fn(CloneProgress) + Send + 'static>(
    program: OsString,
    url: String,
    dest_parent: String,
    dir_name: String,
    resolved: ResolvedAuth,
    persist_auth: bool,
    request_id: u64,
    emit: E,
) -> GitCloneResult {
    // Guard the destination name so it can't escape the chosen parent folder.
    if dir_name.trim().is_empty()
        || dir_name.contains('/')
        || dir_name.contains('\\')
        || dir_name == "."
        || dir_name == ".."
    {
        return GitCloneResult::fail("error", "Invalid folder name.");
    }

    let parent = PathBuf::from(&dest_parent);
    if !parent.is_dir() {
        return GitCloneResult::fail("error", "The destination folder doesn't exist.");
    }
    let dest = parent.join(&dir_name);
    if dest.exists() {
        let non_empty = std::fs::read_dir(&dest)
            .map(|mut rd| rd.next().is_some())
            .unwrap_or(true);
        if non_empty {
            return GitCloneResult::fail(
                "exists",
                "That folder already exists and isn't empty. Pick a different name or location.",
            );
        }
    }
    // Past here the destination is either absent or an empty dir we're filling,
    // so a failed/cancelled clone's partial tree is always ours to remove — even
    // when the user pre-created an empty folder. Leaving a half-clone behind
    // would wedge every retry on the "already exists and isn't empty" check.

    // Build the clone command. `-c credential.helper=` disables inherited helpers
    // for THIS invocation (no GUI prompt); `GIT_TERMINAL_PROMPT=0` fails fast on
    // missing creds instead of hanging. The extraHeader is command-scoped, so the
    // secret is never written to config by the clone itself.
    let mut cmd = Command::new(&program);
    cmd.arg("-c").arg("credential.helper=");
    if let Some(h) = resolved.header() {
        // Inject the auth header via git's env-based config (GIT_CONFIG_COUNT/
        // KEY/VALUE) rather than `-c` so the PAT/password never lands on the
        // child's command line, where any same-user process can read it
        // (Win32 CommandLine, /proc/<pid>/cmdline). An env block is readable
        // only by the owning user — the same reason VS Code / Git Credential
        // Manager keep secrets off argv.
        cmd.env("GIT_CONFIG_COUNT", "1")
            .env("GIT_CONFIG_KEY_0", "http.extraHeader")
            .env("GIT_CONFIG_VALUE_0", format!("AUTHORIZATION: {h}"));
    }
    cmd.arg("clone")
        .arg("--progress")
        .arg("--")
        .arg(&url)
        .arg(&dest)
        .current_dir(&parent)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .env("LANG", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    hide_console(&mut cmd);

    let mut spawned = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return GitCloneResult::fail("error", format!("Couldn't start git: {e}")),
    };
    let stderr = spawned.stderr.take();

    let handle = Arc::new(CloneHandle {
        child: Mutex::new(spawned),
        cancelled: AtomicBool::new(false),
    });

    // Register (and honor a cancel that raced ahead of us).
    if let Ok(mut reg) = clone_registry().lock() {
        reg.insert(request_id, handle.clone());
        if let Ok(mut pre) = clone_precancel().lock() {
            if pre.remove(&request_id) {
                handle.cancelled.store(true, Ordering::SeqCst);
                if let Ok(mut c) = handle.child.lock() {
                    let _ = c.kill();
                }
            }
        }
    }
    let _guard = CloneGuard(request_id);

    // Read stderr on a detached thread so a killed clone whose transport helper
    // lingers on the pipe can't wedge the wait below. Only non-progress lines are
    // accumulated (progress lines are streamed and discarded), keeping the buffer
    // tiny and holding the diagnostic text used for failure classification.
    let diag = Arc::new(Mutex::new(String::new()));
    let reader = {
        let diag = diag.clone();
        std::thread::spawn(move || {
            let Some(mut err) = stderr else { return };
            let mut buf = [0u8; 4096];
            let mut line: Vec<u8> = Vec::new();
            loop {
                match err.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        for &b in &buf[..n] {
                            if b == b'\r' || b == b'\n' {
                                handle_line(&mut line, &diag, &emit);
                            } else {
                                line.push(b);
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
            handle_line(&mut line, &diag, &emit);
        })
    };

    // Poll for exit, locking the child only briefly each tick so `git_clone_cancel`
    // can interleave to kill it (a blocking `wait()` under the lock would deadlock
    // the cancel).
    loop {
        let done = {
            match handle.child.lock() {
                Ok(mut c) => matches!(c.try_wait(), Ok(Some(_)) | Err(_)),
                Err(_) => true,
            }
        };
        if done {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }

    let cancelled = handle.cancelled.load(Ordering::SeqCst);
    let success = matches!(
        handle.child.lock().ok().and_then(|mut c| c.try_wait().ok().flatten()),
        Some(s) if s.success()
    );

    // Success wins over a late cancel. The poll loop only samples exit every
    // 50 ms, so a cancel can land in the window between git finishing
    // successfully and this check; honoring it would run cleanup_partial over a
    // COMPLETE checkout and delete it. If git succeeded, the tree on disk is
    // good — keep it.
    if success {
        join_reader(reader);
        if persist_auth {
            persist_credentials(&program, &dest, &url, &resolved);
        }
        return GitCloneResult {
            status: "cloned".to_string(),
            path: Some(dest.to_string_lossy().into_owned()),
            message: "Cloned.".to_string(),
        };
    }

    if cancelled {
        // Killed mid-clone: the partial tree is ours to remove. Don't join the
        // reader — a killed clone's transport helper can linger on the pipe.
        cleanup_partial(&dest);
        return GitCloneResult::fail("cancelled", "Clone cancelled.");
    }

    // Genuine failure: collect diagnostics (bounded join, so a lingering child
    // holding stderr open can't wedge the command) and classify.
    join_reader(reader);
    let diagnostics = diag.lock().map(|g| g.clone()).unwrap_or_default();
    cleanup_partial(&dest);
    let (status, message) = classify_clone_stderr(&diagnostics);
    GitCloneResult::fail(status, message)
}

/// Join the stderr reader without ever blocking `git_clone` indefinitely. A
/// lingering transport/credential grandchild can hold the stderr write end open
/// past the top-level git's exit, which would otherwise wedge the join forever;
/// after a short grace period we proceed with whatever diagnostics were captured
/// (the detached thread ends when the pipe finally closes).
fn join_reader(reader: std::thread::JoinHandle<()>) {
    for _ in 0..40 {
        if reader.is_finished() {
            let _ = reader.join();
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Parse a stderr segment: stream real progress lines, keep diagnostics.
fn handle_line<E: Fn(CloneProgress)>(
    buf: &mut Vec<u8>,
    diag: &Arc<Mutex<String>>,
    emit: &E,
) {
    if buf.is_empty() {
        return;
    }
    let line = String::from_utf8_lossy(buf).trim().to_string();
    buf.clear();
    if line.is_empty() {
        return;
    }
    match parse_progress(&line) {
        Some((phase, pct)) => {
            emit(CloneProgress::Phase {
                phase,
                pct: Some(pct),
            });
        }
        None => {
            if let Ok(mut d) = diag.lock() {
                // Bound the diagnostic buffer, but keep the TAIL rather than
                // dropping everything — an auth/offline keyword can precede a
                // later burst of diagnostic lines, and classify_clone_stderr
                // scans the whole buffer for those keywords.
                if d.len() > 8_192 {
                    let mut cut = d.len() - 4_096;
                    while cut < d.len() && !d.is_char_boundary(cut) {
                        cut += 1;
                    }
                    d.drain(..cut);
                }
                d.push_str(&line);
                d.push('\n');
            }
        }
    }
}

/// A git progress line ("Receiving objects:  45% (…)"). Returns the phase label
/// and percent only when a percent is present (the meaningful phases all have
/// one), so non-progress noise is skipped.
fn parse_progress(line: &str) -> Option<(String, u8)> {
    let line = line.strip_prefix("remote:").map(str::trim).unwrap_or(line);
    let colon = line.find(':')?;
    let phase = line[..colon].trim();
    if phase.is_empty() {
        return None;
    }
    let pct = extract_pct(&line[colon..])?;
    Some((phase.to_string(), pct))
}

fn extract_pct(s: &str) -> Option<u8> {
    let bytes = s.as_bytes();
    for (i, &b) in bytes.iter().enumerate() {
        if b == b'%' {
            let mut j = i;
            while j > 0 && bytes[j - 1].is_ascii_digit() {
                j -= 1;
            }
            if j < i {
                if let Ok(n) = s[j..i].parse::<u32>() {
                    return Some(n.min(100) as u8);
                }
            }
        }
    }
    None
}

fn classify_clone_stderr(diagnostics: &str) -> (&'static str, String) {
    let lower = diagnostics.to_ascii_lowercase();
    const AUTH: &[&str] = &[
        "authentication failed",
        "could not read username",
        "terminal prompts disabled",
        "invalid username or password",
        "403 forbidden",
        // git prints HTTP 401/403 as "...returned error: 403" (never the words
        // "403 forbidden"), and the surrounding "unable to access" would
        // otherwise get it misfiled as OFFLINE. Auth is checked first, so these
        // win — a scoped-out PAT reads as a credential problem, not a network one.
        "returned error: 403",
        "returned error: 401",
        "error: 403",
        "error: 401",
        "fatal: authentication",
        "access denied",
        "tf401019",
        "tf400813",
    ];
    const OFFLINE: &[&str] = &[
        "could not resolve host",
        "unable to access",
        "could not read from remote",
        "connection",
        "timed out",
        "no route to host",
        "network is unreachable",
        "proxy",
    ];
    if AUTH.iter().any(|k| lower.contains(k)) {
        return (
            "auth-failed",
            "The credentials were rejected. Check your token is valid and has Code (Read) access."
                .to_string(),
        );
    }
    if OFFLINE.iter().any(|k| lower.contains(k)) {
        return (
            "offline",
            "Couldn't reach the remote. Check your connection and the repository URL.".to_string(),
        );
    }
    let detail = diagnostics
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .map(str::trim)
        .unwrap_or("");
    (
        "error",
        if detail.is_empty() {
            "git clone failed.".to_string()
        } else {
            detail.to_string()
        },
    )
}

/// Remove a half-cloned tree. Only ever called after the empty/absent guard in
/// `do_clone`, so the destination is always one we created or an empty folder we
/// took over — never a directory with the user's own files in it.
fn cleanup_partial(dest: &Path) {
    if dest.exists() {
        let _ = std::fs::remove_dir_all(dest);
    }
}

// ── Credential persistence ──────────────────────────────────────────────

fn persist_credentials(program: &OsStr, dest: &Path, url: &str, resolved: &ResolvedAuth) {
    let Ok(parsed) = Url::parse(url) else { return };
    let Some(host) = parsed.host_str().map(str::to_string) else {
        return;
    };
    let scheme = parsed.scheme().to_string();

    // The username/password we'll hand to git's credential store. (The header
    // form is only used for the one-shot clone; persisted creds always go
    // through a helper so nothing plaintext lands in the repo.)
    // git fills credentials on a later pull/fetch using the username embedded in
    // the remote URL — ADO's remoteUrl carries the org as `{org}@dev.azure.com`.
    // Key the stored credential by THAT username (not a literal "pat"), or
    // git-credential-store won't match on the later query and the pull fails
    // auth. The basic-auth username is irrelevant to ADO (it authenticates on
    // the PAT), and a URL with no userinfo leaves git's query username-less (any
    // stored username matches), so falling back to the typed/"pat" value is safe.
    let url_user = parsed.username();
    let (username, password) = match resolved {
        ResolvedAuth::None => return,
        ResolvedAuth::Ado { pat, .. } => {
            let user = if url_user.is_empty() { "pat" } else { url_user };
            (user.to_string(), pat.clone())
        }
        ResolvedAuth::Basic {
            username, password, ..
        } => {
            let user = if url_user.is_empty() { username.as_str() } else { url_user };
            (user.to_string(), password.clone())
        }
    };

    // dev.azure.com carries the org in the URL path, so a single host key lets a
    // second org clobber the first. For it alone, enable useHttpPath REPO-LOCALLY
    // (never --global — that would change credential keying for every
    // dev.azure.com repo on the machine, breaking pulls of repos cloned outside
    // this app) and key the credential by the FULL path git will query later.
    let is_ado_cloud =
        matches!(resolved, ResolvedAuth::Ado { .. }) && host.eq_ignore_ascii_case("dev.azure.com");
    let path = if is_ado_cloud {
        let _ = run_git_capture(
            program,
            dest,
            &[
                "config",
                "--local",
                "credential.https://dev.azure.com.useHttpPath",
                "true",
            ],
            None,
        );
        Some(parsed.path().trim_start_matches('/').to_string()).filter(|p| !p.is_empty())
    } else {
        None
    };

    // With no credential helper configured, give THIS repo git's `store` helper
    // so the secret lands in ~/.git-credentials (home) — NOT a plaintext
    // http.extraHeader in the repo's own .git/config, which can ride a
    // cloud-synced folder (OneDrive/Dropbox) straight off the machine. `store`
    // is plaintext at rest either way, but stays out of the synced working tree.
    if !has_credential_helper(program, dest) {
        let _ = run_git_capture(
            program,
            dest,
            &["config", "--local", "credential.helper", "store"],
            None,
        );
    }

    let mut input = format!("protocol={scheme}\nhost={host}\n");
    if let Some(p) = &path {
        input.push_str(&format!("path={p}\n"));
    }
    input.push_str(&format!("username={username}\npassword={password}\n\n"));
    let _ = run_git_capture(program, dest, &["credential", "approve"], Some(input.as_bytes()));
}

/// Whether an effective credential helper is configured for the repo. A helper
/// entry with an empty value RESETS the list (git's documented "clear" idiom), so
/// we track the last-writer.
fn has_credential_helper(program: &OsStr, dest: &Path) -> bool {
    let (ok, out, _) = run_git_capture(
        program,
        dest,
        &["config", "--get-all", "credential.helper"],
        None,
    );
    if !ok {
        return false;
    }
    let mut active = false;
    for line in out.lines() {
        // An empty value clears the inherited list (git's documented idiom).
        active = !line.trim().is_empty();
    }
    active
}

/// Run a short git command in `cwd`, optionally feeding stdin. Captures success +
/// stdout + stderr (like `git_ops::run_capture`, kept local so this module has no
/// cross-dependency and can pipe stdin for `credential approve`).
fn run_git_capture(
    program: &OsStr,
    cwd: &Path,
    args: &[&str],
    stdin_data: Option<&[u8]>,
) -> (bool, String, String) {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .current_dir(cwd)
        .env("LC_ALL", "C")
        .env("LANG", "C")
        .stdin(if stdin_data.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut cmd);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return (false, String::new(), format!("spawn git: {e}")),
    };
    if let Some(data) = stdin_data {
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(data);
            // stdin drops here, closing the pipe so git proceeds.
        }
    }
    match child.wait_with_output() {
        Ok(out) => (
            out.status.success(),
            String::from_utf8_lossy(&out.stdout).into_owned(),
            String::from_utf8_lossy(&out.stderr).into_owned(),
        ),
        Err(e) => (false, String::new(), format!("wait git: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn git_at(dir: &Path, args: &[&str]) {
        let status = Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_AUTHOR_NAME", "Test")
            .env("GIT_AUTHOR_EMAIL", "test@example.com")
            .env("GIT_COMMITTER_NAME", "Test")
            .env("GIT_COMMITTER_EMAIL", "test@example.com")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("spawn git");
        assert!(status.success(), "git {args:?} failed");
    }

    fn source_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        git_at(p, &["init", "-q", "-b", "main"]);
        git_at(p, &["config", "commit.gpgsign", "false"]);
        fs::write(p.join("a.txt"), "hello\n").unwrap();
        git_at(p, &["add", "-A"]);
        git_at(p, &["commit", "-q", "-m", "init"]);
        dir
    }

    #[test]
    fn clones_local_repo_end_to_end() {
        let src = source_repo();
        let parent = tempfile::tempdir().unwrap();
        let res = do_clone(
            OsString::from("git"),
            src.path().to_string_lossy().into_owned(),
            parent.path().to_string_lossy().into_owned(),
            "checkout".to_string(),
            ResolvedAuth::None,
            false,
            991001,
            |_p| {},
        );
        assert_eq!(res.status, "cloned", "message: {}", res.message);
        let dest = parent.path().join("checkout");
        assert!(dest.join(".git").exists(), "cloned repo has .git");
        assert!(dest.join("a.txt").exists(), "working tree checked out");
    }

    #[test]
    fn refuses_non_empty_destination() {
        let src = source_repo();
        let parent = tempfile::tempdir().unwrap();
        let dest = parent.path().join("taken");
        fs::create_dir(&dest).unwrap();
        fs::write(dest.join("keep.txt"), "x").unwrap();
        let res = do_clone(
            OsString::from("git"),
            src.path().to_string_lossy().into_owned(),
            parent.path().to_string_lossy().into_owned(),
            "taken".to_string(),
            ResolvedAuth::None,
            false,
            991002,
            |_p| {},
        );
        assert_eq!(res.status, "exists");
        // Cleanup only removes what we create — the user's file is untouched.
        assert!(dest.join("keep.txt").exists());
    }

    #[test]
    fn rejects_dir_name_that_escapes_parent() {
        let parent = tempfile::tempdir().unwrap();
        let res = do_clone(
            OsString::from("git"),
            "https://example.com/x.git".to_string(),
            parent.path().to_string_lossy().into_owned(),
            "../evil".to_string(),
            ResolvedAuth::None,
            false,
            991003,
            |_p| {},
        );
        assert_eq!(res.status, "error");
    }

    #[test]
    fn parses_progress_lines() {
        assert_eq!(
            parse_progress("Receiving objects:  45% (450/1000)"),
            Some(("Receiving objects".to_string(), 45))
        );
        assert_eq!(
            parse_progress("remote: Compressing objects: 100% (5/5)"),
            Some(("Compressing objects".to_string(), 100))
        );
        // No percent → not a progress line.
        assert_eq!(parse_progress("Cloning into 'repo'..."), None);
        assert_eq!(parse_progress("fatal: repository not found"), None);
    }

    #[test]
    fn classifies_auth_and_offline() {
        assert_eq!(
            classify_clone_stderr("remote: TF401019: access denied\nfatal: Authentication failed").0,
            "auth-failed"
        );
        assert_eq!(
            classify_clone_stderr("fatal: unable to access 'https://x': Could not resolve host: x").0,
            "offline"
        );
        assert_eq!(
            classify_clone_stderr("fatal: destination path exists and is not empty").0,
            "error"
        );
        // A scoped-out PAT: git says "unable to access ... returned error: 403".
        // The OFFLINE keyword "unable to access" is present, but auth must win.
        assert_eq!(
            classify_clone_stderr(
                "fatal: unable to access 'https://dev.azure.com/org/_git/repo/': The requested URL returned error: 403"
            )
            .0,
            "auth-failed"
        );
        assert_eq!(
            classify_clone_stderr(
                "fatal: unable to access 'https://host/repo/': The requested URL returned error: 401"
            )
            .0,
            "auth-failed"
        );
    }

    #[test]
    fn cleans_partial_clone_from_preexisting_empty_dir() {
        let parent = tempfile::tempdir().unwrap();
        let dest = parent.path().join("empty-target");
        fs::create_dir(&dest).unwrap();
        // A source that isn't a repo makes the clone fail after we've committed
        // to filling the (pre-existing, empty) destination.
        let bogus = parent.path().join("not-a-repo");
        fs::create_dir(&bogus).unwrap();
        let res = do_clone(
            OsString::from("git"),
            bogus.to_string_lossy().into_owned(),
            parent.path().to_string_lossy().into_owned(),
            "empty-target".to_string(),
            ResolvedAuth::None,
            false,
            991004,
            |_p| {},
        );
        assert_ne!(res.status, "cloned", "message: {}", res.message);
        // The partial tree — and the empty folder we took over — is gone, so a
        // retry into the same folder isn't blocked by a stale "exists".
        assert!(
            !dest.exists(),
            "partial clone should be removed even from a pre-existing empty dir"
        );
    }

    #[test]
    fn ado_url_full_path_for_credential_keying() {
        // With useHttpPath on, git queries the credential store by the full path,
        // so that's what we key dev.azure.com credentials by on persist.
        let u = Url::parse("https://dev.azure.com/myorg/MyProject/_git/myrepo").unwrap();
        assert_eq!(u.path().trim_start_matches('/'), "myorg/MyProject/_git/myrepo");
    }

    #[test]
    fn helper_reset_semantics() {
        // Trailing empty value clears the list.
        // (Unit-tests the pure last-writer logic via a stand-in.)
        let lines = "manager\n\n";
        let mut active = false;
        for l in lines.lines() {
            active = !l.trim().is_empty();
        }
        assert!(!active);
    }
}

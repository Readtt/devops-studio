//! Source-directory git *write* operations: branch switching and fast-forward
//! pull. The only place in the app that mutates the user's tree, and only ever
//! from an explicit user action in the status bar — never from the AI (its
//! command runner stays read-only) and never from a background poller.
//!
//! Kept apart from `git.rs` (which is strictly read-only) so the read/write
//! boundary is obvious. Reuses `git.rs`'s `pub(crate)` helpers.

use super::git::{
    current_branch, hide_console, is_our_parked_stash, is_repo, run_git, PARKED_STASH_MARKER,
};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// Run git capturing stdout, stderr, and success separately (unlike `run_git`,
/// which collapses a failure into an `Err(stderr)`). Needed for pull, where a
/// non-zero exit ("can't fast-forward") is an outcome we classify, not a crash.
/// `envs` lets us set `GIT_TERMINAL_PROMPT=0` so a fetch needing credentials
/// fails fast instead of blocking on an invisible prompt.
fn run_capture(cwd: &Path, args: &[&str], envs: &[(&str, &str)]) -> (bool, String, String) {
    let mut cmd = Command::new("git");
    cmd.args(args)
        .current_dir(cwd)
        // C locale so the pull-outcome classification below matches git's
        // English text on any system. (Mirrors run_git in git.rs.)
        .env("LC_ALL", "C")
        .env("LANG", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in envs {
        cmd.env(k, v);
    }
    hide_console(&mut cmd);
    match cmd.output() {
        Ok(out) => (
            out.status.success(),
            String::from_utf8_lossy(&out.stdout).into_owned(),
            String::from_utf8_lossy(&out.stderr).into_owned(),
        ),
        Err(e) => (false, String::new(), format!("spawn git: {e}")),
    }
}

fn working_tree_dirty(path: &Path) -> bool {
    run_git(path, &["status", "--porcelain"])
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
}

/// Whether git's (lowercased) stderr indicates a transport/credential failure —
/// i.e. we couldn't reach the remote — rather than a logical outcome like a
/// divergence. Shared by pull + fetch so the "couldn't reach the remote"
/// classification stays identical in both. Substring-based because git's text
/// is version-shaped; we force `LC_ALL=C`, so matching English is reliable.
fn is_offline_stderr(lower: &str) -> bool {
    [
        "could not resolve host",
        "unable to access",
        "could not read from remote",
        "connection", // refused / reset / closed
        "timed out",
        "no route to host",
        "network is unreachable",
        "terminal prompts disabled",
        "authentication failed",
        "permission denied",
    ]
    .iter()
    .any(|kw| lower.contains(kw))
}

/// Check out `branch`, doing the right thing whether it's local or remote-only:
///   - already a local branch → `git checkout <branch>`
///   - a remote-tracking ref like "origin/feature" with no local counterpart →
///     `git checkout -t origin/feature`, which creates a local branch tracking
///     that exact upstream and switches to it (explicit about WHICH remote, so
///     `origin/x` + `upstream/x` aren't ambiguous). If a local branch of that
///     name was created since the list rendered, fall back to a plain switch.
///   - anything else → a plain checkout (git's DWIM may still resolve it).
///
/// Returns the local branch name now intended, plus the git result.
fn perform_checkout(path: &Path, branch: &str) -> Result<(), String> {
    let local_exists = run_git(
        path,
        &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")],
    )
    .is_ok();
    if local_exists {
        return run_git(path, &["checkout", branch]).map(|_| ());
    }

    let is_remote_ref = run_git(
        path,
        &["rev-parse", "--verify", "--quiet", &format!("refs/remotes/{branch}")],
    )
    .is_ok();
    if is_remote_ref {
        match run_git(path, &["checkout", "-t", branch]) {
            Ok(_) => return Ok(()),
            Err(e) => {
                // Race: a local branch of that name now exists — just switch to it.
                let local = branch.split_once('/').map(|(_, r)| r).unwrap_or(branch);
                if e.to_lowercase().contains("already exists") {
                    return run_git(path, &["checkout", local]).map(|_| ());
                }
                return Err(e);
            }
        }
    }

    run_git(path, &["checkout", branch]).map(|_| ())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCheckoutResult {
    /// "switched" | "blocked" | "error".
    /// - switched: the checkout completed; `branch` is the new current branch.
    /// - blocked: carry-over checkout refused because local changes would be
    ///   overwritten — the UI re-prompts, offering to stash.
    /// - error: anything else (unknown branch, git failure).
    pub status: String,
    /// Current branch after the switch (the resolved local name).
    pub branch: Option<String>,
    /// True when we set the user's changes aside in a stash to make the switch.
    pub stashed: bool,
    pub message: String,
}

/// Switch the source directory to `branch`.
///
/// `mode`:
///   - "carry": plain checkout — git moves uncommitted edits onto the new
///     branch. Refused (status "blocked") when they'd conflict.
///   - "stash": stash uncommitted edits (incl. untracked) first, then switch.
///     The changes are parked in a stash, not popped, so the switch is clean
///     and nothing is lost. (A clean tree just switches.)
#[tauri::command]
pub async fn git_checkout(
    cwd: String,
    branch: String,
    mode: String,
) -> Result<GitCheckoutResult, String> {
    let path = PathBuf::from(&cwd);
    if !path.exists() {
        return Err(format!("path not found: {cwd}"));
    }
    tauri::async_runtime::spawn_blocking(move || do_checkout(&path, &branch, &mode))
        .await
        .map_err(|e| format!("git_checkout join: {e}"))?
}

fn do_checkout(path: &Path, branch: &str, mode: &str) -> Result<GitCheckoutResult, String> {
    if !is_repo(path) {
        return Err(format!("not a git repository: {}", path.display()));
    }

    let mut stashed = false;
    if mode == "stash" && working_tree_dirty(path) {
        match run_git(
            path,
            &["stash", "push", "--include-untracked", "-m", PARKED_STASH_MARKER],
        ) {
            Ok(out) => stashed = !out.contains("No local changes"),
            Err(e) => {
                return Ok(GitCheckoutResult {
                    status: "error".into(),
                    branch: current_branch(path),
                    stashed: false,
                    message: format!("Couldn't set your changes aside: {e}"),
                });
            }
        }
    }

    match perform_checkout(path, branch) {
        Ok(_) => Ok(GitCheckoutResult {
            status: "switched".into(),
            branch: current_branch(path),
            stashed,
            message: String::new(),
        }),
        Err(e) => {
            // If we stashed but the checkout still failed, restore the user's
            // work so a failed switch never strands it in the stash list. If the
            // restore ITSELF fails, don't lie about it — report that the work is
            // safe in a stash and how to recover it by hand.
            if stashed {
                if let Err(pop_err) = run_git(path, &["stash", "pop"]) {
                    return Ok(GitCheckoutResult {
                        status: "error".into(),
                        branch: current_branch(path),
                        stashed: true,
                        message: format!(
                            "Couldn't switch, and restoring your set-aside changes hit a snag: {}. \
                             Your changes are safe in a stash — run `git stash pop` to recover them.",
                            pop_err.trim()
                        ),
                    });
                }
            }
            let lower = e.to_lowercase();
            let blocked = lower.contains("would be overwritten")
                || lower.contains("overwritten by checkout")
                || lower.contains("local changes");
            Ok(GitCheckoutResult {
                status: if blocked { "blocked".into() } else { "error".into() },
                branch: current_branch(path),
                stashed: false,
                message: e,
            })
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitPullResult {
    /// "updated" | "up-to-date" | "no-upstream" | "diverged" | "local-changes"
    /// | "offline" | "error".
    /// - local-changes: a fast-forward would overwrite uncommitted edits, so git
    ///   refused and the tree is untouched — the user commits or stashes first.
    pub status: String,
    pub message: String,
}

/// Fast-forward the current branch from its upstream. Never merges or rebases:
/// if the branch and its upstream have diverged, returns "diverged" and leaves
/// the tree untouched so the user resolves it deliberately. Branches with no
/// upstream return "no-upstream" (nothing to pull).
#[tauri::command]
pub async fn git_pull(cwd: String) -> Result<GitPullResult, String> {
    let path = PathBuf::from(&cwd);
    if !path.exists() {
        return Err(format!("path not found: {cwd}"));
    }
    tauri::async_runtime::spawn_blocking(move || do_pull(&path))
        .await
        .map_err(|e| format!("git_pull join: {e}"))?
}

fn do_pull(path: &Path) -> Result<GitPullResult, String> {
    if !is_repo(path) {
        return Err(format!("not a git repository: {}", path.display()));
    }
    // No upstream → nothing to pull. `@{u}` errors when the branch tracks
    // nothing (or on a detached HEAD).
    if run_git(path, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).is_err() {
        return Ok(GitPullResult {
            status: "no-upstream".into(),
            message: "This branch isn't tracking a remote branch, so there's nothing to pull."
                .into(),
        });
    }

    let (ok, stdout, stderr) =
        run_capture(path, &["pull", "--ff-only"], &[("GIT_TERMINAL_PROMPT", "0")]);
    let combined = format!("{stdout}\n{stderr}");
    let lower = combined.to_lowercase();

    if ok {
        if lower.contains("already up to date") {
            return Ok(GitPullResult {
                status: "up-to-date".into(),
                message: "Already up to date.".into(),
            });
        }
        return Ok(GitPullResult {
            status: "updated".into(),
            message: summarize_pull(&stdout),
        });
    }

    let status = if lower.contains("overwritten by merge")
        || lower.contains("commit your changes or stash them")
    {
        // A fast-forward would clobber uncommitted edits; git aborted before
        // touching anything (the fetch already ran, but the tree is intact).
        "local-changes"
    } else if lower.contains("not possible to fast-forward")
        || lower.contains("diverging")
        || lower.contains("diverged")
        || lower.contains("reconcile")
    {
        "diverged"
    } else if is_offline_stderr(&lower) {
        "offline"
    } else {
        "error"
    };
    let message = match status {
        "local-changes" => {
            "You have uncommitted changes the update would overwrite. Commit or stash them, then pull."
                .into()
        }
        "diverged" => {
            "Your branch and its remote have diverged. Pull manually (merge or rebase) to reconcile."
                .into()
        }
        "offline" => "Couldn't reach the remote. Check your connection or credentials.".into(),
        _ => stderr.trim().to_string(),
    };
    Ok(GitPullResult {
        status: status.into(),
        message,
    })
}

/// Pull out git's "Fast-forward" / file-count summary line for the toast,
/// falling back to a generic message when the format isn't recognized.
fn summarize_pull(stdout: &str) -> String {
    for line in stdout.lines() {
        let t = line.trim();
        if t.contains("files changed") || t.contains("file changed") || t.contains("insertion") {
            return format!("Pulled latest changes — {t}");
        }
    }
    "Pulled the latest changes.".into()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFetchResult {
    /// "fetched" | "no-remote" | "offline" | "error".
    pub status: String,
    pub message: String,
}

/// Fetch all remotes (with --prune so server-deleted branches drop out of the
/// list) so newly-created remote branches show up in the switcher. Ref-only —
/// never touches local branches or the working tree. `GIT_TERMINAL_PROMPT=0`
/// makes a credential-needing fetch fail fast instead of hanging on a prompt.
#[tauri::command]
pub async fn git_fetch(cwd: String) -> Result<GitFetchResult, String> {
    let path = PathBuf::from(&cwd);
    if !path.exists() {
        return Err(format!("path not found: {cwd}"));
    }
    tauri::async_runtime::spawn_blocking(move || do_fetch(&path))
        .await
        .map_err(|e| format!("git_fetch join: {e}"))?
}

fn do_fetch(path: &Path) -> Result<GitFetchResult, String> {
    if !is_repo(path) {
        return Err(format!("not a git repository: {}", path.display()));
    }
    if run_git(path, &["remote"])
        .map(|s| s.trim().is_empty())
        .unwrap_or(true)
    {
        return Ok(GitFetchResult {
            status: "no-remote".into(),
            message: "This repository has no remotes to fetch from.".into(),
        });
    }

    let (ok, _stdout, stderr) =
        run_capture(path, &["fetch", "--all", "--prune"], &[("GIT_TERMINAL_PROMPT", "0")]);
    if ok {
        return Ok(GitFetchResult {
            status: "fetched".into(),
            message: "Branches updated from the remote.".into(),
        });
    }
    let lower = stderr.to_lowercase();
    if is_offline_stderr(&lower) {
        return Ok(GitFetchResult {
            status: "offline".into(),
            message: "Couldn't reach the remote. Check your connection or credentials.".into(),
        });
    }
    Ok(GitFetchResult {
        status: "error".into(),
        message: stderr.trim().to_string(),
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStashRestoreResult {
    /// "restored" | "conflict" | "none" | "error".
    /// - restored: applied cleanly and the stash was removed.
    /// - conflict: applied with conflicts; the stash is KEPT and the listed
    ///   files need resolving.
    /// - none: this branch has no parked changes.
    pub status: String,
    pub conflicted_files: Vec<String>,
    pub message: String,
}

/// Restore the changes we parked on the current branch. Uses apply-then-drop
/// (not pop) so a conflicted restore never destroys the only copy: we drop the
/// stash ONLY after a clean apply; on conflict git keeps it and we surface the
/// files to resolve.
#[tauri::command]
pub async fn git_stash_restore(cwd: String) -> Result<GitStashRestoreResult, String> {
    let path = PathBuf::from(&cwd);
    if !path.exists() {
        return Err(format!("path not found: {cwd}"));
    }
    tauri::async_runtime::spawn_blocking(move || do_stash_restore(&path))
        .await
        .map_err(|e| format!("git_stash_restore join: {e}"))?
}

fn do_stash_restore(path: &Path) -> Result<GitStashRestoreResult, String> {
    if !is_repo(path) {
        return Err(format!("not a git repository: {}", path.display()));
    }
    let Some(branch) = current_branch(path) else {
        return Ok(GitStashRestoreResult {
            status: "none".into(),
            conflicted_files: Vec::new(),
            message: "Detached HEAD — no branch to restore changes onto.".into(),
        });
    };

    // Find our most-recent parked stash for this branch. Re-resolve the
    // stash@{N} ref here (indices shift as stashes come and go) rather than
    // caching one.
    let prefix = format!("On {branch}: ");
    let list = run_git(path, &["stash", "list", "--format=%gd%x00%gs"]).unwrap_or_default();
    let stash_ref = list.lines().find_map(|line| {
        let mut it = line.split('\u{0}');
        let gd = it.next().unwrap_or("").trim();
        let gs = it.next().unwrap_or("");
        // Exact-match (via is_our_parked_stash) so we never apply+drop a stash
        // the user created by hand whose message merely contains the marker.
        if is_our_parked_stash(gs, &prefix) && !gd.is_empty() {
            Some(gd.to_string())
        } else {
            None
        }
    });
    let Some(stash_ref) = stash_ref else {
        return Ok(GitStashRestoreResult {
            status: "none".into(),
            conflicted_files: Vec::new(),
            message: "No parked changes for this branch.".into(),
        });
    };

    let (ok, _stdout, stderr) = run_capture(path, &["stash", "apply", &stash_ref], &[]);
    if ok {
        // Clean apply → safe to remove the stash entry now.
        let _ = run_git(path, &["stash", "drop", &stash_ref]);
        return Ok(GitStashRestoreResult {
            status: "restored".into(),
            conflicted_files: Vec::new(),
            message: "Restored the changes you left here.".into(),
        });
    }

    // Detect a conflict by the presence of UNMERGED paths, not by scraping the
    // message — git prints "CONFLICT" to stdout, and the text is locale-shaped.
    // A conflicting apply keeps the stash (git's contract), so the work is safe.
    let conflicted_files: Vec<String> = run_git(path, &["diff", "--name-only", "--diff-filter=U"])
        .unwrap_or_default()
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    if !conflicted_files.is_empty() {
        return Ok(GitStashRestoreResult {
            status: "conflict".into(),
            conflicted_files,
            message: "Your changes overlap this branch — resolve the conflicts. Your stash is kept until you do."
                .into(),
        });
    }

    Ok(GitStashRestoreResult {
        status: "error".into(),
        conflicted_files: Vec::new(),
        message: stderr.trim().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) {
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

    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        git(p, &["init", "-q", "-b", "main"]);
        git(p, &["config", "commit.gpgsign", "false"]);
        fs::write(p.join("a.txt"), "one\ntwo\n").unwrap();
        git(p, &["add", "-A"]);
        git(p, &["commit", "-q", "-m", "init"]);
        dir
    }

    /// Park changes the way do_checkout(mode="stash") does, so restore has
    /// something of ours to find.
    fn park(p: &Path) {
        git(
            p,
            &["stash", "push", "--include-untracked", "-m", PARKED_STASH_MARKER],
        );
    }

    #[test]
    fn restore_clean_applies_and_drops() {
        let repo = repo();
        let p = repo.path();
        fs::write(p.join("a.txt"), "one\ntwo\nwip\n").unwrap();
        fs::write(p.join("new.txt"), "fresh\n").unwrap();
        park(p);
        // Tree is clean after parking.
        assert!(!working_tree_dirty(p));

        let res = do_stash_restore(p).unwrap();
        assert_eq!(res.status, "restored");
        // Files came back and the stash was dropped. (Don't assert exact line
        // endings — git may normalize to CRLF on Windows.)
        assert!(fs::read_to_string(p.join("a.txt")).unwrap().contains("wip"));
        assert!(p.join("new.txt").exists());
        let list = run_git(p, &["stash", "list"]).unwrap();
        assert!(list.trim().is_empty(), "stash should be dropped after clean apply");
    }

    #[test]
    fn restore_none_when_nothing_parked() {
        let repo = repo();
        let res = do_stash_restore(repo.path()).unwrap();
        assert_eq!(res.status, "none");
    }

    #[test]
    fn restore_conflict_keeps_stash_and_lists_files() {
        let repo = repo();
        let p = repo.path();
        // Park an edit to a.txt, then move the same lines on the branch so the
        // restore can't apply cleanly.
        fs::write(p.join("a.txt"), "one\ntwo\nMINE\n").unwrap();
        park(p);
        fs::write(p.join("a.txt"), "one\ntwo\nTHEIRS\n").unwrap();
        git(p, &["commit", "-qam", "branch moved"]);

        let res = do_stash_restore(p).unwrap();
        assert_eq!(res.status, "conflict");
        assert!(res.conflicted_files.iter().any(|f| f == "a.txt"));
        // The stash is preserved so the work is never lost.
        let list = run_git(p, &["stash", "list"]).unwrap();
        assert!(list.contains(PARKED_STASH_MARKER), "stash kept on conflict");
    }

    #[test]
    fn restore_ignores_a_foreign_stash() {
        let repo = repo();
        let p = repo.path();
        // A manual (non-ours) stash must not be treated as parked.
        fs::write(p.join("a.txt"), "one\ntwo\nmanual\n").unwrap();
        git(p, &["stash", "push", "-m", "my own stash"]);
        let res = do_stash_restore(p).unwrap();
        assert_eq!(res.status, "none");
        // The foreign stash is untouched.
        let list = run_git(p, &["stash", "list"]).unwrap();
        assert!(list.contains("my own stash"));
    }

    #[test]
    fn offline_stderr_classifier_recognizes_common_transport_failures() {
        for s in [
            "fatal: could not resolve host: github.com",
            "fatal: unable to access 'https://x/': Could not resolve host",
            "fatal: Could not read from remote repository.",
            "ssh: connect to host x port 22: Connection refused",
            "ssh: connect to host x port 22: No route to host",
            "fatal: unable to access '...': ... Network is unreachable",
            "remote: Permission denied",
            "fatal: Authentication failed for 'https://x/'",
        ] {
            assert!(is_offline_stderr(&s.to_lowercase()), "should be offline: {s}");
        }
        // A logical divergence is NOT a transport failure.
        assert!(!is_offline_stderr("fatal: not possible to fast-forward, aborting."));
        assert!(!is_offline_stderr(""));
    }

    #[test]
    fn checkout_switches_between_local_branches() {
        let repo = repo();
        let p = repo.path();
        git(p, &["branch", "feature"]);
        let res = do_checkout(p, "feature", "carry").unwrap();
        assert_eq!(res.status, "switched");
        assert_eq!(res.branch.as_deref(), Some("feature"));
        assert!(!res.stashed);
    }

    #[test]
    fn checkout_stash_parks_dirty_tree_then_switches_clean() {
        let repo = repo();
        let p = repo.path();
        git(p, &["branch", "feature"]);
        fs::write(p.join("a.txt"), "one\ntwo\nwip\n").unwrap();
        fs::write(p.join("new.txt"), "fresh\n").unwrap();
        assert!(working_tree_dirty(p));

        let res = do_checkout(p, "feature", "stash").unwrap();
        assert_eq!(res.status, "switched");
        assert_eq!(res.branch.as_deref(), Some("feature"));
        assert!(res.stashed, "a dirty tree is parked");
        // The target branch opens clean and our changes are parked on `main`.
        assert!(!working_tree_dirty(p));
        let list = run_git(p, &["stash", "list"]).unwrap();
        assert!(list.contains(PARKED_STASH_MARKER), "changes parked");
    }

    #[test]
    fn checkout_stash_recovers_changes_when_switch_fails() {
        // The highest-stakes path: we stashed, but the checkout then failed.
        // do_checkout must pop the stash back so uncommitted work is never
        // stranded.
        let repo = repo();
        let p = repo.path();
        fs::write(p.join("a.txt"), "one\ntwo\nwip\n").unwrap();
        assert!(working_tree_dirty(p));

        let res = do_checkout(p, "does-not-exist", "stash").unwrap();
        assert_eq!(res.status, "error");
        assert!(!res.stashed, "the stash was popped back, not left set aside");
        // The edits are back in the working tree...
        assert!(working_tree_dirty(p));
        assert!(fs::read_to_string(p.join("a.txt")).unwrap().contains("wip"));
        // ...and nothing was left stranded in the stash list.
        let list = run_git(p, &["stash", "list"]).unwrap();
        assert!(!list.contains(PARKED_STASH_MARKER), "nothing stranded");
    }

    #[test]
    fn checkout_carry_blocked_on_conflicting_changes() {
        // A carry checkout that git refuses ("would be overwritten") must come
        // back as "blocked" so the UI can offer to stash instead.
        let repo = repo();
        let p = repo.path();
        git(p, &["checkout", "-qb", "feature"]);
        fs::write(p.join("a.txt"), "one\ntwo\nFEATURE\n").unwrap();
        git(p, &["commit", "-qam", "feature edit"]);
        git(p, &["checkout", "-q", "main"]);
        // Uncommitted edit to the same file that differs on the target branch.
        fs::write(p.join("a.txt"), "one\ntwo\nMINE\n").unwrap();

        let res = do_checkout(p, "feature", "carry").unwrap();
        assert_eq!(res.status, "blocked");
        // We never moved, and the edit is intact.
        assert_eq!(res.branch.as_deref(), Some("main"));
        assert!(fs::read_to_string(p.join("a.txt")).unwrap().contains("MINE"));
    }

    /// A local repo with a bare `origin` it tracks (main pushed + upstream set).
    fn repo_with_upstream() -> (tempfile::TempDir, tempfile::TempDir) {
        let remote = tempfile::tempdir().unwrap();
        git(remote.path(), &["init", "-q", "--bare", "-b", "main"]);
        let local = repo();
        let p = local.path();
        git(p, &["remote", "add", "origin", remote.path().to_str().unwrap()]);
        git(p, &["push", "-q", "-u", "origin", "main"]);
        (local, remote)
    }

    /// Clone `remote`, run `edit` to advance it, and push back to origin/main.
    fn advance_remote(remote: &Path, edit: impl FnOnce(&Path)) {
        let other = tempfile::tempdir().unwrap();
        git(other.path(), &["clone", "-q", remote.to_str().unwrap(), "."]);
        git(other.path(), &["config", "commit.gpgsign", "false"]);
        edit(other.path());
        git(other.path(), &["push", "-q", "origin", "main"]);
    }

    #[test]
    fn pull_no_upstream_when_branch_tracks_nothing() {
        let repo = repo();
        let res = do_pull(repo.path()).unwrap();
        assert_eq!(res.status, "no-upstream");
    }

    #[test]
    fn pull_up_to_date_right_after_push() {
        let (local, _remote) = repo_with_upstream();
        let res = do_pull(local.path()).unwrap();
        assert_eq!(res.status, "up-to-date");
    }

    #[test]
    fn pull_fast_forwards_when_remote_advances() {
        let (local, remote) = repo_with_upstream();
        advance_remote(remote.path(), |o| {
            fs::write(o.join("r.txt"), "remote\n").unwrap();
            git(o, &["add", "r.txt"]);
            git(o, &["commit", "-qm", "remote commit"]);
        });
        let res = do_pull(local.path()).unwrap();
        assert_eq!(res.status, "updated");
        assert!(local.path().join("r.txt").exists(), "fast-forwarded in");
    }

    #[test]
    fn pull_diverged_leaves_local_tree_untouched() {
        let (local, remote) = repo_with_upstream();
        let p = local.path();
        // A local commit that isn't pushed.
        fs::write(p.join("a.txt"), "one\ntwo\nlocal\n").unwrap();
        git(p, &["commit", "-qam", "local commit"]);
        // The remote moves a different way on the same branch.
        advance_remote(remote.path(), |o| {
            fs::write(o.join("a.txt"), "one\ntwo\nremote\n").unwrap();
            git(o, &["commit", "-qam", "remote commit"]);
        });
        let res = do_pull(p).unwrap();
        assert_eq!(res.status, "diverged");
        // Nothing was merged or rebased — our local commit is intact.
        assert!(fs::read_to_string(p.join("a.txt")).unwrap().contains("local"));
    }

    #[test]
    fn pull_refuses_when_local_changes_would_be_overwritten() {
        // On a tracking branch that's behind, an uncommitted edit to a file the
        // fast-forward would touch makes git refuse. We classify that as
        // "local-changes" (not a generic error) and leave the edit intact.
        let (local, remote) = repo_with_upstream();
        let p = local.path();
        advance_remote(remote.path(), |o| {
            fs::write(o.join("a.txt"), "one\ntwo\nremote\n").unwrap();
            git(o, &["commit", "-qam", "remote edit"]);
        });
        git(p, &["fetch", "-q", "origin"]);
        // Uncommitted local edit to the same file the FF would update.
        fs::write(p.join("a.txt"), "one\ntwo\nmine\n").unwrap();

        let res = do_pull(p).unwrap();
        assert_eq!(res.status, "local-changes");
        // The working tree is untouched — our edit survives.
        assert!(fs::read_to_string(p.join("a.txt")).unwrap().contains("mine"));
    }

    #[test]
    fn fetch_no_remote_on_bare_local_repo() {
        let repo = repo();
        let res = do_fetch(repo.path()).unwrap();
        assert_eq!(res.status, "no-remote");
    }

    #[test]
    fn checkout_remote_only_creates_tracking_branch() {
        let (local, remote) = repo_with_upstream();
        let p = local.path();
        // Make `feature` exist only on the remote.
        git(p, &["checkout", "-qb", "feature"]);
        git(p, &["push", "-q", "origin", "feature"]);
        git(p, &["checkout", "-q", "main"]);
        git(p, &["branch", "-qD", "feature"]);
        git(p, &["fetch", "-q", "origin"]);
        let _ = remote; // kept alive for the duration of the test

        // Switching to the remote ref creates a local branch that tracks it.
        let res = do_checkout(p, "origin/feature", "carry").unwrap();
        assert_eq!(res.status, "switched");
        assert_eq!(res.branch.as_deref(), Some("feature"));
        let upstream = run_git(p, &["rev-parse", "--abbrev-ref", "feature@{u}"]).unwrap();
        assert_eq!(upstream.trim(), "origin/feature");
    }
}

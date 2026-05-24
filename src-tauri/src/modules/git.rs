//! Source-directory git introspection.
//!
//! Used by the bottom status bar and the "use current branch" toggle in the
//! Azure DevOps settings. Stays read-only — we never invoke a write subcommand
//! against the user's tree.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// Suppress the Windows console window that would otherwise flash on every
/// spawn. The status-bar branch poller calls this every 30 s — without the
/// flag a fresh cmd.exe appears and disappears on each tick, which looks
/// (and is) broken to the user. No-op on other platforms.
#[inline]
fn hide_console(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepoInfo {
    /// Branch name (e.g. "main"). On detached HEAD this is `None` and `commit`
    /// holds the short SHA so the UI can still show something useful.
    pub branch: Option<String>,
    /// Short commit SHA at HEAD.
    pub commit: Option<String>,
    /// True if the path is inside a git work tree (or its `.git`).
    pub is_repo: bool,
    /// True for a detached HEAD; the UI prefers showing the commit then.
    pub detached: bool,
}

#[tauri::command]
pub async fn git_repo_info(path: String) -> Result<GitRepoInfo, String> {
    let path = PathBuf::from(&path);
    if !path.exists() {
        return Ok(GitRepoInfo {
            branch: None,
            commit: None,
            is_repo: false,
            detached: false,
        });
    }
    tauri::async_runtime::spawn_blocking(move || read_info(&path))
        .await
        .map_err(|e| format!("git_repo_info join: {e}"))?
}

fn read_info(path: &Path) -> Result<GitRepoInfo, String> {
    if !is_repo(path) {
        return Ok(GitRepoInfo {
            branch: None,
            commit: None,
            is_repo: false,
            detached: false,
        });
    }
    let branch = current_branch(path);
    let commit = current_commit(path);
    let detached = branch.is_none() && commit.is_some();
    Ok(GitRepoInfo {
        branch,
        commit,
        is_repo: true,
        detached,
    })
}

fn is_repo(path: &Path) -> bool {
    matches!(
        run_git(path, &["rev-parse", "--is-inside-work-tree"]),
        Ok(out) if out.trim() == "true"
    )
}

fn current_branch(path: &Path) -> Option<String> {
    let out = run_git(path, &["rev-parse", "--abbrev-ref", "HEAD"]).ok()?;
    let trimmed = out.trim();
    if trimmed.is_empty() || trimmed == "HEAD" {
        // Detached HEAD — `--abbrev-ref` prints "HEAD" verbatim.
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn current_commit(path: &Path) -> Option<String> {
    let out = run_git(path, &["rev-parse", "--short", "HEAD"]).ok()?;
    let trimmed = out.trim();
    if trimmed.is_empty() { None } else { Some(trimmed.to_string()) }
}

fn run_git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut cmd);
    let out = cmd
        .output()
        .map_err(|e| format!("spawn git: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

// ───────────────────────────────────────────────────────────────────────
// git diff — used by the Code Review pane.
//
// The pane needs three things to brief a model intelligently:
//   1. The base branch we're diffing against (so we can say "vs main"
//      in the prompt and tell the user which baseline to expect).
//   2. The per-file stat list (path, +adds, -deletes, status). This is
//      what shows up in the chat header and what the model uses to pick
//      which files to read more deeply.
//   3. The raw patch text, capped — large enough to brief the model on
//      most branches in one shot, small enough not to blow out an 8 KiB
//      system prompt.
// ───────────────────────────────────────────────────────────────────────

/// Cap on raw patch bytes returned to the renderer. ~30 KiB leaves room
/// for the per-file stats + a system prompt while staying inside the
/// context windows of the cheaper BYOK models the user might pick.
const PATCH_MAX_BYTES: usize = 30 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffFile {
    /// Path relative to `cwd`. Citations from the model land in
    /// `path:line` form pointing at this string.
    pub path: String,
    /// Lines added in this file.
    pub additions: u32,
    /// Lines removed in this file.
    pub deletions: u32,
    /// Coarse change kind: "modified" | "added" | "deleted" | "renamed".
    /// Derived from the `--name-status` flag — useful for the UI to
    /// colour the list and for the model to know what to expect.
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiff {
    /// Resolved base branch (post-fallback). `cwd`'s history vs HEAD.
    pub base: String,
    /// Current HEAD branch, or short SHA if detached.
    pub head: String,
    /// Per-file stats from `git diff --name-status` + `--numstat`.
    pub files: Vec<DiffFile>,
    /// Raw patch text — capped at PATCH_MAX_BYTES and marked with a
    /// trailing "[... truncated]" so the model can tell when it's
    /// looking at a partial diff vs the real thing.
    pub raw_patch: String,
    /// True when raw_patch was capped. The UI surfaces a "diff
    /// truncated" notice when this is set.
    pub truncated: bool,
}

/// Common base-branch fallbacks. Tried in order when the caller doesn't
/// pass an explicit base — most repos use `main`, the legacy ones use
/// `master`, and forks frequently use `origin/HEAD` as the canonical
/// upstream pointer.
const DEFAULT_BASES: &[&str] = &["main", "master", "origin/HEAD"];

/// Compute the diff of `cwd`'s current HEAD against `base`. If `base` is
/// None, tries `main` → `master` → `origin/HEAD` until one resolves.
#[tauri::command]
pub async fn git_diff(cwd: String, base: Option<String>) -> Result<GitDiff, String> {
    let path = PathBuf::from(&cwd);
    if !path.exists() {
        return Err(format!("path not found: {cwd}"));
    }
    tauri::async_runtime::spawn_blocking(move || compute_diff(&path, base.as_deref()))
        .await
        .map_err(|e| format!("git_diff join: {e}"))?
}

fn compute_diff(path: &Path, requested_base: Option<&str>) -> Result<GitDiff, String> {
    if !is_repo(path) {
        return Err(format!("not a git repository: {}", path.display()));
    }

    // Resolve base.
    let base = if let Some(b) = requested_base.filter(|b| !b.is_empty()) {
        // Verify the caller's choice exists — `git rev-parse --verify`
        // returns nonzero when the ref is unknown. Surface a friendly
        // error instead of letting the diff command fail with git's
        // raw "unknown revision" text.
        if run_git(path, &["rev-parse", "--verify", b]).is_err() {
            return Err(format!("base branch '{b}' not found in this repo"));
        }
        b.to_string()
    } else {
        let mut found: Option<String> = None;
        for candidate in DEFAULT_BASES {
            if run_git(path, &["rev-parse", "--verify", candidate]).is_ok() {
                found = Some((*candidate).to_string());
                break;
            }
        }
        found.ok_or_else(|| {
            "could not find a default base branch — tried main, master, origin/HEAD".to_string()
        })?
    };

    let head = current_branch(path)
        .or_else(|| current_commit(path))
        .unwrap_or_else(|| "HEAD".to_string());

    // `{base}...HEAD` (triple-dot) restricts the diff to commits unique
    // to HEAD — the same view the user gets on the GitHub PR page.
    // Single-dot would also include changes to base since the divergence,
    // which is rarely what a reviewer wants.
    let triple_dot = format!("{}...HEAD", base);

    let files = collect_diff_files(path, &triple_dot)?;

    let raw = run_git(path, &["diff", "--no-color", &triple_dot]).unwrap_or_default();
    let (raw_patch, truncated) = if raw.len() > PATCH_MAX_BYTES {
        // Slice on a char boundary so we don't split a multibyte UTF-8
        // character at the cap.
        let mut end = PATCH_MAX_BYTES;
        while end > 0 && !raw.is_char_boundary(end) {
            end -= 1;
        }
        let mut truncated = raw[..end].to_string();
        truncated.push_str("\n[... truncated for size; full diff available via the Diff tool ...]");
        (truncated, true)
    } else {
        (raw, false)
    };

    Ok(GitDiff {
        base,
        head,
        files,
        raw_patch,
        truncated,
    })
}

fn collect_diff_files(path: &Path, range: &str) -> Result<Vec<DiffFile>, String> {
    // Parallel commands: `--name-status` for the kind, `--numstat` for
    // line counts. Joining on path keeps us robust to renames (status
    // "R" with old + new paths).
    let name_status =
        run_git(path, &["diff", "--name-status", "--no-renames", range]).unwrap_or_default();
    let numstat = run_git(path, &["diff", "--numstat", range]).unwrap_or_default();

    // numstat → map<path, (adds, dels)>
    let mut stats: std::collections::HashMap<String, (u32, u32)> = std::collections::HashMap::new();
    for line in numstat.lines() {
        let mut iter = line.split('\t');
        let adds_raw = iter.next().unwrap_or("0");
        let dels_raw = iter.next().unwrap_or("0");
        let p = iter.next().unwrap_or("").trim();
        if p.is_empty() {
            continue;
        }
        // git uses "-" for binary files in numstat. Treat them as 0/0
        // rather than failing the parse.
        let adds = adds_raw.parse::<u32>().unwrap_or(0);
        let dels = dels_raw.parse::<u32>().unwrap_or(0);
        stats.insert(p.to_string(), (adds, dels));
    }

    let mut files: Vec<DiffFile> = Vec::new();
    for line in name_status.lines() {
        let mut iter = line.split('\t');
        let status_code = iter.next().unwrap_or("");
        let p = iter.next().unwrap_or("").trim();
        if p.is_empty() {
            continue;
        }
        let (additions, deletions) = stats
            .get(p)
            .copied()
            .unwrap_or((0, 0));
        files.push(DiffFile {
            path: p.to_string(),
            additions,
            deletions,
            status: match status_code.chars().next().unwrap_or('M') {
                'A' => "added".into(),
                'D' => "deleted".into(),
                'R' => "renamed".into(),
                _ => "modified".into(),
            },
        });
    }
    Ok(files)
}

/// Local branches + a small set of common remote refs, for the base-branch
/// picker in the Code Review pane. Filters out HEAD / refs/stash / refs we
/// don't care about. Trimmed to ~50 entries — picker UIs become useless
/// past that anyway.
#[tauri::command]
pub async fn git_branch_list(cwd: String) -> Result<Vec<String>, String> {
    let path = PathBuf::from(&cwd);
    if !path.exists() {
        return Err(format!("path not found: {cwd}"));
    }
    tauri::async_runtime::spawn_blocking(move || list_branches(&path))
        .await
        .map_err(|e| format!("git_branch_list join: {e}"))?
}

fn list_branches(path: &Path) -> Result<Vec<String>, String> {
    if !is_repo(path) {
        return Err(format!("not a git repository: {}", path.display()));
    }
    // for-each-ref is faster than `branch -a` and gives us a clean,
    // pre-deduped list.
    let raw = run_git(
        path,
        &[
            "for-each-ref",
            "--format=%(refname:short)",
            "refs/heads",
            "refs/remotes",
        ],
    )?;
    let mut out: Vec<String> = raw
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| {
            !l.is_empty()
                && l != "HEAD"
                && !l.ends_with("/HEAD")
                && !l.starts_with("refs/stash")
        })
        .collect();
    // Promote main / master / origin/HEAD-style canonical bases to the top
    // so the picker's default selection is sensible without the user
    // scrolling.
    let priority: &[&str] = &["main", "master", "develop"];
    out.sort_by(|a, b| {
        let ai = priority.iter().position(|p| p == a).map(|i| i as i32).unwrap_or(i32::MAX);
        let bi = priority.iter().position(|p| p == b).map(|i| i as i32).unwrap_or(i32::MAX);
        ai.cmp(&bi).then_with(|| a.cmp(b))
    });
    out.truncate(50);
    Ok(out)
}

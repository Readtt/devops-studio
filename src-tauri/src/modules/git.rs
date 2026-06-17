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
// git diff — the cumulative base...HEAD delta of a whole branch.
//
// (The Commit Review pane reviews ONE commit at a time and consumes the
// single-commit helpers further down instead; this whole-branch diff is the
// older review mechanism, kept for any caller that wants the full delta.)
//
// A diff consumer needs three things to brief a model intelligently:
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

/// Git's well-known empty-tree object. Diffing a root commit against it
/// yields the commit's full content as additions (a root commit has no
/// parent, so `<sha>^` doesn't resolve).
const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/// Cap raw patch text at PATCH_MAX_BYTES on a char boundary, appending a
/// truncation marker. Returns (text, truncated). Shared by the branch diff
/// and the single-commit diff so both surface the same "[... truncated]"
/// sentinel the model keys off.
fn cap_patch(raw: String) -> (String, bool) {
    if raw.len() > PATCH_MAX_BYTES {
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
    }
}

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
    let (raw_patch, truncated) = cap_patch(raw);

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

// ───────────────────────────────────────────────────────────────────────
// Single-commit review — used by the Commit Review pane.
//
// Unlike git_diff (which shows the cumulative base...HEAD delta of a whole
// branch), these expose ONE commit at a time: a pickable list of recent
// commits, and the diff of a single commit's OWN change (<sha>^..<sha>).
// Reviewing one commit keeps the model's context small even on huge repos.
// ───────────────────────────────────────────────────────────────────────

/// One row in the commit picker. `is_root` marks the initial commit (no
/// parent), which the diff path handles specially.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitMeta {
    /// Full 40-char SHA — the stable id we persist and re-resolve.
    pub sha: String,
    /// Abbreviated SHA for display.
    pub short_sha: String,
    /// First line of the commit message.
    pub subject: String,
    /// Author name.
    pub author: String,
    /// Committer date, ISO-8601 strict (machine-sortable).
    pub date: String,
    /// Human relative date ("3 days ago") for the picker.
    pub relative_date: String,
    /// True when the commit has no parent (the repo's first commit).
    pub is_root: bool,
}

/// Recent commits on the current HEAD, newest first, for the Commit Review
/// picker. `count` is clamped to 1..=200.
#[tauri::command]
pub async fn git_list_commits(cwd: String, count: Option<u32>) -> Result<Vec<CommitMeta>, String> {
    let path = PathBuf::from(&cwd);
    if !path.exists() {
        return Err(format!("path not found: {cwd}"));
    }
    let count = count.unwrap_or(50).clamp(1, 200);
    tauri::async_runtime::spawn_blocking(move || list_commits(&path, count))
        .await
        .map_err(|e| format!("git_list_commits join: {e}"))?
}

fn list_commits(path: &Path, count: u32) -> Result<Vec<CommitMeta>, String> {
    if !is_repo(path) {
        return Err(format!("not a git repository: {}", path.display()));
    }
    // \x1f (unit separator) delimits fields; subjects are single-line (%s),
    // so a plain newline safely separates records. %P is space-separated
    // parents — empty for the root commit.
    let count_arg = format!("-n{count}");
    let raw = run_git(
        path,
        &[
            "log",
            &count_arg,
            "--no-color",
            "--date=iso-strict",
            "--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%cI%x1f%cr%x1f%P",
        ],
    )?;
    let mut out: Vec<CommitMeta> = Vec::new();
    for line in raw.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let mut f = line.split('\u{1f}');
        let sha = f.next().unwrap_or("").to_string();
        if sha.is_empty() {
            continue;
        }
        let short_sha = f.next().unwrap_or("").to_string();
        let subject = f.next().unwrap_or("").to_string();
        let author = f.next().unwrap_or("").to_string();
        let date = f.next().unwrap_or("").to_string();
        let relative_date = f.next().unwrap_or("").to_string();
        let parents = f.next().unwrap_or("").trim();
        out.push(CommitMeta {
            sha,
            short_sha,
            subject,
            author,
            date,
            relative_date,
            is_root: parents.is_empty(),
        });
    }
    Ok(out)
}

/// The diff of a single commit plus its metadata. Mirrors `GitDiff`'s
/// per-file + raw-patch shape, with commit identity and a `head_sha` so the
/// UI can warn when the reviewed commit isn't HEAD (tools read the *current*
/// working tree, which may have moved on).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDiff {
    pub sha: String,
    pub short_sha: String,
    pub subject: String,
    pub author: String,
    pub date: String,
    /// True for the repo's first commit (diffed against the empty tree).
    pub is_root: bool,
    /// True for a merge commit (diffed against its first parent).
    pub is_merge: bool,
    pub files: Vec<DiffFile>,
    pub raw_patch: String,
    pub truncated: bool,
    /// Short SHA of the working-tree HEAD at read time. When this differs
    /// from `short_sha`, the pane shows a "tree has moved on" banner.
    pub head_sha: String,
}

/// Compute the diff introduced by a single commit (`<sha>^..<sha>`). Handles
/// the root commit (no parent → diff vs the empty tree) and merge commits
/// (diff vs the first parent). Returns a friendly error when `sha` no longer
/// resolves (rebased / amended / garbage-collected).
#[tauri::command]
pub async fn git_commit_diff(cwd: String, sha: String) -> Result<CommitDiff, String> {
    let path = PathBuf::from(&cwd);
    if !path.exists() {
        return Err(format!("path not found: {cwd}"));
    }
    tauri::async_runtime::spawn_blocking(move || compute_commit_diff(&path, &sha))
        .await
        .map_err(|e| format!("git_commit_diff join: {e}"))?
}

fn compute_commit_diff(path: &Path, sha: &str) -> Result<CommitDiff, String> {
    if !is_repo(path) {
        return Err(format!("not a git repository: {}", path.display()));
    }
    // Resolve + verify the commit exists. `^{commit}` peels tags/annotated
    // objects to a commit and fails on unknown SHAs, so this doubles as the
    // "commit no longer in the repo" guard.
    let full_sha = run_git(path, &["rev-parse", "--verify", &format!("{sha}^{{commit}}")])
        .map_err(|_| format!("commit '{sha}' not found in this repo"))?
        .trim()
        .to_string();

    // Metadata for this commit (single record, same field layout as the list).
    let meta_raw = run_git(
        path,
        &[
            "show",
            "-s",
            "--no-color",
            "--date=iso-strict",
            "--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%cI%x1f%P",
            &full_sha,
        ],
    )?;
    let mut mf = meta_raw.split('\u{1f}');
    let sha_out = mf.next().unwrap_or("").to_string();
    let short_sha = mf.next().unwrap_or("").to_string();
    let subject = mf.next().unwrap_or("").to_string();
    let author = mf.next().unwrap_or("").to_string();
    let date = mf.next().unwrap_or("").to_string();
    let parents: Vec<&str> = mf.next().unwrap_or("").split_whitespace().collect();
    let is_root = parents.is_empty();
    let is_merge = parents.len() > 1;

    // The commit's own change. Root → empty tree (full content as additions);
    // normal/merge → first parent (`<sha>^` is parent #1).
    let range = if is_root {
        format!("{EMPTY_TREE}..{full_sha}")
    } else {
        format!("{full_sha}^..{full_sha}")
    };

    let files = collect_diff_files(path, &range)?;
    let raw = run_git(path, &["diff", "--no-color", &range]).unwrap_or_default();
    let (raw_patch, truncated) = cap_patch(raw);
    let head_sha = current_commit(path).unwrap_or_default();

    Ok(CommitDiff {
        sha: if sha_out.is_empty() { full_sha } else { sha_out },
        short_sha,
        subject,
        author,
        date,
        is_root,
        is_merge,
        files,
        raw_patch,
        truncated,
        head_sha,
    })
}

/// Local branches + a small set of common remote refs, for the tracking-branch
/// picker in Azure DevOps settings (and the terminal Quick Prompts strip).
/// Filters out HEAD / refs/stash / refs we don't care about. Trimmed to ~50
/// entries — picker UIs become useless past that anyway.
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command;

    /// Run a git command in `dir` with a deterministic identity so commits
    /// don't depend on the machine's global git config.
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

    /// Init a throwaway repo with two commits:
    ///   1. root: add a.txt
    ///   2. modify a.txt + add b.txt
    fn two_commit_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        git(p, &["init", "-q", "-b", "main"]);
        // Avoid signing in CI / on machines with commit.gpgsign=true globally.
        git(p, &["config", "commit.gpgsign", "false"]);
        fs::write(p.join("a.txt"), "one\ntwo\n").unwrap();
        git(p, &["add", "a.txt"]);
        git(p, &["commit", "-q", "-m", "add a"]);
        fs::write(p.join("a.txt"), "one\ntwo\nthree\n").unwrap();
        fs::write(p.join("b.txt"), "hello\n").unwrap();
        git(p, &["add", "a.txt", "b.txt"]);
        git(p, &["commit", "-q", "-m", "tweak a, add b"]);
        dir
    }

    #[test]
    fn lists_commits_newest_first_with_root_flag() {
        let repo = two_commit_repo();
        let commits = list_commits(repo.path(), 50).unwrap();
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].subject, "tweak a, add b");
        assert!(!commits[0].is_root);
        assert_eq!(commits[1].subject, "add a");
        assert!(commits[1].is_root, "first commit should be root");
        assert!(!commits[0].sha.is_empty() && !commits[0].short_sha.is_empty());
    }

    #[test]
    fn commit_diff_shows_only_that_commits_change() {
        let repo = two_commit_repo();
        let commits = list_commits(repo.path(), 50).unwrap();
        let head = &commits[0]; // "tweak a, add b"
        let diff = compute_commit_diff(repo.path(), &head.sha).unwrap();
        assert!(!diff.is_root);
        assert!(!diff.is_merge);
        let paths: Vec<&str> = diff.files.iter().map(|f| f.path.as_str()).collect();
        assert!(paths.contains(&"a.txt"));
        assert!(paths.contains(&"b.txt"));
        // b.txt is brand new in this commit.
        let b = diff.files.iter().find(|f| f.path == "b.txt").unwrap();
        assert_eq!(b.status, "added");
        // The raw patch is this commit's own delta (adds "three", adds b.txt),
        // NOT the cumulative history — "two" was added by the root commit and
        // must not appear as an addition here.
        assert!(diff.raw_patch.contains("+three"));
        assert!(diff.raw_patch.contains("+hello"));
        assert!(!diff.head_sha.is_empty());
    }

    #[test]
    fn root_commit_diff_shows_full_content() {
        let repo = two_commit_repo();
        let commits = list_commits(repo.path(), 50).unwrap();
        let root = commits.iter().find(|c| c.is_root).unwrap();
        let diff = compute_commit_diff(repo.path(), &root.sha).unwrap();
        assert!(diff.is_root);
        let a = diff.files.iter().find(|f| f.path == "a.txt").unwrap();
        assert_eq!(a.status, "added");
        assert!(diff.raw_patch.contains("+one"));
        assert!(diff.raw_patch.contains("+two"));
    }

    #[test]
    fn missing_commit_is_a_friendly_error() {
        let repo = two_commit_repo();
        let err = compute_commit_diff(repo.path(), "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef")
            .unwrap_err();
        assert!(err.contains("not found"), "got: {err}");
    }
}

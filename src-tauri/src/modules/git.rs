//! Source-directory git introspection.
//!
//! Used by the bottom status bar, the Commit Review pane, and the Azure DevOps
//! settings. Everything in THIS file is read-only — we never invoke a write
//! subcommand against the user's tree. Branch switching / pulling (the only
//! write operations the app performs) live in the sibling `git_ops` module,
//! which reuses the `pub(crate)` helpers exposed here.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// Suppress the Windows console window that would otherwise flash on every
/// spawn. The status-bar branch poller calls this every 30 s — without the
/// flag a fresh cmd.exe appears and disappears on each tick, which looks
/// (and is) broken to the user. No-op on other platforms.
#[inline]
pub(crate) fn hide_console(cmd: &mut Command) {
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

pub(crate) fn is_repo(path: &Path) -> bool {
    matches!(
        run_git(path, &["rev-parse", "--is-inside-work-tree"]),
        Ok(out) if out.trim() == "true"
    )
}

pub(crate) fn current_branch(path: &Path) -> Option<String> {
    let out = run_git(path, &["rev-parse", "--abbrev-ref", "HEAD"]).ok()?;
    let trimmed = out.trim();
    if trimmed.is_empty() || trimmed == "HEAD" {
        // Detached HEAD — `--abbrev-ref` prints "HEAD" verbatim.
        None
    } else {
        Some(trimmed.to_string())
    }
}

pub(crate) fn current_commit(path: &Path) -> Option<String> {
    let out = run_git(path, &["rev-parse", "--short", "HEAD"]).ok()?;
    let trimmed = out.trim();
    if trimmed.is_empty() { None } else { Some(trimmed.to_string()) }
}

pub(crate) fn run_git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new(super::git_bin::git_program());
    cmd.args(args)
        .current_dir(cwd)
        // Force the C locale so git's messages (and anything we string-match on,
        // like a "would be overwritten" checkout refusal) are English regardless
        // of the user's system locale. Porcelain/ISO output we parse is already
        // locale-independent, so this only stabilizes the human-readable text.
        .env("LC_ALL", "C")
        .env("LANG", "C")
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
    /// True for the synthetic "Local changes" diff (uncommitted working-tree
    /// edits vs HEAD) produced by `git_working_tree_diff` — never a real commit.
    /// The pane keys off this to label the target and skip the "tree moved on"
    /// banner (a live diff is always against the current HEAD).
    pub is_local: bool,
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
        is_local: false,
        files,
        raw_patch,
        truncated,
        head_sha,
    })
}

/// Local branches + a small set of common remote refs, for the terminal Quick
/// Prompts strip (its only remaining caller — the structured `git_branches`
/// powers the status-bar switcher). Filters out HEAD / refs/stash / refs we
/// don't care about. Trimmed to ~50 entries — picker UIs become useless past
/// that anyway.
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

/// One entry in the status-bar branch switcher. Locals and remote-only branches,
/// deduped and recency-sorted, with the current branch flagged.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchListItem {
    /// The ref as git names it — `feature/x` for a local branch, `origin/x` for
    /// a remote one. This is what we hand to checkout.
    pub name: String,
    /// Friendly short name: the local name, or the remote ref minus its remote
    /// prefix (so `origin/feature/x` shows as `feature/x`).
    pub short: String,
    /// "local" | "remote".
    pub kind: String,
    /// The remote name for a remote branch (e.g. "origin"); `None` for locals.
    pub remote: Option<String>,
    /// True for the currently checked-out branch.
    pub is_current: bool,
}

/// Structured branch list for the switcher: local branches first (current one
/// pinned to the top, then recency-sorted), then remote-only branches (those
/// without a local counterpart). Deduped so `origin/x` is hidden when local `x`
/// exists. Each list capped so huge repos stay usable.
#[tauri::command]
pub async fn git_branches(cwd: String) -> Result<Vec<BranchListItem>, String> {
    let path = PathBuf::from(&cwd);
    if !path.exists() {
        return Err(format!("path not found: {cwd}"));
    }
    tauri::async_runtime::spawn_blocking(move || list_branches_structured(&path))
        .await
        .map_err(|e| format!("git_branches join: {e}"))?
}

fn list_branches_structured(path: &Path) -> Result<Vec<BranchListItem>, String> {
    if !is_repo(path) {
        return Err(format!("not a git repository: {}", path.display()));
    }

    // Locals, most-recently-committed first. `%(HEAD)` is "*" for the current
    // branch, " " otherwise.
    let locals_raw = run_git(
        path,
        &[
            "for-each-ref",
            "--sort=-committerdate",
            "--format=%(refname:short)%00%(HEAD)",
            "refs/heads",
        ],
    )?;
    let mut local_names: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut locals: Vec<BranchListItem> = Vec::new();
    for line in locals_raw.lines() {
        let mut it = line.split('\u{0}');
        let name = it.next().unwrap_or("").trim();
        if name.is_empty() {
            continue;
        }
        let is_current = it.next().unwrap_or("").trim() == "*";
        local_names.insert(name.to_string());
        locals.push(BranchListItem {
            name: name.to_string(),
            short: name.to_string(),
            kind: "local".into(),
            remote: None,
            is_current,
        });
    }
    // Pin the current branch to the very top; the rest keep recency order.
    locals.sort_by_key(|b| !b.is_current);

    // Remote-only branches (skip the remote HEAD pointer and any whose short
    // name already exists locally).
    let remotes_raw = run_git(
        path,
        &[
            "for-each-ref",
            "--sort=-committerdate",
            "--format=%(refname:short)",
            "refs/remotes",
        ],
    )
    .unwrap_or_default();
    let mut remotes: Vec<BranchListItem> = Vec::new();
    for line in remotes_raw.lines() {
        let full = line.trim();
        if full.is_empty() || full == "HEAD" || full.ends_with("/HEAD") {
            continue;
        }
        let Some((remote, rest)) = full.split_once('/') else {
            continue;
        };
        if rest.is_empty() || local_names.contains(rest) {
            continue;
        }
        remotes.push(BranchListItem {
            name: full.to_string(),
            short: rest.to_string(),
            kind: "remote".into(),
            remote: Some(remote.to_string()),
            is_current: false,
        });
    }

    locals.truncate(200);
    remotes.truncate(200);
    locals.extend(remotes);
    Ok(locals)
}

// ───────────────────────────────────────────────────────────────────────
// Working-tree status + uncommitted diff.
//
// `git_status_summary` is the one read the bottom status bar polls for the
// branch switcher (dirty dot + ahead/behind chips) AND the Commit Review pane
// uses to decide whether "Local changes" is offered. `git_working_tree_diff`
// is the synthetic diff the pane reviews when the user picks "Local changes":
// every uncommitted edit (staged + unstaged + untracked) vs HEAD.
// ───────────────────────────────────────────────────────────────────────

/// Message tagged onto the stash we create when the user picks "Leave my
/// changes" while switching branches. Git auto-prefixes "On <branch>: " so we
/// can find *our* parked changes for a given branch (and tell them apart from
/// the user's own manual stashes). Shared by the write side (git_ops creates
/// + restores) and the read side (status summary detects).
pub(crate) const PARKED_STASH_MARKER: &str = "devops-studio parked changes";

/// True when the working tree of `path` has a parked stash (ours) for `branch`.
/// `git stash list` records the branch each stash was made on as "On <branch>:".
/// We require the message to be EXACTLY our marker (not merely contain it) so a
/// user's own stash whose message happens to include the marker text — e.g.
/// `"devops-studio parked changes (mine)"` copied from the docs — is never
/// adopted and dropped as if we'd created it.
pub(crate) fn has_parked_stash(path: &Path, branch: &str) -> bool {
    let prefix = format!("On {branch}: ");
    run_git(path, &["stash", "list", "--format=%gs"])
        .map(|raw| raw.lines().any(|gs| is_our_parked_stash(gs, &prefix)))
        .unwrap_or(false)
}

/// Whether a `git stash list` `%gs` subject is one we parked on `branch`: the
/// branch prefix followed by EXACTLY the marker (no trailing suffix).
pub(crate) fn is_our_parked_stash(subject: &str, branch_prefix: &str) -> bool {
    subject
        .strip_prefix(branch_prefix)
        .map(|rest| rest == PARKED_STASH_MARKER)
        .unwrap_or(false)
}

/// A snapshot of the working tree's state relative to HEAD and its upstream.
/// Camel-cased for the renderer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusSummary {
    pub is_repo: bool,
    /// Current branch, or `None` on a detached HEAD.
    pub branch: Option<String>,
    /// Short HEAD SHA, or `None` on an unborn branch (no commits yet).
    pub commit: Option<String>,
    pub detached: bool,
    /// Upstream ref (e.g. "origin/main"), or `None` when the branch tracks
    /// nothing — pulling isn't possible and the UI hides the pull affordance.
    pub upstream: Option<String>,
    /// Commits ahead of / behind the upstream. Both 0 when there's no upstream.
    pub ahead: u32,
    pub behind: u32,
    /// Counts of files in each state — drive the "you have N uncommitted
    /// changes" copy and the dirty indicator.
    pub staged: u32,
    pub unstaged: u32,
    pub untracked: u32,
    pub conflicted: u32,
    /// True when there's anything uncommitted (staged, unstaged, or untracked).
    /// A plain branch switch is safe only when this is false.
    pub dirty: bool,
    /// True when this branch has changes we parked (stashed) for it — the UI
    /// surfaces a "Restore changes you left here" affordance.
    pub parked_here: bool,
}

impl GitStatusSummary {
    fn not_a_repo() -> Self {
        Self {
            is_repo: false,
            branch: None,
            commit: None,
            detached: false,
            upstream: None,
            ahead: 0,
            behind: 0,
            staged: 0,
            unstaged: 0,
            untracked: 0,
            conflicted: 0,
            dirty: false,
            parked_here: false,
        }
    }
}

#[tauri::command]
pub async fn git_status_summary(path: String) -> Result<GitStatusSummary, String> {
    let path = PathBuf::from(&path);
    if !path.exists() {
        return Ok(GitStatusSummary::not_a_repo());
    }
    tauri::async_runtime::spawn_blocking(move || read_status(&path))
        .await
        .map_err(|e| format!("git_status_summary join: {e}"))?
}

fn read_status(path: &Path) -> Result<GitStatusSummary, String> {
    if !is_repo(path) {
        return Ok(GitStatusSummary::not_a_repo());
    }
    // porcelain=v2 is the stable machine format: header lines carry the branch,
    // upstream, and ahead/behind; entry lines carry per-file staged (X) and
    // unstaged (Y) states. We parse line-by-line (no -z) which is safe for
    // counting — only exotic paths with embedded newlines would miscount, and
    // those are vanishingly rare and only skew a tally, never a write.
    let raw = run_git(path, &["status", "--porcelain=v2", "--branch"])?;

    let mut branch: Option<String> = None;
    let mut detached = false;
    let mut upstream: Option<String> = None;
    let (mut ahead, mut behind) = (0u32, 0u32);
    let (mut staged, mut unstaged, mut untracked, mut conflicted) = (0u32, 0u32, 0u32, 0u32);

    for line in raw.lines() {
        if let Some(rest) = line.strip_prefix("# branch.head ") {
            if rest == "(detached)" {
                detached = true;
            } else {
                branch = Some(rest.to_string());
            }
        } else if let Some(rest) = line.strip_prefix("# branch.upstream ") {
            let u = rest.trim();
            if !u.is_empty() {
                upstream = Some(u.to_string());
            }
        } else if let Some(rest) = line.strip_prefix("# branch.ab ") {
            for tok in rest.split_whitespace() {
                if let Some(a) = tok.strip_prefix('+') {
                    ahead = a.parse().unwrap_or(0);
                } else if let Some(b) = tok.strip_prefix('-') {
                    behind = b.parse().unwrap_or(0);
                }
            }
        } else if (line.starts_with("1 ") || line.starts_with("2 ")) && line.len() >= 4 {
            // "1 XY ..." / "2 XY ..." — X = staged state, Y = unstaged state.
            let xy = line.as_bytes();
            if xy[2] != b'.' {
                staged += 1;
            }
            if xy[3] != b'.' {
                unstaged += 1;
            }
        } else if line.starts_with("u ") {
            conflicted += 1;
        } else if line.starts_with("? ") {
            untracked += 1;
        }
    }

    let commit = current_commit(path);
    let parked_here = branch
        .as_deref()
        .map(|b| has_parked_stash(path, b))
        .unwrap_or(false);
    Ok(GitStatusSummary {
        is_repo: true,
        branch,
        commit,
        detached,
        upstream,
        ahead,
        behind,
        staged,
        unstaged,
        untracked,
        conflicted,
        dirty: staged + unstaged + untracked + conflicted > 0,
        parked_here,
    })
}

/// How many untracked files we read+inline before giving up on per-file detail.
/// A normal dirty tree has a handful; this only guards against someone with a
/// huge un-gitignored directory (the file list still shows them, just without
/// line counts past the cap).
const MAX_UNTRACKED_DETAIL: usize = 500;

/// The diff of every uncommitted change vs HEAD — what the Commit Review pane
/// reviews as "Local changes". Returns the same `CommitDiff` shape as a real
/// commit (so the whole review pipeline is unchanged) with `is_local: true`.
#[tauri::command]
pub async fn git_working_tree_diff(cwd: String) -> Result<CommitDiff, String> {
    let path = PathBuf::from(&cwd);
    if !path.exists() {
        return Err(format!("path not found: {cwd}"));
    }
    tauri::async_runtime::spawn_blocking(move || compute_working_tree_diff(&path))
        .await
        .map_err(|e| format!("git_working_tree_diff join: {e}"))?
}

fn compute_working_tree_diff(path: &Path) -> Result<CommitDiff, String> {
    if !is_repo(path) {
        return Err(format!("not a git repository: {}", path.display()));
    }

    // Tracked changes: `git diff HEAD` is staged+unstaged vs the last commit.
    // On an unborn branch (no commits yet) HEAD doesn't resolve, so fall back
    // to the staged index (`--cached`), which compares against the empty tree.
    let has_head = run_git(path, &["rev-parse", "--verify", "HEAD"]).is_ok();
    let range = if has_head { "HEAD" } else { "--cached" };

    let mut files = collect_diff_files(path, range)?;
    let tracked_raw = run_git(path, &["diff", "--no-color", range]).unwrap_or_default();

    // Untracked files aren't in `git diff` at all — enumerate them (honoring
    // .gitignore via --exclude-standard) and synthesize "new file" patches so
    // the model sees their content the same way it would a real added file.
    let untracked_raw = run_git(path, &["ls-files", "--others", "--exclude-standard", "-z"])
        .unwrap_or_default();
    // `-z` is NUL-delimited and binary-safe, so the records are the paths
    // verbatim (no CR trimming — that would corrupt a path legitimately ending
    // in '\r').
    let untracked: Vec<&str> = untracked_raw
        .split('\0')
        .filter(|s| !s.is_empty())
        .collect();

    let mut synthesized = String::new();
    // True when some untracked file's content was left out of the patch (past
    // the file-count or byte cap) even though it's listed — so we flag the diff
    // as truncated and the UI shows the "partial diff" notice.
    let mut omitted_untracked = false;
    for (i, rel) in untracked.iter().enumerate() {
        // Past the file-count cap, OR the patch is already full: still list the
        // file so the count is honest, but don't read it. Skipping the read once
        // the patch is full avoids buffering content cap_patch would only trim.
        if i >= MAX_UNTRACKED_DETAIL || synthesized.len() >= PATCH_MAX_BYTES {
            files.push(DiffFile {
                path: (*rel).to_string(),
                additions: 0,
                deletions: 0,
                status: "added".into(),
            });
            omitted_untracked = true;
            continue;
        }
        let (block, adds, content_omitted) = synth_untracked_patch(path, rel);
        files.push(DiffFile {
            path: (*rel).to_string(),
            additions: adds,
            deletions: 0,
            status: "added".into(),
        });
        synthesized.push_str(&block);
        if content_omitted {
            omitted_untracked = true;
        }
    }

    let combined = if synthesized.is_empty() {
        tracked_raw
    } else if tracked_raw.is_empty() {
        synthesized
    } else {
        format!("{tracked_raw}\n{synthesized}")
    };
    let (raw_patch, capped) = cap_patch(combined);
    let truncated = capped || omitted_untracked;
    let head_sha = current_commit(path).unwrap_or_default();

    let total_files = files.len();
    Ok(CommitDiff {
        sha: "local".into(),
        short_sha: "local".into(),
        subject: if total_files == 0 {
            "No uncommitted changes".into()
        } else {
            format!(
                "Uncommitted changes — {total_files} file{}",
                if total_files == 1 { "" } else { "s" }
            )
        },
        author: String::new(),
        date: String::new(),
        is_root: false,
        is_merge: false,
        is_local: true,
        files,
        raw_patch,
        truncated,
        head_sha,
    })
}

/// Largest untracked file we inline into the synthetic diff. A file bigger than
/// this is still listed (so the file count stays honest) but its content is
/// omitted: reading a multi-GB un-gitignored blob (build artifact, DB dump,
/// video, log) fully into memory just to inline it would spike RAM, and
/// `PATCH_MAX_BYTES` (far smaller) would trim it away anyway. Capping the READ
/// here bounds per-file memory regardless of how large the file on disk is.
const MAX_UNTRACKED_FILE_BYTES: u64 = 256 * 1024;

/// Build a unified-diff "new file" block for an untracked file, plus its line
/// count and whether its content was omitted. Reads only a bounded prefix
/// (`MAX_UNTRACKED_FILE_BYTES`) so a giant blob is never slurped whole into
/// memory. Binary files (a NUL byte in the first 8 KiB) and oversized files get
/// a terse one-line block; unreadable files yield an empty block (they're still
/// listed by the caller).
fn synth_untracked_patch(repo: &Path, rel: &str) -> (String, u32, bool) {
    use std::io::Read;
    let header = format!("diff --git a/{rel} b/{rel}\nnew file mode 100644\n");
    let file = match std::fs::File::open(repo.join(rel)) {
        Ok(f) => f,
        Err(_) => return (String::new(), 0, false),
    };
    // Read at most the cap + 1 byte: the extra byte reveals "the file is bigger
    // than the cap" without reading (and allocating) the rest of it.
    let mut bytes = Vec::new();
    if file
        .take(MAX_UNTRACKED_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .is_err()
    {
        return (String::new(), 0, false);
    }
    let oversized = bytes.len() as u64 > MAX_UNTRACKED_FILE_BYTES;
    let is_binary = bytes.iter().take(8 * 1024).any(|&b| b == 0);
    if is_binary {
        return (
            format!("{header}Binary files /dev/null and b/{rel} differ\n"),
            0,
            false,
        );
    }
    if oversized {
        // Too big to inline — list it without content so the review stays honest
        // about the file existing while flagging the diff as partial.
        return (
            format!(
                "{header}New file too large to inline (>{} KiB) — content omitted.\n",
                MAX_UNTRACKED_FILE_BYTES / 1024
            ),
            0,
            true,
        );
    }
    let text = String::from_utf8_lossy(&bytes);
    let ends_nl = text.ends_with('\n');
    let body = if ends_nl { &text[..text.len() - 1] } else { &text[..] };
    let lines: Vec<&str> = if body.is_empty() {
        // A truly empty file (or a lone "\n") → no hunk, like git.
        if ends_nl { vec![""] } else { Vec::new() }
    } else {
        body.split('\n').collect()
    };
    if lines.is_empty() {
        return (header, 0, false);
    }
    let mut out = format!("{header}--- /dev/null\n+++ b/{rel}\n@@ -0,0 +1,{} @@\n", lines.len());
    for l in &lines {
        out.push('+');
        out.push_str(l);
        out.push('\n');
    }
    if !ends_nl {
        out.push_str("\\ No newline at end of file\n");
    }
    (out, lines.len() as u32, false)
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

    #[test]
    fn status_summary_reports_clean_then_dirty() {
        let repo = two_commit_repo();
        let p = repo.path();

        let clean = read_status(p).unwrap();
        assert!(clean.is_repo);
        assert_eq!(clean.branch.as_deref(), Some("main"));
        assert!(!clean.dirty, "fresh repo should be clean");
        assert_eq!(clean.staged + clean.unstaged + clean.untracked, 0);

        // An unstaged edit + a brand-new untracked file.
        fs::write(p.join("a.txt"), "one\ntwo\nthree\nfour\n").unwrap();
        fs::write(p.join("new.txt"), "fresh\n").unwrap();
        let dirty = read_status(p).unwrap();
        assert!(dirty.dirty);
        assert_eq!(dirty.unstaged, 1, "a.txt modified");
        assert_eq!(dirty.untracked, 1, "new.txt untracked");
    }

    #[test]
    fn working_tree_diff_includes_tracked_and_untracked() {
        let repo = two_commit_repo();
        let p = repo.path();
        fs::write(p.join("a.txt"), "one\ntwo\nthree\nFOUR\n").unwrap();
        fs::write(p.join("new.txt"), "brand new\nsecond line\n").unwrap();

        let diff = compute_working_tree_diff(p).unwrap();
        assert!(diff.is_local);
        let paths: Vec<&str> = diff.files.iter().map(|f| f.path.as_str()).collect();
        assert!(paths.contains(&"a.txt"), "tracked edit present");
        assert!(paths.contains(&"new.txt"), "untracked file present");

        // The untracked file is rendered as an added file with its content.
        let new = diff.files.iter().find(|f| f.path == "new.txt").unwrap();
        assert_eq!(new.status, "added");
        assert_eq!(new.additions, 2);
        assert!(diff.raw_patch.contains("+brand new"));
        assert!(diff.raw_patch.contains("+FOUR"));
    }

    #[test]
    fn working_tree_diff_is_empty_on_clean_tree() {
        let repo = two_commit_repo();
        let diff = compute_working_tree_diff(repo.path()).unwrap();
        assert!(diff.is_local);
        assert!(diff.files.is_empty(), "clean tree → no files");
        assert!(diff.raw_patch.trim().is_empty());
    }

    #[test]
    fn structured_branches_mark_current_and_dedupe() {
        let repo = two_commit_repo();
        let p = repo.path();
        git(p, &["branch", "feature"]);
        git(p, &["branch", "release"]);

        let branches = list_branches_structured(p).unwrap();
        let names: Vec<&str> = branches.iter().map(|b| b.short.as_str()).collect();
        assert!(names.contains(&"main"));
        assert!(names.contains(&"feature"));
        assert!(names.contains(&"release"));
        // The current branch is flagged and pinned to the front.
        assert!(branches[0].is_current);
        assert_eq!(branches[0].short, "main");
        assert_eq!(branches.iter().filter(|b| b.is_current).count(), 1);
        // No remotes in this throwaway repo.
        assert!(branches.iter().all(|b| b.kind == "local"));
    }

    #[test]
    fn detects_only_our_parked_stash_for_the_branch() {
        let repo = two_commit_repo();
        let p = repo.path();
        assert!(!has_parked_stash(p, "main"), "clean repo, no stash");

        // A stash WITHOUT our marker must not count as ours.
        fs::write(p.join("a.txt"), "one\ntwo\nedited\n").unwrap();
        git(p, &["stash", "push", "-m", "some manual stash"]);
        assert!(!has_parked_stash(p, "main"), "manual stash isn't ours");

        // A stash WITH our marker, on this branch, counts.
        fs::write(p.join("a.txt"), "one\ntwo\nedited-again\n").unwrap();
        git(p, &["stash", "push", "-m", PARKED_STASH_MARKER]);
        assert!(has_parked_stash(p, "main"));
        // ...but not for a different branch name.
        assert!(!has_parked_stash(p, "feature"));
    }

    #[test]
    fn parked_stash_ownership_requires_an_exact_marker_message() {
        let repo = two_commit_repo();
        let p = repo.path();
        fs::write(p.join("a.txt"), "one\ntwo\nmine\n").unwrap();
        // A hand-made stash whose message only CONTAINS the marker as a
        // substring must not be adopted (and later dropped) as if it were ours.
        git(
            p,
            &["stash", "push", "-m", &format!("{PARKED_STASH_MARKER} (mine)")],
        );
        assert!(
            !has_parked_stash(p, "main"),
            "a substring match must not adopt a user's own stash"
        );
    }

    #[test]
    fn working_tree_diff_handles_binary_and_missing_newline() {
        let repo = two_commit_repo();
        let p = repo.path();
        // Untracked text file with NO trailing newline.
        fs::write(p.join("nonl.txt"), "no newline here").unwrap();
        // Untracked binary file (embedded NUL byte).
        fs::write(p.join("bin.dat"), [0u8, 1, 2, 0, 255]).unwrap();

        let diff = compute_working_tree_diff(p).unwrap();
        let paths: Vec<&str> = diff.files.iter().map(|f| f.path.as_str()).collect();
        assert!(paths.contains(&"nonl.txt"));
        assert!(paths.contains(&"bin.dat"));
        assert!(diff.raw_patch.contains("No newline at end of file"));
        assert!(
            diff.raw_patch
                .contains("Binary files /dev/null and b/bin.dat differ")
        );
        // The single-line no-newline file counts as one addition.
        let nonl = diff.files.iter().find(|f| f.path == "nonl.txt").unwrap();
        assert_eq!(nonl.additions, 1);
        // Binary file contributes no line additions.
        let bin = diff.files.iter().find(|f| f.path == "bin.dat").unwrap();
        assert_eq!(bin.additions, 0);
    }

    /// A two-commit repo plus a bare `origin` it tracks (main pushed, upstream set).
    fn repo_with_upstream() -> (tempfile::TempDir, tempfile::TempDir) {
        let remote = tempfile::tempdir().unwrap();
        git(remote.path(), &["init", "-q", "--bare", "-b", "main"]);
        let local = two_commit_repo();
        let p = local.path();
        git(p, &["remote", "add", "origin", remote.path().to_str().unwrap()]);
        git(p, &["push", "-q", "-u", "origin", "main"]);
        (local, remote)
    }

    #[test]
    fn status_summary_reports_upstream_and_ahead_behind() {
        let (local, remote) = repo_with_upstream();
        let p = local.path();

        // Right after push: upstream set, in sync.
        let s0 = read_status(p).unwrap();
        assert_eq!(s0.upstream.as_deref(), Some("origin/main"));
        assert_eq!((s0.ahead, s0.behind), (0, 0));

        // One unpushed local commit → ahead 1.
        fs::write(p.join("a.txt"), "one\ntwo\nthree\nlocal\n").unwrap();
        git(p, &["commit", "-qam", "local ahead"]);
        let s1 = read_status(p).unwrap();
        assert_eq!((s1.ahead, s1.behind), (1, 0));

        // Advance the remote via a clone, fetch → now also behind 1.
        let other = tempfile::tempdir().unwrap();
        git(other.path(), &["clone", "-q", remote.path().to_str().unwrap(), "."]);
        git(other.path(), &["config", "commit.gpgsign", "false"]);
        fs::write(other.path().join("c.txt"), "remote\n").unwrap();
        git(other.path(), &["add", "c.txt"]);
        git(other.path(), &["commit", "-qm", "remote ahead"]);
        git(other.path(), &["push", "-q", "origin", "main"]);
        git(p, &["fetch", "-q", "origin"]);
        let s2 = read_status(p).unwrap();
        assert_eq!((s2.ahead, s2.behind), (1, 1));
    }

    #[test]
    fn status_summary_flags_detached_head() {
        let repo = two_commit_repo();
        let p = repo.path();
        let head = run_git(p, &["rev-parse", "HEAD"]).unwrap();
        git(p, &["checkout", "-q", head.trim()]);
        let s = read_status(p).unwrap();
        assert!(s.detached);
        assert!(s.branch.is_none(), "no branch name on a detached HEAD");
    }

    #[test]
    fn status_summary_counts_unmerged_conflicts() {
        let repo = two_commit_repo();
        let p = repo.path();
        git(p, &["checkout", "-qb", "feature"]);
        fs::write(p.join("a.txt"), "one\ntwo\nFEATURE\n").unwrap();
        git(p, &["commit", "-qam", "feature edit"]);
        git(p, &["checkout", "-q", "main"]);
        fs::write(p.join("a.txt"), "one\ntwo\nMAIN\n").unwrap();
        git(p, &["commit", "-qam", "main edit"]);
        // Conflicting merge — leaves an unmerged path (the merge itself fails).
        let _ = run_git(p, &["merge", "feature"]);
        let s = read_status(p).unwrap();
        assert!(s.conflicted >= 1, "the unmerged path is counted");
        assert!(s.dirty);
    }

    #[test]
    fn status_summary_sets_parked_here_for_our_stash() {
        let repo = two_commit_repo();
        let p = repo.path();
        fs::write(p.join("a.txt"), "one\ntwo\nthree\nwip\n").unwrap();
        git(
            p,
            &["stash", "push", "--include-untracked", "-m", PARKED_STASH_MARKER],
        );
        let s = read_status(p).unwrap();
        assert!(s.parked_here, "our parked stash on main is surfaced");
        assert!(!s.dirty, "the tree is clean once parked");
    }

    #[test]
    fn working_tree_diff_on_unborn_branch_uses_the_index() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        git(p, &["init", "-q", "-b", "main"]);
        git(p, &["config", "commit.gpgsign", "false"]);
        // Stage a file but never commit → HEAD doesn't resolve (unborn branch).
        fs::write(p.join("a.txt"), "first\nsecond\n").unwrap();
        git(p, &["add", "a.txt"]);

        let diff = compute_working_tree_diff(p).unwrap();
        assert!(diff.is_local);
        assert!(diff.head_sha.is_empty(), "no commit yet → empty head sha");
        let a = diff.files.iter().find(|f| f.path == "a.txt").unwrap();
        assert_eq!(a.status, "added");
        assert!(diff.raw_patch.contains("+first"));
    }

    #[test]
    fn working_tree_diff_omits_oversized_untracked_content() {
        let repo = two_commit_repo();
        let p = repo.path();
        // An untracked text file larger than the per-file inline cap.
        let big = "x".repeat(MAX_UNTRACKED_FILE_BYTES as usize + 4096);
        fs::write(p.join("big.txt"), &big).unwrap();

        let diff = compute_working_tree_diff(p).unwrap();
        assert!(diff.truncated, "oversized untracked content flags a partial diff");
        let f = diff.files.iter().find(|f| f.path == "big.txt").unwrap();
        assert_eq!(f.status, "added");
        assert_eq!(f.additions, 0, "content omitted → no line count");
        assert!(diff.raw_patch.contains("too large to inline"));
        // The huge body was never inlined (the patch is far smaller than it).
        assert!(diff.raw_patch.len() < big.len());
    }

    #[test]
    fn merge_commit_diff_is_flagged_and_diffs_first_parent() {
        let repo = two_commit_repo();
        let p = repo.path();
        git(p, &["checkout", "-qb", "feature"]);
        fs::write(p.join("c.txt"), "feature file\n").unwrap();
        git(p, &["add", "c.txt"]);
        git(p, &["commit", "-qm", "feature commit"]);
        git(p, &["checkout", "-q", "main"]);
        // An independent change on main forces a real (non-fast-forward) merge.
        fs::write(p.join("d.txt"), "main file\n").unwrap();
        git(p, &["add", "d.txt"]);
        git(p, &["commit", "-qm", "main commit"]);
        git(p, &["merge", "--no-ff", "-m", "merge feature", "feature"]);

        let merge_sha = run_git(p, &["rev-parse", "HEAD"]).unwrap();
        let diff = compute_commit_diff(p, merge_sha.trim()).unwrap();
        assert!(diff.is_merge, "two parents → merge commit");
        // Diffed vs the first parent (main), so feature's file shows as the delta.
        assert!(diff.files.iter().any(|f| f.path == "c.txt"));
    }

    #[test]
    fn structured_branches_lists_remote_only_and_dedupes_local() {
        let (local, remote) = repo_with_upstream();
        let p = local.path();
        // Create a remote-only branch (push it, then drop the local copy).
        git(p, &["checkout", "-qb", "remote-only"]);
        git(p, &["push", "-q", "origin", "remote-only"]);
        git(p, &["checkout", "-q", "main"]);
        git(p, &["branch", "-qD", "remote-only"]);
        git(p, &["fetch", "-q", "origin"]);
        let _ = remote;

        let branches = list_branches_structured(p).unwrap();
        // `main` exists locally, so `origin/main` is deduped away.
        assert!(branches
            .iter()
            .any(|b| b.short == "main" && b.kind == "local"));
        assert!(
            !branches.iter().any(|b| b.short == "main" && b.kind == "remote"),
            "origin/main hidden behind local main"
        );
        // `remote-only` shows up as a remote branch tracking origin.
        let ro = branches
            .iter()
            .find(|b| b.short == "remote-only")
            .expect("remote-only listed");
        assert_eq!(ro.kind, "remote");
        assert_eq!(ro.remote.as_deref(), Some("origin"));
    }
}

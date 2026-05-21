//! Source-directory git introspection.
//!
//! Used by the bottom status bar and the "use current branch" toggle in the
//! Azure DevOps settings. Stays read-only — we never invoke a write subcommand
//! against the user's tree.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

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
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("spawn git: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

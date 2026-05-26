//! ADO Git repos: list, read file, list commits since SHA.
//!
//! Used by source-code linking to build code-link chips on published cases.

use serde::{Deserialize, Serialize};

use super::client::{get_json, get_raw_json, project_api, AdoState};
use super::errors::{AdoError, AdoResult};
use super::types::{
    CommitInfo, Connection, FileContent, PagedResponse, PullRequestRef, RepoRef,
};

/// Cap on the synthesized patch text we hand the reviewer model. ADO's diff
/// endpoints give a change LIST but not a unified patch, so we assemble one
/// from the changed files' target content; this keeps the prompt bounded.
const ADO_PATCH_CAP: usize = 60 * 1024;

pub async fn list_repos(state: &AdoState) -> AdoResult<Vec<RepoRef>> {
    let (conn, _) = state.snapshot();
    let conn = conn.ok_or(AdoError::NotConfigured)?;
    let url = project_api(&conn, "git/repositories");
    let resp: PagedResponse<RawRepo> = get_json(state, &url, "git repos").await?;
    Ok(resp.value.into_iter().map(RawRepo::into_ref).collect())
}

pub async fn get_file(
    state: &AdoState,
    repo_id: &str,
    branch: &str,
    path: &str,
) -> AdoResult<FileContent> {
    let (conn, _) = state.snapshot();
    let conn = conn.ok_or(AdoError::NotConfigured)?;
    let url = project_api(
        &conn,
        &format!(
            "git/repositories/{repo}/items?path={p}&versionDescriptor.version={br}&versionDescriptor.versionType=branch&includeContent=true",
            repo = repo_id,
            p = url_encode(path),
            br = url_encode(branch),
        ),
    );
    let raw = get_raw_json(state, &url, "git file").await?;
    let content = raw
        .get("content")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let sha = raw
        .get("objectId")
        .and_then(|v| v.as_str())
        .map(String::from);
    Ok(FileContent { content, sha })
}

pub async fn list_commits_since(
    state: &AdoState,
    repo_id: &str,
    branch: &str,
    since_sha: Option<&str>,
) -> AdoResult<Vec<CommitInfo>> {
    let (conn, _) = state.snapshot();
    let conn = conn.ok_or(AdoError::NotConfigured)?;
    let mut path = format!(
        "git/repositories/{repo}/commits?searchCriteria.itemVersion.version={br}&searchCriteria.itemVersion.versionType=branch&$top=200",
        repo = repo_id,
        br = url_encode(branch),
    );
    if let Some(s) = since_sha {
        path.push_str(&format!(
            "&searchCriteria.fromCommitId={s}",
            s = url_encode(s)
        ));
    }
    let url = project_api(&conn, &path);
    let resp: PagedResponse<RawCommit> = get_json(state, &url, "git commits").await?;

    // Fetch changed files for each commit (one API call per commit — small batches).
    let mut out: Vec<CommitInfo> = Vec::with_capacity(resp.value.len());
    for c in resp.value {
        let changes_url = project_api(
            &conn,
            &format!("git/repositories/{repo_id}/commits/{cid}/changes", cid = c.commit_id),
        );
        let changes: serde_json::Value = get_raw_json(state, &changes_url, "git changes").await?;
        let changed_files: Vec<String> = changes
            .get("changes")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|ch| {
                        ch.get("item")
                            .and_then(|i| i.get("path"))
                            .and_then(|p| p.as_str())
                            .map(String::from)
                    })
                    .collect()
            })
            .unwrap_or_default();
        out.push(CommitInfo {
            commit_id: c.commit_id,
            author_name: c.author.as_ref().and_then(|a| a.name.clone()),
            comment: c.comment,
            committed_date: c.committer.as_ref().and_then(|a| a.date.clone()),
            changed_files,
        });
    }
    Ok(out)
}

fn url_encode(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

// --- Diffs (for the unified Code Review pane's ADO source) ------------------

/// DiffSummary-shaped payload (matches the TS DiffSummary the review pane
/// consumes), so an ADO diff feeds the same pipeline as a local git diff.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdoDiff {
    pub base: String,
    pub head: String,
    pub files: Vec<AdoDiffFile>,
    pub raw_patch: String,
    pub truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdoDiffFile {
    pub path: String,
    pub additions: u32,
    pub deletions: u32,
    pub status: String,
}

#[derive(Clone)]
struct ChangeEntry {
    path: String,
    change_type: String,
    is_blob: bool,
}

/// Parse an ADO `changes[]` array (from commits/{id}/changes or diffs/commits)
/// into our lightweight change entries. Folders (gitObjectType=tree) are
/// dropped — we only diff files.
fn parse_changes(changes_json: &serde_json::Value) -> Vec<ChangeEntry> {
    changes_json
        .get("changes")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|ch| {
                    let item = ch.get("item")?;
                    let path = item.get("path").and_then(|p| p.as_str())?.to_string();
                    let git_obj = item
                        .get("gitObjectType")
                        .and_then(|g| g.as_str())
                        .unwrap_or("blob");
                    let change_type = ch
                        .get("changeType")
                        .and_then(|c| c.as_str())
                        .unwrap_or("edit")
                        .to_string();
                    Some(ChangeEntry {
                        path,
                        change_type,
                        is_blob: git_obj == "blob",
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Fetch a file's content at a specific version (branch or commit). Returns
/// None on any failure so a single unreadable file doesn't abort the diff.
async fn get_item_content(
    state: &AdoState,
    conn: &Connection,
    repo_id: &str,
    path: &str,
    version: &str,
    version_type: &str,
) -> Option<String> {
    let url = project_api(
        conn,
        &format!(
            "git/repositories/{repo}/items?path={p}&versionDescriptor.version={v}&versionDescriptor.versionType={vt}&includeContent=true",
            repo = repo_id,
            p = url_encode(path),
            v = url_encode(version),
            vt = version_type,
        ),
    );
    let raw = get_raw_json(state, &url, "git item").await.ok()?;
    raw.get("content").and_then(|c| c.as_str()).map(String::from)
}

/// Build the DiffSummary payload from a change list: the file list is always
/// complete; the patch text is synthesized from each changed file's target
/// content (capped). The model is told the patch may be truncated and to use
/// its read tools — the complete file list is the reliable signal.
async fn build_diff_payload(
    state: &AdoState,
    conn: &Connection,
    repo_id: &str,
    changes: Vec<ChangeEntry>,
    version: &str,
    version_type: &str,
    base_label: String,
    head_label: String,
) -> AdoDiff {
    let files: Vec<AdoDiffFile> = changes
        .iter()
        .filter(|c| c.is_blob)
        .map(|c| AdoDiffFile {
            path: c.path.clone(),
            // ADO's change list doesn't carry per-file line counts.
            additions: 0,
            deletions: 0,
            status: c.change_type.clone(),
        })
        .collect();

    let mut patch = String::new();
    let mut truncated = false;
    for c in changes.iter().filter(|c| c.is_blob) {
        if patch.len() >= ADO_PATCH_CAP {
            truncated = true;
            break;
        }
        let ct = c.change_type.to_lowercase();
        if ct.contains("delete") {
            patch.push_str(&format!("--- {} (deleted) ---\n\n", c.path));
            continue;
        }
        if let Some(content) =
            get_item_content(state, conn, repo_id, &c.path, version, version_type).await
        {
            let remaining = ADO_PATCH_CAP.saturating_sub(patch.len());
            let body: String = if content.len() > remaining {
                truncated = true;
                content.chars().take(remaining).collect()
            } else {
                content
            };
            patch.push_str(&format!("--- {} ({}) ---\n{}\n\n", c.path, c.change_type, body));
        }
    }
    AdoDiff {
        base: base_label,
        head: head_label,
        files,
        raw_patch: patch,
        truncated,
    }
}

/// Diff a single commit (its changes vs its parent), content at the commit.
pub async fn diff_commit(
    state: &AdoState,
    repo_id: &str,
    commit_id: &str,
) -> AdoResult<AdoDiff> {
    let (conn, _) = state.snapshot();
    let conn = conn.ok_or(AdoError::NotConfigured)?;
    let url = project_api(
        &conn,
        &format!("git/repositories/{repo_id}/commits/{commit_id}/changes"),
    );
    let changes_json = get_raw_json(state, &url, "commit changes").await?;
    let changes = parse_changes(&changes_json);
    let short = commit_id.chars().take(8).collect::<String>();
    Ok(build_diff_payload(
        state,
        &conn,
        repo_id,
        changes,
        commit_id,
        "commit",
        format!("{short}^"),
        short,
    )
    .await)
}

/// Diff two branches (base...target), content at the target branch.
pub async fn diff_branches(
    state: &AdoState,
    repo_id: &str,
    base_branch: &str,
    target_branch: &str,
) -> AdoResult<AdoDiff> {
    let (conn, _) = state.snapshot();
    let conn = conn.ok_or(AdoError::NotConfigured)?;
    let url = project_api(
        &conn,
        &format!(
            "git/repositories/{repo}/diffs/commits?baseVersion={b}&baseVersionType=branch&targetVersion={t}&targetVersionType=branch",
            repo = repo_id,
            b = url_encode(base_branch),
            t = url_encode(target_branch),
        ),
    );
    let changes_json = get_raw_json(state, &url, "branch diff").await?;
    let changes = parse_changes(&changes_json);
    Ok(build_diff_payload(
        state,
        &conn,
        repo_id,
        changes,
        target_branch,
        "branch",
        base_branch.to_string(),
        target_branch.to_string(),
    )
    .await)
}

/// List active pull requests for the repo (for the PR picker).
pub async fn list_pull_requests(
    state: &AdoState,
    repo_id: &str,
    top: i64,
) -> AdoResult<Vec<PullRequestRef>> {
    let (conn, _) = state.snapshot();
    let conn = conn.ok_or(AdoError::NotConfigured)?;
    let top = top.clamp(1, 100);
    let url = project_api(
        &conn,
        &format!(
            "git/repositories/{repo}/pullrequests?searchCriteria.status=active&$top={top}",
            repo = repo_id,
        ),
    );
    let resp: PagedResponse<RawPullRequest> = get_json(state, &url, "pull requests").await?;
    Ok(resp.value.into_iter().map(RawPullRequest::into_ref).collect())
}

/// Diff a pull request (target...source), content at the source commit.
pub async fn diff_pull_request(
    state: &AdoState,
    repo_id: &str,
    pr_id: i64,
) -> AdoResult<AdoDiff> {
    let (conn, _) = state.snapshot();
    let conn = conn.ok_or(AdoError::NotConfigured)?;
    let pr_url = project_api(
        &conn,
        &format!("git/repositories/{repo_id}/pullrequests/{pr_id}"),
    );
    let pr = get_raw_json(state, &pr_url, "pull request").await?;
    let source = pr
        .get("lastMergeSourceCommit")
        .and_then(|c| c.get("commitId"))
        .and_then(|c| c.as_str())
        .ok_or_else(|| AdoError::local("PR has no source commit"))?;
    let target = pr
        .get("lastMergeTargetCommit")
        .and_then(|c| c.get("commitId"))
        .and_then(|c| c.as_str())
        .ok_or_else(|| AdoError::local("PR has no target commit"))?;
    let source_ref = pr
        .get("sourceRefName")
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .trim_start_matches("refs/heads/")
        .to_string();
    let target_ref = pr
        .get("targetRefName")
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .trim_start_matches("refs/heads/")
        .to_string();
    let url = project_api(
        &conn,
        &format!(
            "git/repositories/{repo}/diffs/commits?baseVersion={b}&baseVersionType=commit&targetVersion={t}&targetVersionType=commit",
            repo = repo_id,
            b = url_encode(target),
            t = url_encode(source),
        ),
    );
    let changes_json = get_raw_json(state, &url, "pull request diff").await?;
    let changes = parse_changes(&changes_json);
    Ok(build_diff_payload(
        state,
        &conn,
        repo_id,
        changes,
        source,
        "commit",
        if target_ref.is_empty() { "target".into() } else { target_ref },
        if source_ref.is_empty() {
            format!("PR #{pr_id}")
        } else {
            source_ref
        },
    )
    .await)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPullRequest {
    pull_request_id: i64,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    source_ref_name: Option<String>,
    #[serde(default)]
    target_ref_name: Option<String>,
}

impl RawPullRequest {
    fn into_ref(self) -> PullRequestRef {
        let strip = |r: Option<String>| {
            r.map(|s| s.trim_start_matches("refs/heads/").to_string())
                .unwrap_or_default()
        };
        PullRequestRef {
            id: self.pull_request_id,
            title: self.title.unwrap_or_default(),
            source_branch: strip(self.source_ref_name),
            target_branch: strip(self.target_ref_name),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawRepo {
    id: String,
    name: String,
    #[serde(default)]
    default_branch: Option<String>,
    #[serde(default)]
    web_url: Option<String>,
}

impl RawRepo {
    fn into_ref(self) -> RepoRef {
        RepoRef {
            id: self.id,
            name: self.name,
            default_branch: self
                .default_branch
                .map(|b| b.trim_start_matches("refs/heads/").to_string()),
            web_url: self.web_url,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawCommit {
    commit_id: String,
    #[serde(default)]
    author: Option<RawCommitAuthor>,
    #[serde(default)]
    committer: Option<RawCommitAuthor>,
    #[serde(default)]
    comment: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawCommitAuthor {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    date: Option<String>,
}

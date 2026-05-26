//! ADO Git repos: list, read file, list commits since SHA.
//!
//! Used by source-code linking to build code-link chips on published cases.

use serde::Deserialize;

use super::client::{get_json, get_raw_json, project_api, AdoState};
use super::errors::{AdoError, AdoResult};
use super::types::{CommitInfo, FileContent, PagedResponse, RepoRef};

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

//! Org-level project listing.
//!
//! `GET {org}/_apis/projects` returns every project the PAT can see. We use
//! it to populate the Project dropdown in Settings — replacing the old
//! free-text input where typos silently broke later API calls.
//!
//! ADO's projects endpoint is paged; we follow with `$skip` until the
//! returned page is shorter than the page size. In practice an org rarely
//! has more than a couple hundred projects, so this resolves in one call.

use super::client::{get_json, org_api, urlencoded, AdoState};
use super::errors::{AdoError, AdoResult};
use super::types::{PagedResponse, ProjectRef, TeamMember};
use serde::Deserialize;

const PAGE_SIZE: usize = 500;

pub async fn list_projects(state: &AdoState) -> AdoResult<Vec<ProjectRef>> {
    let (conn, _) = state.snapshot();
    let conn = conn.ok_or(AdoError::NotConfigured)?;

    let mut out: Vec<ProjectRef> = Vec::new();
    let mut skip = 0usize;
    loop {
        // stateFilter=all keeps brand-new (createPending) projects from being
        // silently hidden — default is wellFormed only.
        let url = org_api(
            &conn,
            &format!("projects?$top={PAGE_SIZE}&$skip={skip}&stateFilter=all"),
        );
        let page: PagedResponse<RawProject> = get_json(state, &url, "projects").await?;
        let got = page.value.len();
        out.extend(page.value.into_iter().map(RawProject::into_ref));
        if got < PAGE_SIZE {
            break;
        }
        skip += got;
    }

    // Stable alphabetical so the dropdown order survives refreshes.
    out.sort_by_key(|p| p.name.to_lowercase());
    Ok(out)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawProject {
    id: String,
    name: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    visibility: Option<String>,
}

impl RawProject {
    fn into_ref(self) -> ProjectRef {
        ProjectRef {
            id: self.id,
            name: self.name,
            description: self.description,
            state: self.state,
            visibility: self.visibility,
        }
    }
}

/// People who can be assigned a bug. We use the project's DEFAULT team as the
/// "who's on this project" list — it covers the common case without
/// enumerating every team. Two calls: the project (for its default-team id +
/// project id) then that team's members. Returns deduped, name-sorted members.
pub async fn list_team_members(state: &AdoState) -> AdoResult<Vec<TeamMember>> {
    let (conn, _) = state.snapshot();
    let conn = conn.ok_or(AdoError::NotConfigured)?;

    let proj_url = org_api(&conn, &format!("projects/{}", urlencoded(&conn.project)));
    let project: RawProjectDetail = get_json(state, &proj_url, "project").await?;
    let Some(team) = project.default_team else {
        return Ok(Vec::new());
    };
    let members_url = org_api(
        &conn,
        &format!("projects/{}/teams/{}/members?$top=500", project.id, team.id),
    );
    let page: PagedResponse<RawTeamMember> =
        get_json(state, &members_url, "team members").await?;

    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<TeamMember> = Vec::new();
    for row in page.value {
        let unique = row.identity.unique_name.unwrap_or_default();
        let display = row
            .identity
            .display_name
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| unique.clone());
        if unique.is_empty() && display.is_empty() {
            continue;
        }
        let key = if unique.is_empty() {
            display.clone()
        } else {
            unique.clone()
        };
        if seen.insert(key) {
            out.push(TeamMember {
                display_name: display,
                unique_name: unique,
            });
        }
    }
    out.sort_by(|a, b| a.display_name.to_lowercase().cmp(&b.display_name.to_lowercase()));
    Ok(out)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawProjectDetail {
    id: String,
    #[serde(default)]
    default_team: Option<RawTeamRef>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawTeamRef {
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawTeamMember {
    identity: RawIdentity,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawIdentity {
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    unique_name: Option<String>,
}

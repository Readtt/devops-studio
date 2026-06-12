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
use super::types::{Connection, PagedResponse, ProjectRef, TeamMember};
use futures_util::stream::{self, StreamExt};
use serde::Deserialize;

const PAGE_SIZE: usize = 500;
/// How many teams' member lists to fetch at once. Bounded so a project with
/// dozens of teams populates fast without hammering ADO into a 429.
const TEAM_FETCH_CONCURRENCY: usize = 8;

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

/// People who can be assigned a bug or case. ADO's own assign dropdown suggests
/// anyone with project access, so the DEFAULT team alone (the old behaviour)
/// missed everyone on other teams. We enumerate every team in the project and
/// union their members — paged, deduped, and name-sorted. Per-team failures are
/// non-fatal so one unreadable team can't empty the picker.
pub async fn list_team_members(state: &AdoState) -> AdoResult<Vec<TeamMember>> {
    let (conn, _) = state.snapshot();
    let conn = conn.ok_or(AdoError::NotConfigured)?;

    let proj_url = org_api(&conn, &format!("projects/{}", urlencoded(&conn.project)));
    let project: RawProjectDetail = get_json(state, &proj_url, "project").await?;
    let project_id = project.id.clone();

    // Swallow a teams-endpoint failure (e.g. a PAT that can't read org teams) to
    // an empty list so we still fall back to the default team below instead of
    // failing the whole picker.
    let mut team_ids = list_project_team_ids(state, &conn, &project_id)
        .await
        .unwrap_or_else(|e| {
            log::warn!("list project teams failed, falling back to default team: {e}");
            Vec::new()
        });
    // Degrade to the default team if the project exposes no teams to this PAT.
    if team_ids.is_empty() {
        if let Some(team) = project.default_team {
            team_ids.push(team.id);
        }
    }

    // Fetch each team's members concurrently (bounded) — a project can have
    // dozens of teams and serial fetches would make the picker slow to fill.
    // Iterate OWNED team ids (not `.iter()`): a borrowed `&String` flowing into
    // the async closure trips a higher-ranked-lifetime error in buffer_unordered.
    let per_team: Vec<Vec<RawTeamMember>> = stream::iter(team_ids)
        .map(|team_id| members_or_empty(state, &conn, &project_id, team_id))
        .buffer_unordered(TEAM_FETCH_CONCURRENCY)
        .collect()
        .await;

    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<TeamMember> = Vec::new();
    for rows in per_team {
        for row in rows {
            // ADO nests groups/sub-teams inside a team's membership (flagged
            // `isContainer`). They aren't assignable people — a work item's
            // Assigned To wants a user identity, not a `vstfs:///Classification`
            // group descriptor — so keep them out of the developer picker.
            if row.identity.is_container.unwrap_or(false) {
                continue;
            }
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
    }
    out.sort_by(|a, b| a.display_name.to_lowercase().cmp(&b.display_name.to_lowercase()));
    Ok(out)
}

/// Every team id in the project (`$mine=false` ⇒ all teams the PAT can read,
/// not just the caller's), following `$skip` paging.
async fn list_project_team_ids(
    state: &AdoState,
    conn: &Connection,
    project_id: &str,
) -> AdoResult<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    let mut skip = 0usize;
    loop {
        let url = org_api(
            conn,
            &format!("projects/{project_id}/teams?$mine=false&$top={PAGE_SIZE}&$skip={skip}"),
        );
        let page: PagedResponse<RawTeam> = get_json(state, &url, "project teams").await?;
        let got = page.value.len();
        out.extend(page.value.into_iter().map(|t| t.id));
        if got < PAGE_SIZE {
            break;
        }
        skip += got;
    }
    Ok(out)
}

/// One team's members, paged. Errors are swallowed to an empty vec (logged) so
/// a single team the PAT can't read doesn't sink the whole union.
async fn members_or_empty(
    state: &AdoState,
    conn: &Connection,
    project_id: &str,
    team_id: String,
) -> Vec<RawTeamMember> {
    let mut out: Vec<RawTeamMember> = Vec::new();
    let mut skip = 0usize;
    loop {
        let url = org_api(
            conn,
            &format!("projects/{project_id}/teams/{team_id}/members?$top={PAGE_SIZE}&$skip={skip}"),
        );
        match get_json::<PagedResponse<RawTeamMember>>(state, &url, "team members").await {
            Ok(page) => {
                let got = page.value.len();
                out.extend(page.value);
                if got < PAGE_SIZE {
                    break;
                }
                skip += got;
            }
            Err(e) => {
                log::warn!("team {team_id} members unreadable, skipping: {e}");
                break;
            }
        }
    }
    out
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
struct RawTeam {
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
    /// `true` for ADO groups/teams that appear as nested team members. We drop
    /// these — only real users are assignable.
    #[serde(default)]
    is_container: Option<bool>,
}

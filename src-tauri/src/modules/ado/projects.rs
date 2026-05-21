//! Org-level project listing.
//!
//! `GET {org}/_apis/projects` returns every project the PAT can see. We use
//! it to populate the Project dropdown in Settings — replacing the old
//! free-text input where typos silently broke later API calls.
//!
//! ADO's projects endpoint is paged; we follow with `$skip` until the
//! returned page is shorter than the page size. In practice an org rarely
//! has more than a couple hundred projects, so this resolves in one call.

use super::client::{get_json, org_api, AdoState};
use super::errors::{AdoError, AdoResult};
use super::types::{PagedResponse, ProjectRef};
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

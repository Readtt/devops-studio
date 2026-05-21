//! Connection test + identity probe.
//!
//! Hardened against the failure mode where the user pastes a garbage org slug
//! and Azure happily 200s with `{"value":[]}` — both probes (projects AND
//! connectionData) must succeed for the test to report Connected.
//!
//! - `/_apis/projects?$top=1` requires the PAT to have Project+Team:Read,
//!   which is the bare minimum we need elsewhere. A bad org or rejected PAT
//!   gets caught here.
//! - `/_apis/connectionData` is the canonical "this is really an ADO org"
//!   handshake — its response includes `instanceId` and `authenticatedUser`
//!   for a real org. We tolerate it returning HTML or 401 in case the PAT
//!   lacks the (very common) vso.profile scope, but only after projects has
//!   surfaced a real success.

use super::client::{get_json, org_api, AdoState};
use super::errors::AdoError;
use super::types::{ConnectionData, PagedResponse, TestConnectionResult};

pub async fn test_connection(state: &AdoState) -> TestConnectionResult {
    let (conn, pat) = state.snapshot();
    let Some(conn) = conn else {
        return TestConnectionResult {
            ok: false,
            identity_name: None,
            error: Some(AdoError::NotConfigured),
        };
    };
    if pat.is_none() {
        return TestConnectionResult {
            ok: false,
            identity_name: None,
            error: Some(AdoError::NotConfigured),
        };
    }

    // 1. Primary probe — projects list. Catches bad PAT (401), bad scope
    //    (403), and the common HTML sign-in response from non-existent orgs.
    let probe_url = org_api(&conn, "projects?$top=1");
    if let Err(e) =
        get_json::<PagedResponse<serde_json::Value>>(state, &probe_url, "projects").await
    {
        return TestConnectionResult {
            ok: false,
            identity_name: None,
            error: Some(e),
        };
    }

    // 2. Confirm we're actually talking to an Azure DevOps server (and not a
    //    cached CDN page or a wildcard tenant that swallows `/_apis/projects`
    //    with an empty value array). Real orgs include an `instanceId` and
    //    an `authenticatedUser` in connectionData.
    //
    //    If this call fails with HTML/SSO, we treat that as a PAT-scope issue
    //    rather than a missing org — projects already passed, which requires
    //    the org to exist. If it succeeds but `instanceId` is missing, we
    //    treat the connection as suspect and report it.
    let identity_url = org_api(&conn, "connectionData");
    let identity_name = match get_json::<ConnectionData>(state, &identity_url, "connectionData")
        .await
    {
        Ok(d) => {
            if d.instance_id.as_deref().unwrap_or("").is_empty() {
                return TestConnectionResult {
                    ok: false,
                    identity_name: None,
                    error: Some(AdoError::BadPat {
                        reason:
                            "Azure DevOps responded but didn't return an instanceId — \
                             the URL doesn't look like a real ADO org."
                                .into(),
                    }),
                };
            }
            d.authenticated_user
                .and_then(|u| u.display_name.or(u.unique_name).or(u.provider_display_name))
        }
        Err(AdoError::SsoRequired) => None, // probably vso.profile missing — non-fatal
        Err(_) => None,
    };

    TestConnectionResult {
        ok: true,
        identity_name,
        error: None,
    }
}


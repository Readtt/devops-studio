//! Connection test + best-effort identity probe.
//!
//! Don't use `/_apis/connectionData` as the primary probe: it requires the
//! `vso.profile` scope (which we don't otherwise need) and some Entra-backed
//! orgs serve HTML to PATs that lack it — `is_sso_html` then misreports the
//! perfectly-valid PAT as SSO-blocked. The microsoft/azure-devops-mcp client
//! sidesteps this by never calling connectionData at all.
//!
//! Instead: probe `/_apis/projects?$top=1`. Any PAT with the scopes the rest
//! of the app already needs (Project and Team - Read) can hit it, and it
//! returns clean JSON regardless of org SSO configuration.
//! Identity lookup is then attempted as a best-effort second call; failures
//! there don't fail the connection test.

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

    // Best-effort: fetch the display name. Quietly omit on failure — the
    // connection is already verified.
    let identity_url = org_api(&conn, "connectionData");
    let identity_name = get_json::<ConnectionData>(state, &identity_url, "connectionData")
        .await
        .ok()
        .and_then(|d| d.authenticated_user)
        .and_then(|u| u.display_name.or(u.unique_name).or(u.provider_display_name));

    TestConnectionResult {
        ok: true,
        identity_name,
        error: None,
    }
}


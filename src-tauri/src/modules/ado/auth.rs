//! Identity probe + connection test.
//!
//! `/_apis/connectionData` returns the signed-in user identity when the PAT
//! is valid. It's also where SSO-blocked PATs surface as HTML responses.

use super::client::{get_json, org_api, AdoState};
use super::errors::AdoError;
use super::types::{ConnectionData, TestConnectionResult};

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
    let url = org_api(&conn, "connectionData");
    match get_json::<ConnectionData>(state, &url, "connectionData").await {
        Ok(data) => {
            let name = data
                .authenticated_user
                .and_then(|u| u.display_name.or(u.unique_name).or(u.provider_display_name));
            TestConnectionResult {
                ok: true,
                identity_name: name,
                error: None,
            }
        }
        Err(e) => TestConnectionResult {
            ok: false,
            identity_name: None,
            error: Some(e),
        },
    }
}


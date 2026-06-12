//! HTTPS client + connection state for Azure DevOps REST.
//!
//! - Single shared `reqwest::Client` cached as Tauri State.
//! - Auth via `Authorization: Basic ` + base64(":" + PAT) — ADO's only auth
//!   mode that works with PATs.
//! - SSO-blocked PATs are detected by the response body being HTML (instead
//!   of JSON) on a 200/203 — see `is_sso_html`.

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use reqwest::{Client, Response, StatusCode};
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::sync::RwLock;
use std::time::Duration;

use super::errors::{AdoError, AdoResult};
use super::types::Connection;

const KEYRING_SERVICE: &str = "devops-studio";
const PAT_ACCOUNT: &str = "ado.pat";
const API_VERSION: &str = "7.1";

/// Tauri State — holds the connection metadata + shared HTTP client.
#[derive(Default)]
pub struct AdoState {
    pub conn: RwLock<Option<Connection>>,
    pub pat: RwLock<Option<String>>,
    http: RwLock<Option<Client>>,
}

impl AdoState {
    pub fn snapshot(&self) -> (Option<Connection>, Option<String>) {
        let c = self.conn.read().ok().and_then(|g| g.clone());
        let p = self.pat.read().ok().and_then(|g| g.clone());
        (c, p)
    }

    pub fn set_connection(&self, conn: Connection, pat: Option<String>) {
        if let Ok(mut g) = self.conn.write() {
            *g = Some(conn);
        }
        if let Some(p) = pat {
            if let Ok(mut g) = self.pat.write() {
                *g = Some(p);
            }
        }
    }

    pub fn clear_pat(&self) {
        if let Ok(mut g) = self.pat.write() {
            *g = None;
        }
    }

    pub fn http(&self) -> Client {
        if let Some(c) = self.http.read().ok().and_then(|g| g.clone()) {
            return c;
        }
        let c = Client::builder()
            .user_agent("DevOpsStudio/0.1.0")
            .timeout(Duration::from_secs(30))
            .build()
            .expect("reqwest client build");
        if let Ok(mut g) = self.http.write() {
            *g = Some(c.clone());
        }
        c
    }
}

pub fn keyring_service() -> &'static str {
    KEYRING_SERVICE
}

pub fn pat_account() -> &'static str {
    PAT_ACCOUNT
}

/// Build the per-request Authorization header value.
pub fn auth_header(pat: &str) -> String {
    format!("Basic {}", B64.encode(format!(":{pat}")))
}

/// Normalize org URL into the canonical `https://dev.azure.com/{org}` form.
///
/// Accepts whatever the user pastes — bare slug, legacy `*.visualstudio.com`,
/// or modern `dev.azure.com/{org}` (with or without scheme, with or without
/// trailing path). Always rewrites to `dev.azure.com` because legacy hosts
/// 30x to it and `reqwest` strips the `Authorization` header on cross-host
/// redirects — anonymous follow-ups get HTML sign-in pages, which the client
/// (correctly, in isolation) reads as `SsoRequired`.
pub fn normalize_org_url(s: &str) -> String {
    let trimmed = s.trim().trim_matches('/');
    if trimmed.is_empty() {
        return String::new();
    }

    // Strip scheme (if any) so we can inspect the host uniformly.
    let lower_full = trimmed.to_ascii_lowercase();
    let (had_scheme, no_scheme_lower) = if let Some(rest) = lower_full.strip_prefix("https://") {
        (true, rest)
    } else if let Some(rest) = lower_full.strip_prefix("http://") {
        (true, rest)
    } else {
        (false, lower_full.as_str())
    };

    // Modern: dev.azure.com/{org}[/...]
    if let Some(rest) = no_scheme_lower.strip_prefix("dev.azure.com/") {
        let org = rest.split('/').next().unwrap_or("").trim();
        if !org.is_empty() {
            return format!("https://dev.azure.com/{org}");
        }
    }

    // Legacy: {org}.visualstudio.com[/...]
    if let Some(host) = no_scheme_lower.split('/').next() {
        if let Some(org) = host.strip_suffix(".visualstudio.com") {
            if !org.is_empty() {
                return format!("https://dev.azure.com/{org}");
            }
        }
    }

    // Bare slug (user typed nothing scheme-like) — must be a valid org name:
    // alphanumeric, hyphens, underscores only. No ports, paths, or dots.
    if !had_scheme
        && no_scheme_lower
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return format!("https://dev.azure.com/{no_scheme_lower}");
    }

    // Anything else (custom on-prem TFS, localhost, etc.): preserve as given.
    if had_scheme {
        return trimmed.to_string();
    }
    format!("https://{trimmed}")
}

#[cfg(test)]
#[allow(clippy::items_after_test_module)]
mod url_tests {
    use super::*;

    #[test]
    fn canonicalizes_modern_url() {
        assert_eq!(normalize_org_url("https://dev.azure.com/myorg"), "https://dev.azure.com/myorg");
        assert_eq!(normalize_org_url("https://dev.azure.com/myorg/"), "https://dev.azure.com/myorg");
        assert_eq!(normalize_org_url("dev.azure.com/myorg"), "https://dev.azure.com/myorg");
    }

    #[test]
    fn rewrites_legacy_visualstudio_to_dev_azure() {
        assert_eq!(normalize_org_url("https://contoso.visualstudio.com"), "https://dev.azure.com/contoso");
        assert_eq!(normalize_org_url("https://contoso.visualstudio.com/"), "https://dev.azure.com/contoso");
        assert_eq!(normalize_org_url("contoso.visualstudio.com"), "https://dev.azure.com/contoso");
        assert_eq!(normalize_org_url("Contoso.VisualStudio.com"), "https://dev.azure.com/contoso");
    }

    #[test]
    fn accepts_bare_org_slug() {
        assert_eq!(normalize_org_url("contoso"), "https://dev.azure.com/contoso");
        assert_eq!(normalize_org_url("  myorg  "), "https://dev.azure.com/myorg");
    }

    #[test]
    fn strips_trailing_path_segments() {
        assert_eq!(normalize_org_url("https://dev.azure.com/myorg/SomeProject"), "https://dev.azure.com/myorg");
        assert_eq!(normalize_org_url("https://contoso.visualstudio.com/SomeProject"), "https://dev.azure.com/contoso");
    }

    #[test]
    fn passes_through_unknown_hosts() {
        assert_eq!(normalize_org_url("http://localhost:8080"), "http://localhost:8080");
        assert_eq!(normalize_org_url("https://tfs.internal/tfs/DefaultCollection"), "https://tfs.internal/tfs/DefaultCollection");
    }

    #[test]
    fn empty_stays_empty() {
        assert_eq!(normalize_org_url(""), "");
        assert_eq!(normalize_org_url("   "), "");
    }
}

/// Build a base URL `{org_url}/{project}/_apis/{path}?api-version={version}`.
pub fn project_api(conn: &Connection, path: &str) -> String {
    let p = path.trim_start_matches('/');
    let sep = if p.contains('?') { "&" } else { "?" };
    format!(
        "{org}/{proj}/_apis/{path}{sep}api-version={ver}",
        org = conn.org_url.trim_end_matches('/'),
        proj = urlencoded(&conn.project),
        path = p,
        sep = sep,
        ver = API_VERSION
    )
}

/// Build an org-level URL `{org_url}/_apis/{path}?api-version={version}` (e.g. connectionData).
pub fn org_api(conn: &Connection, path: &str) -> String {
    let p = path.trim_start_matches('/');
    let sep = if p.contains('?') { "&" } else { "?" };
    format!(
        "{org}/_apis/{path}{sep}api-version={ver}",
        org = conn.org_url.trim_end_matches('/'),
        path = p,
        sep = sep,
        ver = API_VERSION
    )
}

/// Percent-encode a single URL path segment. ADO project names commonly
/// contain spaces, which `form_urlencoded` would (wrongly) turn into `+`.
/// We RFC-3986-encode anything that isn't an unreserved character or a path
/// sub-delim that's safe inside a segment.
pub(crate) fn urlencoded(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        let c = *b;
        let unreserved = c.is_ascii_alphanumeric()
            || c == b'-'
            || c == b'_'
            || c == b'.'
            || c == b'~';
        if unreserved {
            out.push(c as char);
        } else {
            out.push_str(&format!("%{:02X}", c));
        }
    }
    out
}

/// Issue an authenticated GET. On 2xx, parse as JSON. Otherwise map to AdoError.
pub async fn get_json<T: DeserializeOwned>(
    state: &AdoState,
    url: &str,
    resource_label: &str,
) -> AdoResult<T> {
    let (conn, pat) = state.snapshot();
    let _conn = conn.ok_or(AdoError::NotConfigured)?;
    let pat = pat.ok_or(AdoError::NotConfigured)?;

    let resp = state
        .http()
        .get(url)
        .header(reqwest::header::AUTHORIZATION, auth_header(&pat))
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|e| network_with_url(e, url))?;
    handle_response(resp, resource_label).await
}

/// POST JSON. On 2xx parse response JSON as T.
pub async fn post_json<B: serde::Serialize, T: DeserializeOwned>(
    state: &AdoState,
    url: &str,
    body: &B,
    content_type: &str,
    resource_label: &str,
) -> AdoResult<T> {
    let (_, pat) = state.snapshot();
    let pat = pat.ok_or(AdoError::NotConfigured)?;
    let resp = state
        .http()
        .post(url)
        .header(reqwest::header::AUTHORIZATION, auth_header(&pat))
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::CONTENT_TYPE, content_type)
        .body(serde_json::to_vec(body).map_err(AdoError::local)?)
        .send()
        .await
        .map_err(|e| network_with_url(e, url))?;
    handle_response(resp, resource_label).await
}

/// PATCH with a JSON Patch body (content-type application/json-patch+json).
pub async fn patch_json_patch<B: serde::Serialize, T: DeserializeOwned>(
    state: &AdoState,
    url: &str,
    body: &B,
    resource_label: &str,
) -> AdoResult<T> {
    let (_, pat) = state.snapshot();
    let pat = pat.ok_or(AdoError::NotConfigured)?;
    let resp = state
        .http()
        .patch(url)
        .header(reqwest::header::AUTHORIZATION, auth_header(&pat))
        .header(reqwest::header::ACCEPT, "application/json")
        .header(
            reqwest::header::CONTENT_TYPE,
            "application/json-patch+json",
        )
        .body(serde_json::to_vec(body).map_err(AdoError::local)?)
        .send()
        .await
        .map_err(|e| network_with_url(e, url))?;
    handle_response(resp, resource_label).await
}

/// PATCH with a plain application/json body. Some ADO endpoints (testplan
/// suite updates, for example) expect a regular partial-update payload
/// rather than the JSON Patch envelope.
pub async fn patch_json<B: serde::Serialize, T: DeserializeOwned>(
    state: &AdoState,
    url: &str,
    body: &B,
    resource_label: &str,
) -> AdoResult<T> {
    let (_, pat) = state.snapshot();
    let pat = pat.ok_or(AdoError::NotConfigured)?;
    let resp = state
        .http()
        .patch(url)
        .header(reqwest::header::AUTHORIZATION, auth_header(&pat))
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(serde_json::to_vec(body).map_err(AdoError::local)?)
        .send()
        .await
        .map_err(|e| network_with_url(e, url))?;
    handle_response(resp, resource_label).await
}

/// DELETE a URL and ignore the response body. Used for ADO work-item
/// deletes (recycle-bin or destroy=true) where the response is either
/// a 204 No Content or a JSON document we don't care about.
pub async fn delete_request(
    state: &AdoState,
    url: &str,
    resource_label: &str,
) -> AdoResult<()> {
    let (_, pat) = state.snapshot();
    let pat = pat.ok_or(AdoError::NotConfigured)?;
    let resp = state
        .http()
        .delete(url)
        .header(reqwest::header::AUTHORIZATION, auth_header(&pat))
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|e| network_with_url(e, url))?;
    let _: serde_json::Value = handle_response(resp, resource_label).await?;
    Ok(())
}

/// Wrap a reqwest error with the URL we tried so the user can diagnose
/// builder/DNS/timeout failures from the UI instead of guessing.
fn network_with_url(e: reqwest::Error, url: &str) -> AdoError {
    let kind = if e.is_builder() {
        "builder"
    } else if e.is_timeout() {
        "timeout"
    } else if e.is_connect() {
        "connect"
    } else if e.is_request() {
        "request"
    } else {
        "other"
    };
    AdoError::Network {
        message: format!("{kind}: {e}  (url: {url})"),
    }
}

async fn handle_response<T: DeserializeOwned>(
    resp: Response,
    resource_label: &str,
) -> AdoResult<T> {
    let status = resp.status();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    // Retry-After is an HTTP header on a 429, not part of the body. Capture it
    // before consuming the body so a rate-limited caller backs off for the
    // server-specified window instead of a hardcoded default.
    let retry_after = resp
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.trim().parse::<u32>().ok());
    let body = resp.text().await.map_err(AdoError::network)?;

    // SSO probe: ADO returns 203 with HTML when the PAT is valid for the
    // org but hasn't been authorized through SSO. Detect any HTML response
    // even on 2xx — it's never the right content for our endpoints.
    if is_sso_html(&content_type, &body) {
        return Err(AdoError::SsoRequired);
    }

    if status.is_success() {
        // Some endpoints return empty bodies on success — make that explicit
        // for the caller via JSON null parsing.
        let text = if body.is_empty() { "null".to_string() } else { body };
        return serde_json::from_str::<T>(&text).map_err(|e| AdoError::Local {
            message: format!("response parse: {e} — body: {}", excerpt(&text)),
        });
    }

    Err(map_error_status(status, resource_label, &body, retry_after))
}

fn is_sso_html(content_type: &str, body: &str) -> bool {
    let ct = content_type.to_lowercase();
    if ct.contains("text/html") {
        return true;
    }
    let trimmed = body.trim_start();
    let lower = trimmed.to_ascii_lowercase();
    lower.starts_with("<!doctype") || lower.starts_with("<html")
}

fn map_error_status(
    status: StatusCode,
    resource: &str,
    body: &str,
    retry_after: Option<u32>,
) -> AdoError {
    match status.as_u16() {
        401 => AdoError::BadPat {
            reason: "PAT was rejected by Azure DevOps (401).".into(),
        },
        403 => AdoError::forbidden(resource),
        404 => AdoError::not_found(resource),
        429 => AdoError::RateLimited {
            retry_after_s: retry_after.unwrap_or(30),
        },
        s => AdoError::Server {
            status: s,
            body_excerpt: excerpt(body),
        },
    }
}

fn excerpt(s: &str) -> String {
    if s.len() <= 500 {
        s.to_string()
    } else {
        let mut t = s[..500].to_string();
        t.push('…');
        t
    }
}

/// Parse arbitrary JSON into a serde Value for callers that don't have a typed schema.
pub async fn get_raw_json(state: &AdoState, url: &str, resource_label: &str) -> AdoResult<Value> {
    get_json::<Value>(state, url, resource_label).await
}

/// One page of a list endpoint, plus the ADO continuation token (if the server
/// signalled more results via the `x-ms-continuationtoken` response header).
async fn get_value_page(
    state: &AdoState,
    url: &str,
    continuation: Option<&str>,
    resource_label: &str,
) -> AdoResult<(Value, Option<String>)> {
    let (conn, pat) = state.snapshot();
    let _conn = conn.ok_or(AdoError::NotConfigured)?;
    let pat = pat.ok_or(AdoError::NotConfigured)?;

    let mut req = state
        .http()
        .get(url)
        .header(reqwest::header::AUTHORIZATION, auth_header(&pat))
        .header(reqwest::header::ACCEPT, "application/json");
    if let Some(token) = continuation {
        // `.query` merges with any existing query string and handles encoding.
        req = req.query(&[("continuationToken", token)]);
    }
    let resp = req.send().await.map_err(|e| network_with_url(e, url))?;
    let token = resp
        .headers()
        .get("x-ms-continuationtoken")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let value: Value = handle_response(resp, resource_label).await?;
    Ok((value, token))
}

/// Fetch every page of a list endpoint, following ADO continuation tokens, and
/// return the concatenated `value` rows.
///
/// Safe by construction: if the endpoint sends no `x-ms-continuationtoken`
/// header (the common small-result case) this makes exactly one request and
/// returns the same rows the old single-GET did — no behavior change. The
/// MAX_PAGES cap guarantees a misbehaving token can never loop forever.
pub async fn get_all_value_rows(
    state: &AdoState,
    url: &str,
    resource_label: &str,
) -> AdoResult<Vec<Value>> {
    const MAX_PAGES: usize = 50;
    let mut rows: Vec<Value> = Vec::new();
    let mut continuation: Option<String> = None;
    for _ in 0..MAX_PAGES {
        let (value, next) =
            get_value_page(state, url, continuation.as_deref(), resource_label).await?;
        if let Some(arr) = value.get("value").and_then(|v| v.as_array()) {
            rows.extend(arr.iter().cloned());
        }
        match next {
            Some(t) if !t.is_empty() => continuation = Some(t),
            _ => return Ok(rows),
        }
    }
    log::warn!(
        "{resource_label}: hit the {MAX_PAGES}-page pagination cap; some rows may not be loaded"
    );
    Ok(rows)
}

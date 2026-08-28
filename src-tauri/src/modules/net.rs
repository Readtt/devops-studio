use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use bytes::Bytes;
use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tokio::sync::Notify;

const HEADER_BLOCKLIST: &[&str] = &[
    "host",
    "content-length",
    "connection",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "transfer-encoding",
    "upgrade",
    "trailer",
    "expect",
];

fn is_blocked_host_name(host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    matches!(
        host.as_str(),
        "metadata.google.internal" | "metadata" | "metadata.azure.com"
    )
}

fn ip_kind(ip: IpAddr) -> IpKind {
    match ip {
        IpAddr::V4(v) => {
            let o = v.octets();
            // Cloud metadata IPv4: 169.254.169.254
            if v.is_link_local() {
                return IpKind::BlockedMetadata;
            }
            if v.is_loopback() || v.is_unspecified() || v.is_broadcast() || v.is_multicast() {
                return IpKind::Loopback;
            }
            // RFC1918 + CGNAT + benchmarking + IETF
            if o[0] == 10
                || (o[0] == 172 && (16..=31).contains(&o[1]))
                || (o[0] == 192 && o[1] == 168)
                || (o[0] == 100 && (64..=127).contains(&o[1]))
                || (o[0] == 198 && (o[1] == 18 || o[1] == 19))
            {
                return IpKind::Private;
            }
            IpKind::Public
        }
        IpAddr::V6(v) => {
            if v.is_loopback() || v.is_unspecified() || v.is_multicast() {
                return IpKind::Loopback;
            }
            // Cloud metadata IPv6 (AWS): fd00:ec2::254
            let segs = v.segments();
            if segs[0] == 0xfd00 && segs[1] == 0xec2 {
                return IpKind::BlockedMetadata;
            }
            // fe80::/10 link-local
            if segs[0] & 0xffc0 == 0xfe80 {
                return IpKind::BlockedMetadata;
            }
            // fc00::/7 unique-local (private)
            if segs[0] & 0xfe00 == 0xfc00 {
                return IpKind::Private;
            }
            IpKind::Public
        }
    }
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum IpKind {
    Public,
    Private,
    Loopback,
    BlockedMetadata,
}

/// Resolve `host` once and return both its safety classification and the
/// concrete IPs we resolved. Callers can pin reqwest to these IPs to defeat
/// DNS rebinding (where a second lookup returns a different address).
async fn resolve_and_classify(host: &str) -> Result<(IpKind, Vec<IpAddr>), String> {
    // Direct literal? Skip DNS.
    if let Ok(ip) = host.parse::<IpAddr>() {
        return Ok((ip_kind(ip), vec![ip]));
    }
    let host_owned = host.to_string();
    let lookup = tokio::task::spawn_blocking(move || {
        (host_owned.as_str(), 0u16)
            .to_socket_addrs()
            .map(|it| it.map(|a| a.ip()).collect::<Vec<_>>())
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("dns: {e}"))?;
    if lookup.is_empty() {
        return Err("dns: no addresses".into());
    }
    let mut worst = IpKind::Public;
    for ip in &lookup {
        let k = ip_kind(*ip);
        worst = match (worst, k) {
            (_, IpKind::BlockedMetadata) => IpKind::BlockedMetadata,
            (IpKind::BlockedMetadata, _) => IpKind::BlockedMetadata,
            (IpKind::Public, x) => x,
            (x, IpKind::Public) => x,
            (a, _) => a,
        };
    }
    Ok((worst, lookup))
}

use std::net::ToSocketAddrs;

fn validate_url(url: &str, allow_private: bool) -> Result<reqwest::Url, String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("invalid url: {e}"))?;
    match parsed.scheme() {
        "http" | "https" => {}
        s => return Err(format!("scheme not allowed: {s}")),
    }
    if parsed.username() != "" || parsed.password().is_some() {
        return Err("userinfo in url is not allowed".into());
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "missing host".to_string())?;
    if is_blocked_host_name(host) {
        return Err(format!("host not allowed: {host}"));
    }
    // The actual IP classification has to be async — caller does it.
    let _ = allow_private;
    Ok(parsed)
}

/// Classify the host AND return safe IPs to pin reqwest's resolver to.
/// Defeats DNS rebinding (second-lookup-returns-different-IP) by reusing
/// exactly the addresses that passed `ip_kind`.
async fn classify_and_collect_safe_ips(
    host: &str,
    allow_private: bool,
) -> Result<Vec<IpAddr>, String> {
    let (worst, ips) = resolve_and_classify(host).await?;
    match worst {
        IpKind::BlockedMetadata => return Err(format!("host not allowed: {host}")),
        IpKind::Loopback | IpKind::Private if !allow_private => {
            return Err(format!(
                "host {host} resolves to a private/loopback address; this endpoint requires explicit opt-in",
            ));
        }
        _ => {}
    }
    let safe: Vec<IpAddr> = ips
        .into_iter()
        .filter(|ip| match ip_kind(*ip) {
            IpKind::BlockedMetadata => false,
            IpKind::Loopback | IpKind::Private => allow_private,
            IpKind::Public => true,
        })
        .collect();
    if safe.is_empty() {
        return Err(format!("host {host}: no safe IPs"));
    }
    Ok(safe)
}

fn sanitize_headers(headers: Option<HashMap<String, String>>) -> Result<HeaderMap, String> {
    let mut map = HeaderMap::new();
    let Some(h) = headers else { return Ok(map) };
    for (k, v) in h {
        let lower = k.to_ascii_lowercase();
        if HEADER_BLOCKLIST.contains(&lower.as_str()) {
            return Err(format!("header not allowed: {k}"));
        }
        // CRLF injection: header value must not contain CR / LF / NUL.
        if v.as_bytes().iter().any(|b| matches!(b, 0 | b'\r' | b'\n')) {
            return Err(format!("header value contains control bytes: {k}"));
        }
        let name = HeaderName::from_bytes(k.as_bytes()).map_err(|e| e.to_string())?;
        let value = HeaderValue::from_str(&v).map_err(|e| e.to_string())?;
        map.insert(name, value);
    }
    Ok(map)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LmModelsResult {
    pub status: u16,
    pub models: Vec<String>,
    /// Set when the request completed but yielded no usable list — a 401, or a
    /// 200 in a shape we don't recognise. Not a transport failure; those are Err.
    pub error: Option<String>,
}

/// Model-list shapes differ per server: OpenAI nests under `data`, Ollama under
/// `models`, and some endpoints return a bare array of ids or objects.
fn extract_model_ids(v: &serde_json::Value) -> Vec<String> {
    let Some(arr) = v
        .get("data")
        .and_then(|d| d.as_array())
        .or_else(|| v.get("models").and_then(|m| m.as_array()))
        .or_else(|| v.as_array())
    else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|item| match item {
            serde_json::Value::String(s) => Some(s.clone()),
            _ => item
                .get("id")
                .or_else(|| item.get("name"))
                .and_then(|x| x.as_str())
                .map(str::to_string),
        })
        .filter(|s| !s.trim().is_empty())
        .collect()
}

#[tauri::command]
pub async fn lm_list_models(
    base_url: String,
    api_key: Option<String>,
) -> Result<LmModelsResult, String> {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("empty base url".into());
    }
    let probe = format!("{trimmed}/models");
    let parsed = validate_url(&probe, true)?;
    let host = parsed
        .host_str()
        .ok_or_else(|| "missing host".to_string())?
        .to_string();
    let safe_ips = classify_and_collect_safe_ips(&host, true).await?;

    // 30s, not the 5s a liveness probe would want: `/v1/models` is a
    // user-initiated one-shot, and a gateway that lazily builds its catalogue on
    // first hit can take far longer than a warm call suggests (one local proxy
    // measured 26s cold, ~1s after). At 5s the first open always timed out —
    // and because the abandoned request still warmed the server, the SECOND
    // open populated. That is the whole "open the dropdown twice" bug.
    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none());
    let addrs: Vec<SocketAddr> = safe_ips.iter().map(|ip| SocketAddr::new(*ip, 0)).collect();
    builder = builder.resolve_to_addrs(&host, &addrs);
    let client = builder.build().map_err(|e| e.to_string())?;

    let mut req = client.get(parsed);
    if let Some(key) = api_key.as_deref().map(str::trim).filter(|k| !k.is_empty()) {
        let mut value = HeaderValue::from_str(&format!("Bearer {key}"))
            .map_err(|_| "api key contains invalid characters".to_string())?;
        value.set_sensitive(true);
        req = req.header(reqwest::header::AUTHORIZATION, value);
    }

    let res = req.send().await.map_err(|e| e.to_string())?;
    let status = res.status().as_u16();
    let body = res.text().await.unwrap_or_default();
    let models = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .map(|v| extract_model_ids(&v))
        .unwrap_or_default();

    let error = if !models.is_empty() {
        None
    } else if status >= 400 {
        Some(format!("Server returned HTTP {status}."))
    } else {
        Some("This endpoint didn't return a model list.".to_string())
    };

    Ok(LmModelsResult {
        status,
        models,
        error,
    })
}
// AI HTTP proxy — bypasses webview CORS / Mixed-Content / PNA so local-network
// model servers (LM Studio, Ollama, vLLM) work in the production bundle.

fn build_request(
    client: &reqwest::Client,
    method: &str,
    url: reqwest::Url,
    headers: Option<HashMap<String, String>>,
    body: Option<Vec<u8>>,
) -> Result<reqwest::RequestBuilder, String> {
    let method = Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
    let mut req = client.request(method, url);
    let map = sanitize_headers(headers)?;
    req = req.headers(map);
    if let Some(b) = body {
        req = req.body(b);
    }
    Ok(req)
}

fn build_safe_client(
    allow_private: bool,
    pinned: &[(String, Vec<IpAddr>)],
) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10));
    // Pin reqwest's resolver to the IPs we just classified. Without this,
    // reqwest's own DNS lookup could return a different (private/metadata) IP
    // for the same hostname between classify and connect — classic DNS
    // rebinding attack. We pin port 0 because reqwest fills in the actual
    // port from the URL when wiring up the override map.
    for (host, ips) in pinned {
        let addrs: Vec<SocketAddr> = ips.iter().map(|ip| SocketAddr::new(*ip, 0)).collect();
        if !addrs.is_empty() {
            builder = builder.resolve_to_addrs(host, &addrs);
        }
    }
    builder
        .redirect(reqwest::redirect::Policy::custom(move |attempt| {
            if attempt.previous().len() > 10 {
                return attempt.error("too many redirects");
            }
            let next = attempt.url();
            match next.scheme() {
                "http" | "https" => {}
                _ => return attempt.stop(),
            }
            if next.username() != "" || next.password().is_some() {
                return attempt.stop();
            }
            let Some(host) = next.host_str() else {
                return attempt.stop();
            };
            if is_blocked_host_name(host) {
                return attempt.stop();
            }
            if let Ok(ip) = host.parse::<IpAddr>() {
                let k = ip_kind(ip);
                if k == IpKind::BlockedMetadata {
                    return attempt.stop();
                }
                if !allow_private && matches!(k, IpKind::Loopback | IpKind::Private) {
                    return attempt.stop();
                }
            } else if !allow_private {
                if let Some(prev) = attempt.previous().last() {
                    if prev.host_str() != Some(host) {
                        return attempt.stop();
                    }
                }
            }
            attempt.follow()
        }))
        .build()
        .map_err(|e| e.to_string())
}

fn header_map_to_strings(headers: &HeaderMap) -> HashMap<String, String> {
    let mut out = HashMap::with_capacity(headers.len());
    for (k, v) in headers {
        if let Ok(s) = v.to_str() {
            out.insert(k.as_str().to_ascii_lowercase(), s.to_string());
        }
    }
    out
}

// ai_http_request (the buffered, non-streaming variant) was removed — the
// AI proxy path went streaming-only (ai_http_stream) and the command had no
// remaining frontend callers.

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AiStreamEvent {
    Headers {
        status: u16,
        headers: HashMap<String, String>,
    },
    /// Body bytes as base64. A `Vec<u8>` would cross the IPC as a JSON array
    /// with one number per byte — at token-stream rates that parse cost lands
    /// on the webview main thread and freezes the UI during long runs.
    Chunk {
        data: String,
    },
    End,
    Error {
        message: String,
    },
}

/// Live stream cancellation. Aborting on the JS side can't reach a stream
/// that's mid-`bytes_stream()` — the channel keeps accepting sends — so the
/// frontend registers a request id and pokes `ai_http_stream_cancel` to make
/// the loop below bail out and drop the HTTP connection. Without this, a
/// cancelled AI generation keeps draining (and the provider keeps billing)
/// until the model finishes on its own.
fn cancel_registry() -> &'static Mutex<HashMap<u64, Arc<Notify>>> {
    static REG: OnceLock<Mutex<HashMap<u64, Arc<Notify>>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Ids whose cancel arrived BEFORE `ai_http_stream` registered its Notify — the
/// IPC for the stream and the cancel can interleave so the cancel finds no
/// entry. The stream consumes this the instant it registers (under the SAME
/// cancel_registry lock the cancel handler holds while inserting, so there's no
/// lost-cancel gap), making the cancel land on the first poll instead of
/// leaking a fully-drained — and billed — upstream request.
fn precancel_registry() -> &'static Mutex<HashSet<u64>> {
    static REG: OnceLock<Mutex<HashSet<u64>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Removes the registry entry when the stream ends by any path (natural end,
/// error, cancel) so ids never accumulate.
struct CancelGuard(Option<u64>);
impl Drop for CancelGuard {
    fn drop(&mut self) {
        if let Some(id) = self.0 {
            if let Ok(mut reg) = cancel_registry().lock() {
                reg.remove(&id);
            }
        }
    }
}

#[tauri::command]
pub fn ai_http_stream_cancel(request_id: u64) {
    if let Ok(reg) = cancel_registry().lock() {
        if let Some(n) = reg.get(&request_id) {
            // notify_one stores a permit if the stream loop isn't awaiting yet,
            // so a cancel that races ahead of the first select! still lands.
            n.notify_one();
        } else if let Ok(mut pre) = precancel_registry().lock() {
            // Cancel beat the stream's registration. Remember it (still holding
            // the cancel_registry lock, so the stream can't slip its
            // registration+check in between) — the stream will honor it the
            // moment it registers. Bounded so cancels whose stream never
            // arrives can't grow without limit.
            if pre.len() > 512 {
                pre.clear();
            }
            pre.insert(request_id);
        }
    }
}

#[tauri::command]
pub async fn ai_http_stream(
    url: String,
    method: String,
    headers: Option<HashMap<String, String>>,
    body: Option<String>,
    allow_private_network: Option<bool>,
    request_id: Option<u64>,
    on_event: Channel<AiStreamEvent>,
) -> Result<(), String> {
    let cancel = request_id.map(|id| {
        let notify = Arc::new(Notify::new());
        if let Ok(mut reg) = cancel_registry().lock() {
            reg.insert(id, notify.clone());
            // Consume any cancel that arrived before this registration — under
            // the same cancel_registry lock the cancel handler holds, so a
            // cancel can't land between our insert and this check. If one did,
            // notify now so the very first select! below bails immediately.
            if let Ok(mut pre) = precancel_registry().lock() {
                if pre.remove(&id) {
                    notify.notify_one();
                }
            }
        }
        notify
    });
    let _guard = CancelGuard(request_id);
    let allow_private = allow_private_network.unwrap_or(false);
    let parsed = match validate_url(&url, allow_private) {
        Ok(p) => p,
        Err(e) => {
            let _ = on_event.send(AiStreamEvent::Error { message: e.clone() });
            return Err(e);
        }
    };
    let host = match parsed.host_str() {
        Some(h) => h.to_string(),
        None => {
            let e = "missing host".to_string();
            let _ = on_event.send(AiStreamEvent::Error { message: e.clone() });
            return Err(e);
        }
    };
    let safe_ips = match classify_and_collect_safe_ips(&host, allow_private).await {
        Ok(v) => v,
        Err(e) => {
            let _ = on_event.send(AiStreamEvent::Error { message: e.clone() });
            return Err(e);
        }
    };

    // Body arrives base64-encoded (see AiStreamEvent::Chunk for why).
    let body = match body {
        Some(b64) => match B64.decode(b64) {
            Ok(bytes) => Some(bytes),
            Err(e) => {
                let msg = format!("invalid request body encoding: {e}");
                let _ = on_event.send(AiStreamEvent::Error {
                    message: msg.clone(),
                });
                return Err(msg);
            }
        },
        None => None,
    };

    let client = build_safe_client(allow_private, &[(host, safe_ips)])?;

    let req = build_request(&client, &method, parsed, headers, body)?;
    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            let _ = on_event.send(AiStreamEvent::Error {
                message: e.to_string(),
            });
            return Err(e.to_string());
        }
    };

    let status = resp.status().as_u16();
    let headers = header_map_to_strings(resp.headers());
    let _ = on_event.send(AiStreamEvent::Headers { status, headers });

    let mut stream = resp.bytes_stream();
    // Idle/read timeout. A connection that succeeds then stalls mid-body (dead
    // load balancer, provider hang, half-open TCP) would otherwise leave the
    // stream — and the surface's UI — hanging forever, with manual cancel the
    // only escape. This resets on every received chunk, so legitimately long
    // generations (slow first token, reasoning models) are unaffected; only a
    // genuinely silent connection trips it. A total .timeout() would be wrong
    // here — it would kill healthy long streams.
    const IDLE_TIMEOUT: Duration = Duration::from_secs(120);
    let stalled = || {
        let msg = "AI stream stalled — no data from the provider for 120s".to_string();
        let _ = on_event.send(AiStreamEvent::Error {
            message: msg.clone(),
        });
        msg
    };
    loop {
        let item = match &cancel {
            Some(notify) => {
                tokio::select! {
                    _ = notify.notified() => {
                        // Frontend aborted — dropping `stream`/`resp` closes the
                        // connection so the provider stops generating.
                        return Ok(());
                    }
                    r = tokio::time::timeout(IDLE_TIMEOUT, stream.next()) => match r {
                        Ok(item) => item,
                        Err(_) => return Err(stalled()),
                    },
                }
            }
            None => match tokio::time::timeout(IDLE_TIMEOUT, stream.next()).await {
                Ok(item) => item,
                Err(_) => return Err(stalled()),
            },
        };
        match item {
            None => break,
            Some(Ok(chunk)) => {
                let bytes: Bytes = chunk;
                let data = B64.encode(&bytes);
                if on_event.send(AiStreamEvent::Chunk { data }).is_err() {
                    // Channel dropped (frontend aborted) — stop streaming.
                    return Ok(());
                }
            }
            Some(Err(e)) => {
                let _ = on_event.send(AiStreamEvent::Error {
                    message: e.to_string(),
                });
                return Err(e.to_string());
            }
        }
    }

    let _ = on_event.send(AiStreamEvent::End);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;

    fn ids(json: &str) -> Vec<String> {
        extract_model_ids(&serde_json::from_str(json).unwrap())
    }

    #[test]
    fn reads_openai_data_shape() {
        assert_eq!(
            ids(r#"{"object":"list","data":[{"id":"gpt-4o"},{"id":"o3"}]}"#),
            vec!["gpt-4o", "o3"]
        );
    }

    #[test]
    fn reads_ollama_models_shape() {
        // Ollama names the field `name`; some builds emit `model` + `name`.
        assert_eq!(
            ids(r#"{"models":[{"name":"qwen2.5-coder:7b"},{"id":"llama3:8b"}]}"#),
            vec!["qwen2.5-coder:7b", "llama3:8b"]
        );
    }

    #[test]
    fn reads_bare_arrays_of_strings_and_objects() {
        assert_eq!(ids(r#"["a","b"]"#), vec!["a", "b"]);
        assert_eq!(ids(r#"[{"id":"a"},{"name":"b"}]"#), vec!["a", "b"]);
    }

    #[test]
    fn data_wins_over_models_when_both_present() {
        assert_eq!(
            ids(r#"{"data":[{"id":"from-data"}],"models":[{"id":"from-models"}]}"#),
            vec!["from-data"]
        );
    }

    #[test]
    fn unrecognised_shapes_yield_nothing_rather_than_erroring() {
        assert!(ids(r#"{"error":{"message":"unauthorized"}}"#).is_empty());
        assert!(ids(r#"{"data":[{"nope":1}]}"#).is_empty());
        assert!(ids(r#"{"data":[{"id":"  "}]}"#).is_empty());
        assert!(ids("42").is_empty());
    }

    #[test]
    fn metadata_ips_classified_as_blocked() {
        // AWS / Google / Azure all share the IPv4 169.254.169.254 link-local.
        assert_eq!(
            ip_kind(IpAddr::V4(Ipv4Addr::new(169, 254, 169, 254))),
            IpKind::BlockedMetadata
        );
        // AWS IPv6 metadata
        assert_eq!(
            ip_kind("fd00:ec2::254".parse().unwrap()),
            IpKind::BlockedMetadata
        );
        // Any link-local IPv4 (169.254/16) — same network range, still blocked.
        assert_eq!(
            ip_kind(IpAddr::V4(Ipv4Addr::new(169, 254, 1, 1))),
            IpKind::BlockedMetadata
        );
        // IPv6 link-local fe80::/10
        assert_eq!(
            ip_kind("fe80::1".parse().unwrap()),
            IpKind::BlockedMetadata
        );
    }

    #[test]
    fn private_ips_classified_correctly() {
        assert_eq!(
            ip_kind(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1))),
            IpKind::Private
        );
        assert_eq!(
            ip_kind(IpAddr::V4(Ipv4Addr::new(172, 16, 0, 1))),
            IpKind::Private
        );
        assert_eq!(
            ip_kind(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 1))),
            IpKind::Private
        );
        // CGNAT 100.64/10
        assert_eq!(
            ip_kind(IpAddr::V4(Ipv4Addr::new(100, 64, 0, 1))),
            IpKind::Private
        );
    }

    #[test]
    fn loopback_classified_as_loopback() {
        assert_eq!(
            ip_kind(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1))),
            IpKind::Loopback
        );
        assert_eq!(ip_kind("::1".parse().unwrap()), IpKind::Loopback);
    }

    #[test]
    fn public_ips_classified_as_public() {
        assert_eq!(
            ip_kind(IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))),
            IpKind::Public
        );
        assert_eq!(
            ip_kind(IpAddr::V4(Ipv4Addr::new(1, 1, 1, 1))),
            IpKind::Public
        );
    }

    #[test]
    fn validate_url_blocks_userinfo_and_metadata_hostnames() {
        // URLs with userinfo can confuse browsers / leak creds in redirects.
        assert!(validate_url("http://user:pass@example.com/", true).is_err());
        // Cloud metadata-by-name.
        assert!(validate_url("http://metadata.google.internal/", true).is_err());
        assert!(validate_url("http://metadata/", true).is_err());
        assert!(validate_url("http://metadata.azure.com/", true).is_err());
    }

    #[test]
    fn validate_url_rejects_non_http_schemes() {
        assert!(validate_url("ftp://example.com/", true).is_err());
        assert!(validate_url("file:///etc/passwd", true).is_err());
        assert!(validate_url("javascript:alert(1)", true).is_err());
    }

    #[test]
    fn sanitize_headers_blocks_crlf_injection() {
        let mut h = HashMap::new();
        h.insert("X-Foo".to_string(), "bar\r\nX-Evil: yes".to_string());
        assert!(sanitize_headers(Some(h)).is_err());
    }

    #[test]
    fn sanitize_headers_blocks_hop_by_hop_headers() {
        for hop in [
            "host",
            "content-length",
            "connection",
            "proxy-authorization",
        ] {
            let mut h = HashMap::new();
            h.insert(hop.to_string(), "value".to_string());
            assert!(
                sanitize_headers(Some(h)).is_err(),
                "expected {hop} to be rejected"
            );
        }
    }
}

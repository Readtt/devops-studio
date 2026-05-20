//! Typed errors that the ADO Rust client surfaces to the frontend.
//!
//! Serialized as a tagged enum so the renderer can switch on `kind` and
//! present targeted UI (e.g. "your PAT looks SSO-blocked — click here").

use serde::Serialize;

#[derive(Debug, Serialize, Clone)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum AdoError {
    /// Settings (org/project/PAT) not yet configured.
    NotConfigured,
    /// 401 from ADO, or HTML response from connectionData (org enforces SSO).
    BadPat { reason: String },
    /// 203 with HTML body — the PAT exists but SSO isn't authorized on it.
    SsoRequired,
    /// 403 — PAT lacks the necessary scope or user lacks access to the resource.
    Forbidden { resource: String },
    /// 404 — resource not found (wrong project name, deleted item, etc).
    NotFound { resource: String },
    /// 429 — back off and retry.
    RateLimited { retry_after_s: u32 },
    /// Network failure (timeout, DNS, TLS).
    Network { message: String },
    /// Anything else from ADO. `body_excerpt` is the first ~500 chars of the
    /// response, useful for debugging unexpected errors.
    Server {
        status: u16,
        body_excerpt: String,
    },
    /// Local error before we even hit the wire (malformed input, etc).
    Local { message: String },
}

impl AdoError {
    pub fn network(e: impl std::fmt::Display) -> Self {
        Self::Network {
            message: e.to_string(),
        }
    }
    pub fn local(e: impl std::fmt::Display) -> Self {
        Self::Local {
            message: e.to_string(),
        }
    }
    pub fn not_found(resource: impl Into<String>) -> Self {
        Self::NotFound {
            resource: resource.into(),
        }
    }
    pub fn forbidden(resource: impl Into<String>) -> Self {
        Self::Forbidden {
            resource: resource.into(),
        }
    }
}

impl std::fmt::Display for AdoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotConfigured => write!(f, "Azure DevOps is not configured"),
            Self::BadPat { reason } => write!(f, "Invalid PAT: {reason}"),
            Self::SsoRequired => write!(f, "PAT exists but is not SSO-authorized"),
            Self::Forbidden { resource } => write!(f, "Access denied to {resource}"),
            Self::NotFound { resource } => write!(f, "Not found: {resource}"),
            Self::RateLimited { retry_after_s } => {
                write!(f, "Rate limited; retry after {retry_after_s}s")
            }
            Self::Network { message } => write!(f, "Network error: {message}"),
            Self::Server { status, body_excerpt } => {
                write!(f, "Server returned {status}: {body_excerpt}")
            }
            Self::Local { message } => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for AdoError {}

pub type AdoResult<T> = Result<T, AdoError>;

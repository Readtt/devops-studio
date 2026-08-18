//! Typed errors that the ADO Rust client surfaces to the frontend.
//!
//! Serialized as a tagged enum so the renderer can switch on `kind` and
//! present targeted UI (e.g. "your PAT looks SSO-blocked — click here").

use serde::Serialize;

// `rename_all` renames VARIANTS; `rename_all_fields` renames their fields. Both
// are load-bearing: the frontend switches on the kebab-case `kind` and then
// reads camelCase fields off the same object (`src/modules/ado/types.ts`).
// Without the second, a 429 reached the user as "retry in undefineds" and a 5xx
// dropped the body excerpt that says what ADO actually rejected.
#[derive(Debug, Serialize, Clone)]
#[serde(tag = "kind", rename_all = "kebab-case", rename_all_fields = "camelCase")]
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The frontend switches on `kind` and then reads the variant's FIELDS
    /// (`src/modules/ado/types.ts`). `rename_all` on an enum renames variants
    /// only — fields need `rename_all_fields`, and without it a 429 reached the
    /// UI as "Rate limited — retry in undefineds."
    #[test]
    fn variant_fields_are_camel_case_for_the_frontend() {
        let json = serde_json::to_value(AdoError::RateLimited { retry_after_s: 42 }).unwrap();
        assert_eq!(json["kind"], "rate-limited");
        assert_eq!(json["retryAfterS"], 42);

        let json = serde_json::to_value(AdoError::Server {
            status: 500,
            body_excerpt: "boom".into(),
        })
        .unwrap();
        assert_eq!(json["kind"], "server");
        assert_eq!(json["status"], 500);
        assert_eq!(json["bodyExcerpt"], "boom");
    }

    /// Single-word fields are unaffected by the casing rule, so the variants the
    /// UI branches on most keep their exact wire names.
    #[test]
    fn single_word_fields_keep_their_names() {
        let json = serde_json::to_value(AdoError::BadPat {
            reason: "nope".into(),
        })
        .unwrap();
        assert_eq!(json["kind"], "bad-pat");
        assert_eq!(json["reason"], "nope");

        let json = serde_json::to_value(AdoError::NotFound {
            resource: "plan 7".into(),
        })
        .unwrap();
        assert_eq!(json["kind"], "not-found");
        assert_eq!(json["resource"], "plan 7");
    }
}

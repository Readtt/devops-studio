//! Lightweight work-item batch lookups. Used by the UI to surface titles
//! on linked-work-item rows so a user staring at "#1234" can see what it
//! actually points to without round-tripping through ADO web.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::client::{get_json, project_api, AdoState};
use super::errors::{AdoError, AdoResult};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkItemTitle {
    pub id: i64,
    pub title: String,
}

/// Fetch System.Title for each id in `ids`. Empty input returns empty output.
/// ADO caps a single call at ~200 ids; we chunk above that. Missing ids are
/// silently omitted from the result — callers render a fallback.
pub async fn get_work_item_titles(
    state: &AdoState,
    ids: &[i64],
) -> AdoResult<Vec<WorkItemTitle>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let (conn, _) = state.snapshot();
    let conn = conn.ok_or(AdoError::NotConfigured)?;

    let mut out: Vec<WorkItemTitle> = Vec::with_capacity(ids.len());
    for chunk in ids.chunks(200) {
        let ids_csv: String = chunk
            .iter()
            .map(|id| id.to_string())
            .collect::<Vec<_>>()
            .join(",");
        let url = project_api(
            &conn,
            &format!("wit/workitems?ids={ids_csv}&fields=System.Title"),
        );
        let raw: Value = get_json(state, &url, "work item titles").await?;
        let arr = raw
            .get("value")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        for item in arr {
            let id = item.get("id").and_then(|v| v.as_i64());
            let title = item
                .get("fields")
                .and_then(|f| f.get("System.Title"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if let Some(id) = id {
                out.push(WorkItemTitle { id, title });
            }
        }
    }
    Ok(out)
}

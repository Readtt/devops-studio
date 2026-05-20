//! Add/remove System.Tags on work items.
//!
//! ADO stores tags in System.Tags as a semicolon-separated string. To add a
//! tag we read-modify-write that field; we don't try to be clever about it.

use serde::Serialize;
use serde_json::Value;

use super::client::{get_json, patch_json_patch, project_api, AdoState};
use super::errors::{AdoError, AdoResult};

#[derive(Serialize)]
struct JsonPatchOp {
    op: &'static str,
    path: String,
    value: Value,
}

pub async fn add_tag(state: &AdoState, work_item_id: i64, tag: &str) -> AdoResult<()> {
    let current = current_tags(state, work_item_id).await?;
    if current.iter().any(|t| t.eq_ignore_ascii_case(tag)) {
        return Ok(());
    }
    let mut next = current;
    next.push(tag.to_string());
    set_tags(state, work_item_id, &next).await
}

pub async fn remove_tag(state: &AdoState, work_item_id: i64, tag: &str) -> AdoResult<()> {
    let current = current_tags(state, work_item_id).await?;
    let next: Vec<String> = current
        .into_iter()
        .filter(|t| !t.eq_ignore_ascii_case(tag))
        .collect();
    set_tags(state, work_item_id, &next).await
}

async fn current_tags(state: &AdoState, work_item_id: i64) -> AdoResult<Vec<String>> {
    let (conn, _) = state.snapshot();
    let conn = conn.ok_or(AdoError::NotConfigured)?;
    let url = project_api(
        &conn,
        &format!("wit/workitems/{work_item_id}?fields=System.Tags"),
    );
    let raw: Value = get_json(state, &url, "tags").await?;
    let s = raw
        .get("fields")
        .and_then(|f| f.get("System.Tags"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    Ok(s.split(';')
        .map(|p| p.trim().to_string())
        .filter(|t| !t.is_empty())
        .collect())
}

async fn set_tags(state: &AdoState, work_item_id: i64, tags: &[String]) -> AdoResult<()> {
    let (conn, _) = state.snapshot();
    let conn = conn.ok_or(AdoError::NotConfigured)?;
    let url = project_api(&conn, &format!("wit/workitems/{work_item_id}"));
    let ops = vec![JsonPatchOp {
        op: "add",
        path: "/fields/System.Tags".into(),
        value: Value::String(tags.join("; ")),
    }];
    let _: Value = patch_json_patch(state, &url, &ops, "set tags").await?;
    Ok(())
}

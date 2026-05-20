//! Bug work item creation + "Tested By" linking to a Test Case.
//!
//! Relation `Microsoft.VSTS.Common.TestedBy-Forward` is from Test Case to Bug
//! (the case "tests" the bug). We create the Bug first, then patch the Test
//! Case with a relation pointing at the Bug's URL.

use serde::Serialize;
use serde_json::{json, Value};

use super::client::{patch_json_patch, project_api, AdoState};
use super::errors::{AdoError, AdoResult};
use super::types::{CreatedWorkItem, DraftBug};

#[derive(Serialize)]
struct JsonPatchOp {
    op: &'static str,
    path: String,
    value: Value,
}

pub async fn create_bug(state: &AdoState, draft: &DraftBug) -> AdoResult<CreatedWorkItem> {
    let (conn, _) = state.snapshot();
    let conn = conn.ok_or(AdoError::NotConfigured)?;
    let url = project_api(&conn, "wit/workitems/$Bug");
    let ops = vec![
        JsonPatchOp {
            op: "add",
            path: "/fields/System.Title".into(),
            value: Value::String(draft.title.clone()),
        },
        JsonPatchOp {
            op: "add",
            path: "/fields/Microsoft.VSTS.TCM.ReproSteps".into(),
            value: Value::String(format!("<P>{}</P>", html_escape(&draft.repro_steps))),
        },
        JsonPatchOp {
            op: "add",
            path: "/fields/Microsoft.VSTS.Common.Severity".into(),
            value: Value::String(draft.severity.clone()),
        },
    ];
    let raw: Value = patch_json_patch(state, &url, &ops, "create bug").await?;
    let id = raw
        .get("id")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| AdoError::local("create bug: missing id"))?;
    let url_str = raw
        .get("url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let web_url = format!(
        "{}/{}/_workitems/edit/{}",
        conn.org_url.trim_end_matches('/'),
        conn.project,
        id
    );
    Ok(CreatedWorkItem {
        id,
        url: url_str,
        web_url,
    })
}

/// Add a `TestedBy-Forward` relation on the Test Case pointing at the Bug.
pub async fn link_tested_by(
    state: &AdoState,
    case_id: i64,
    bug_url: &str,
) -> AdoResult<()> {
    let (conn, _) = state.snapshot();
    let conn = conn.ok_or(AdoError::NotConfigured)?;
    let url = project_api(&conn, &format!("wit/workitems/{case_id}"));
    let ops = vec![JsonPatchOp {
        op: "add",
        path: "/relations/-".into(),
        value: json!({
            "rel": "Microsoft.VSTS.Common.TestedBy-Forward",
            "url": bug_url,
            "attributes": { "comment": "Linked by DevOps Studio" }
        }),
    }];
    let _: Value = patch_json_patch(state, &url, &ops, "link Tested-By").await?;
    Ok(())
}

fn html_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(c),
        }
    }
    out
}

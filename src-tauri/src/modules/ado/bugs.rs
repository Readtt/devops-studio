//! Bug work item creation + work-item linking.
//!
//! Two kinds of links live here:
//! - `Microsoft.VSTS.Common.TestedBy-Forward` (case → bug) — the "this case
//!   tests this bug" relation used by the Generator's draft-publish flow.
//! - `System.LinkTypes.Hierarchy-Reverse` (bug → case) — parent/child, used
//!   when the user wants the bug to nest under a case in the work-item tree.
//!
//! Code anchors (file:line ranges) are serialized into the ReproSteps field
//! as a delimited HTML comment block so we can round-trip them out later
//! without needing custom ADO fields. The corresponding parser lives on the
//! TS side at `src/modules/test-plans/lib/sourceLinksParser.ts` (extended
//! in Phase 6 for the new code-link variant).

use serde::Serialize;
use serde_json::{json, Value};

use super::client::{get_json, patch_json_patch, project_api, AdoState};
use super::errors::{AdoError, AdoResult};
use super::test_cases::{display_name_field, friendly_rel_name, relation_to_linked};
use super::types::{Bug, CodeLink, CreatedWorkItem, DraftBug, LinkedWorkItem};

const CODE_LINKS_OPEN: &str = "<!-- devops-studio:code-links:v1 -->";
const CODE_LINKS_CLOSE: &str = "<!-- /devops-studio:code-links -->";

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

    let repro_html = build_repro_steps_html(&draft.repro_steps, &draft.code_links);

    let ops = vec![
        JsonPatchOp {
            op: "add",
            path: "/fields/System.Title".into(),
            value: Value::String(draft.title.clone()),
        },
        JsonPatchOp {
            op: "add",
            path: "/fields/Microsoft.VSTS.TCM.ReproSteps".into(),
            value: Value::String(repro_html),
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

    // If the draft requested a parent test case, link it now. Non-fatal —
    // the bug exists either way and the user can re-link from the UI.
    if let Some(parent_case_id) = draft.parent_case_id {
        let _ = link_bug_to_case_as_child(state, id, parent_case_id).await;
    }

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

/// Make the bug a Child of the test case in the work-item hierarchy.
/// Patches the BUG with a `Hierarchy-Reverse` relation pointing AT the case
/// (the bug's "parent" link). ADO mirrors it as a "child" entry on the case
/// automatically, so we don't need to patch both items.
pub async fn link_bug_to_case_as_child(
    state: &AdoState,
    bug_id: i64,
    case_id: i64,
) -> AdoResult<()> {
    let (conn, _) = state.snapshot();
    let conn = conn.ok_or(AdoError::NotConfigured)?;

    // Build the case's API URL; ADO accepts either project-scoped or org-
    // scoped URLs on relation targets. Project-scoped is shorter + same org.
    let case_api_url = format!(
        "{}/{}/_apis/wit/workItems/{}",
        conn.org_url.trim_end_matches('/'),
        conn.project,
        case_id
    );

    let bug_url = project_api(&conn, &format!("wit/workitems/{bug_id}"));
    let ops = vec![JsonPatchOp {
        op: "add",
        path: "/relations/-".into(),
        value: json!({
            "rel": "System.LinkTypes.Hierarchy-Reverse",
            "url": case_api_url,
            "attributes": { "comment": "Parent linked by DevOps Studio" }
        }),
    }];
    let _: Value = patch_json_patch(state, &bug_url, &ops, "link bug → case (Parent)").await?;
    Ok(())
}

/// Fetch a Bug work item by ID and project it into the BugPane shape.
/// Mirrors `test_plans::get_case` but pulls bug-specific fields.
pub async fn get_bug(state: &AdoState, bug_id: i64) -> AdoResult<Bug> {
    let (conn, _) = state.snapshot();
    let conn = conn.ok_or(AdoError::NotConfigured)?;
    let url = project_api(
        &conn,
        &format!("wit/workitems/{bug_id}?$expand=relations"),
    );
    let raw: Value = get_json(state, &url, "bug").await?;
    work_item_to_bug(raw, &conn.org_url, &conn.project)
}

fn work_item_to_bug(raw: Value, conn_org: &str, conn_project: &str) -> AdoResult<Bug> {
    let id = raw
        .get("id")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| AdoError::local("work item: missing id"))?;
    let url = raw
        .get("url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let fields = raw
        .get("fields")
        .and_then(|v| v.as_object())
        .ok_or_else(|| AdoError::local("work item: missing fields"))?;

    let title = fields
        .get("System.Title")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let state_str = fields
        .get("System.State")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let severity = fields
        .get("Microsoft.VSTS.Common.Severity")
        .and_then(|v| v.as_str())
        .map(String::from);
    let priority = fields
        .get("Microsoft.VSTS.Common.Priority")
        .and_then(|v| v.as_i64())
        .and_then(|n| u8::try_from(n).ok());
    let area_path = fields
        .get("System.AreaPath")
        .and_then(|v| v.as_str())
        .map(String::from);
    let iteration_path = fields
        .get("System.IterationPath")
        .and_then(|v| v.as_str())
        .map(String::from);
    let repro_steps_html = fields
        .get("Microsoft.VSTS.TCM.ReproSteps")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let tags = fields
        .get("System.Tags")
        .and_then(|v| v.as_str())
        .map(|s| {
            s.split(';')
                .map(|p| p.trim().to_string())
                .filter(|t| !t.is_empty())
                .collect()
        })
        .unwrap_or_default();

    let assigned_to = display_name_field(fields.get("System.AssignedTo"));
    let created_by = display_name_field(fields.get("System.CreatedBy"));
    let created_date = fields
        .get("System.CreatedDate")
        .and_then(|v| v.as_str())
        .map(String::from);
    let changed_by = display_name_field(fields.get("System.ChangedBy"));
    let changed_date = fields
        .get("System.ChangedDate")
        .and_then(|v| v.as_str())
        .map(String::from);

    let linked_work_items: Vec<LinkedWorkItem> = raw
        .get("relations")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|r| relation_to_linked(r, conn_org, conn_project))
                .collect()
        })
        .unwrap_or_default();
    // Touch `friendly_rel_name` so the import isn't flagged unused in tools/
    // builds that strip pub(super). (Used transitively via relation_to_linked.)
    let _ = friendly_rel_name;

    Ok(Bug {
        id,
        title,
        state: state_str,
        severity,
        priority,
        area_path,
        iteration_path,
        repro_steps_html,
        tags,
        url,
        assigned_to,
        created_by,
        created_date,
        changed_by,
        changed_date,
        linked_work_items,
    })
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

/// Build the ReproSteps HTML for a bug, appending a structured code-links
/// block (HTML comment delimited) when the draft has any anchors. The block
/// is plain text inside an HTML comment plus a human-visible list so users
/// browsing the bug in the ADO web UI can click through.
fn build_repro_steps_html(repro: &str, code_links: &[CodeLink]) -> String {
    let mut out = format!("<P>{}</P>", html_escape(repro));
    if code_links.is_empty() {
        return out;
    }
    out.push_str("<P>");
    out.push_str(CODE_LINKS_OPEN);
    out.push_str("</P>");
    out.push_str("<P><strong>Source references</strong></P><UL>");
    for link in code_links {
        let mut line = String::new();
        line.push_str(&html_escape(&link.file));
        if let Some(end) = link.end_line {
            if end != link.start_line {
                line.push_str(&format!(":{}-{}", link.start_line, end));
            } else {
                line.push_str(&format!(":{}", link.start_line));
            }
        } else {
            line.push_str(&format!(":{}", link.start_line));
        }
        if let Some(sha) = &link.commit_sha {
            line.push_str(&format!(" (commit {})", html_escape(sha)));
        }
        out.push_str(&format!("<LI>{line}</LI>"));
    }
    out.push_str("</UL><P>");
    out.push_str(CODE_LINKS_CLOSE);
    out.push_str("</P>");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repro_steps_without_code_links_is_just_repro() {
        let html = build_repro_steps_html("Click submit, app crashes.", &[]);
        assert_eq!(html, "<P>Click submit, app crashes.</P>");
    }

    #[test]
    fn repro_steps_with_one_link_includes_block() {
        let links = vec![CodeLink {
            file: "src/checkout.ts".into(),
            start_line: 42,
            end_line: Some(58),
            commit_sha: Some("abc1234".into()),
        }];
        let html = build_repro_steps_html("Repro", &links);
        assert!(html.contains(CODE_LINKS_OPEN));
        assert!(html.contains(CODE_LINKS_CLOSE));
        assert!(html.contains("src/checkout.ts:42-58"));
        assert!(html.contains("commit abc1234"));
    }

    #[test]
    fn single_line_anchor_renders_without_range() {
        let links = vec![CodeLink {
            file: "f.rs".into(),
            start_line: 7,
            end_line: None,
            commit_sha: None,
        }];
        let html = build_repro_steps_html("x", &links);
        assert!(html.contains("f.rs:7</LI>"));
        assert!(!html.contains(":7-"));
    }

    #[test]
    fn escapes_html_in_file_path_and_repro() {
        let links = vec![CodeLink {
            file: "a/<b>.ts".into(),
            start_line: 1,
            end_line: None,
            commit_sha: None,
        }];
        let html = build_repro_steps_html("crash <script>", &links);
        assert!(html.contains("crash &lt;script&gt;"));
        assert!(html.contains("a/&lt;b&gt;.ts:1"));
    }
}

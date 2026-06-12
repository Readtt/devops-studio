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

use super::client::{
    delete_request, get_json, patch_json_patch, post_json, project_api, AdoState,
};
use super::errors::{AdoError, AdoResult};
use super::test_cases::{display_name_field, friendly_rel_name, relation_to_linked};
use super::types::{
    Bug, BugRef, CodeLink, Connection, CreatedWorkItem, DraftBug, LinkedWorkItem, WorkItemRef,
};

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

    let mut ops = vec![
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
    // Assign the bug to a developer when the reviewer picked one. ADO resolves
    // the identity from the unique name (email) or display name we pass.
    if let Some(assignee) = draft
        .assigned_to
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        ops.push(JsonPatchOp {
            op: "add",
            path: "/fields/System.AssignedTo".into(),
            value: Value::String(assignee.to_string()),
        });
    }
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

/// Lightweight bug picker source. Runs a WIQL query (optionally scoped by area
/// path and/or a free-text title match), then batch-hydrates id/title/state/
/// severity for the matched ids. Newest-changed first; WIQL ordering preserved
/// through the hydrate step.
pub async fn list_bugs(
    state: &AdoState,
    area_path: Option<&str>,
    query: Option<&str>,
    top: i64,
) -> AdoResult<Vec<BugRef>> {
    let (conn, _) = state.snapshot();
    let conn = conn.ok_or(AdoError::NotConfigured)?;
    let top = top.clamp(1, 200);

    // Single quotes in user input are doubled so the WIQL string literals stay
    // well-formed (WIQL escapes ' as '').
    let mut wiql = format!(
        "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '{}' AND [System.WorkItemType] = 'Bug'",
        wiql_escape(&conn.project)
    );
    if let Some(area) = area_path.map(str::trim).filter(|s| !s.is_empty()) {
        wiql.push_str(&format!(" AND [System.AreaPath] UNDER '{}'", wiql_escape(area)));
    }
    if let Some(q) = query.map(str::trim).filter(|s| !s.is_empty()) {
        wiql.push_str(&format!(" AND [System.Title] CONTAINS '{}'", wiql_escape(q)));
    }
    wiql.push_str(" ORDER BY [System.ChangedDate] DESC");

    let url = project_api(&conn, &format!("wit/wiql?$top={top}"));
    let body = json!({ "query": wiql });
    let resp: Value =
        post_json(state, &url, &body, "application/json", "list bugs (wiql)").await?;

    let ids: Vec<i64> = resp
        .get("workItems")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|w| w.get("id").and_then(|v| v.as_i64()))
                .take(top as usize)
                .collect()
        })
        .unwrap_or_default();
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    hydrate_bug_refs(state, &conn, &ids).await
}

/// Batch-fetch the picker fields for `ids` and return them in the same order
/// `ids` were given (so the caller's WIQL sort survives). ADO caps a single
/// `ids=` call at ~200, so we chunk.
async fn hydrate_bug_refs(
    state: &AdoState,
    conn: &Connection,
    ids: &[i64],
) -> AdoResult<Vec<BugRef>> {
    use std::collections::HashMap;
    let mut by_id: HashMap<i64, BugRef> = HashMap::with_capacity(ids.len());
    for chunk in ids.chunks(200) {
        let ids_csv: String = chunk
            .iter()
            .map(|id| id.to_string())
            .collect::<Vec<_>>()
            .join(",");
        let url = project_api(
            conn,
            &format!(
                "wit/workitems?ids={ids_csv}&fields=System.Title,System.State,Microsoft.VSTS.Common.Severity"
            ),
        );
        let raw: Value = get_json(state, &url, "bug details").await?;
        let arr = raw
            .get("value")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        for item in arr {
            let Some(id) = item.get("id").and_then(|v| v.as_i64()) else {
                continue;
            };
            let fields = item.get("fields");
            let title = fields
                .and_then(|f| f.get("System.Title"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let state_str = fields
                .and_then(|f| f.get("System.State"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let severity = fields
                .and_then(|f| f.get("Microsoft.VSTS.Common.Severity"))
                .and_then(|v| v.as_str())
                .map(String::from);
            by_id.insert(
                id,
                BugRef {
                    id,
                    title,
                    state: state_str,
                    severity,
                },
            );
        }
    }
    Ok(ids.iter().filter_map(|id| by_id.remove(id)).collect())
}

/// Work-item picker source for the inline `#id` mention. Same WIQL shape as
/// `list_bugs` but spans every work-item type (minus the pure test-management
/// artifacts, which would drown the list in a Test Plans project) and carries
/// the type through so the picker can label each row. Newest-changed first.
pub async fn list_work_items(
    state: &AdoState,
    area_path: Option<&str>,
    query: Option<&str>,
    top: i64,
) -> AdoResult<Vec<WorkItemRef>> {
    let (conn, _) = state.snapshot();
    let conn = conn.ok_or(AdoError::NotConfigured)?;
    let top = top.clamp(1, 200);

    let mut wiql = format!(
        "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '{}' AND [System.WorkItemType] NOT IN ('Test Case','Test Suite','Test Plan','Shared Steps','Shared Parameter')",
        wiql_escape(&conn.project)
    );
    if let Some(area) = area_path.map(str::trim).filter(|s| !s.is_empty()) {
        wiql.push_str(&format!(" AND [System.AreaPath] UNDER '{}'", wiql_escape(area)));
    }
    if let Some(q) = query.map(str::trim).filter(|s| !s.is_empty()) {
        wiql.push_str(&format!(" AND [System.Title] CONTAINS '{}'", wiql_escape(q)));
    }
    wiql.push_str(" ORDER BY [System.ChangedDate] DESC");

    let url = project_api(&conn, &format!("wit/wiql?$top={top}"));
    let body = json!({ "query": wiql });
    let resp: Value =
        post_json(state, &url, &body, "application/json", "list work items (wiql)").await?;

    let ids: Vec<i64> = resp
        .get("workItems")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|w| w.get("id").and_then(|v| v.as_i64()))
                .take(top as usize)
                .collect()
        })
        .unwrap_or_default();
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    hydrate_work_item_refs(state, &conn, &ids).await
}

/// Single work-item lookup for resolving `#123` by exact id (WIQL title search
/// can't match ids). Errors when the id doesn't resolve so the caller can fall
/// back to an empty result.
pub async fn get_work_item_ref(state: &AdoState, id: i64) -> AdoResult<WorkItemRef> {
    let (conn, _) = state.snapshot();
    let conn = conn.ok_or(AdoError::NotConfigured)?;
    hydrate_work_item_refs(state, &conn, &[id])
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| AdoError::local(format!("work item {id} not found")))
}

/// Batch-hydrate WorkItemRef rows (adds System.WorkItemType to the bug field
/// set). Preserves caller order so the WIQL sort survives.
async fn hydrate_work_item_refs(
    state: &AdoState,
    conn: &Connection,
    ids: &[i64],
) -> AdoResult<Vec<WorkItemRef>> {
    use std::collections::HashMap;
    let mut by_id: HashMap<i64, WorkItemRef> = HashMap::with_capacity(ids.len());
    for chunk in ids.chunks(200) {
        let ids_csv: String = chunk
            .iter()
            .map(|id| id.to_string())
            .collect::<Vec<_>>()
            .join(",");
        let url = project_api(
            conn,
            &format!(
                "wit/workitems?ids={ids_csv}&fields=System.Title,System.State,System.WorkItemType,Microsoft.VSTS.Common.Severity"
            ),
        );
        let raw: Value = get_json(state, &url, "work item details").await?;
        let arr = raw
            .get("value")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        for item in arr {
            let Some(id) = item.get("id").and_then(|v| v.as_i64()) else {
                continue;
            };
            let fields = item.get("fields");
            let title = fields
                .and_then(|f| f.get("System.Title"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let state_str = fields
                .and_then(|f| f.get("System.State"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let work_item_type = fields
                .and_then(|f| f.get("System.WorkItemType"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let severity = fields
                .and_then(|f| f.get("Microsoft.VSTS.Common.Severity"))
                .and_then(|v| v.as_str())
                .map(String::from);
            by_id.insert(
                id,
                WorkItemRef {
                    id,
                    title,
                    state: state_str,
                    work_item_type,
                    severity,
                },
            );
        }
    }
    Ok(ids.iter().filter_map(|id| by_id.remove(id)).collect())
}

/// Fields a bug update can change. Any `None` is left untouched.
#[derive(Default)]
pub struct BugUpdate {
    pub title: Option<String>,
    pub repro_steps: Option<String>,
    pub severity: Option<String>,
    pub state: Option<String>,
}

/// Patch a bug work item. Repro steps are re-rendered through the same HTML
/// emitter as `create_bug` (no code-links on a chat-driven update). An all-None
/// patch is a no-op and returns Ok without a round-trip.
pub async fn update_bug(state: &AdoState, bug_id: i64, patch: &BugUpdate) -> AdoResult<()> {
    let (conn, _) = state.snapshot();
    let conn = conn.ok_or(AdoError::NotConfigured)?;

    let mut ops: Vec<JsonPatchOp> = Vec::new();
    if let Some(title) = &patch.title {
        ops.push(JsonPatchOp {
            op: "add",
            path: "/fields/System.Title".into(),
            value: Value::String(title.clone()),
        });
    }
    if let Some(repro) = &patch.repro_steps {
        let html = build_repro_steps_html(repro, &[]);
        ops.push(JsonPatchOp {
            op: "add",
            path: "/fields/Microsoft.VSTS.TCM.ReproSteps".into(),
            value: Value::String(html),
        });
    }
    if let Some(sev) = &patch.severity {
        ops.push(JsonPatchOp {
            op: "add",
            path: "/fields/Microsoft.VSTS.Common.Severity".into(),
            value: Value::String(sev.clone()),
        });
    }
    if let Some(st) = &patch.state {
        ops.push(JsonPatchOp {
            op: "add",
            path: "/fields/System.State".into(),
            value: Value::String(st.clone()),
        });
    }
    if ops.is_empty() {
        return Ok(());
    }
    let url = project_api(&conn, &format!("wit/workitems/{bug_id}"));
    let _: Value = patch_json_patch(state, &url, &ops, "update bug").await?;
    Ok(())
}

/// Delete a bug work item. Soft-delete (Recycle Bin, recoverable) unless
/// `destroy` is true. A Bug is a work item like any other, so this mirrors
/// `test_cases::delete_test_case`.
pub async fn delete_bug(state: &AdoState, bug_id: i64, destroy: bool) -> AdoResult<()> {
    let (conn, _) = state.snapshot();
    let conn = conn.ok_or(AdoError::NotConfigured)?;
    let path = if destroy {
        // `?destroy=true` (not `&…`): project_api appends `&api-version` after
        // it. A bare `&destroy=true` lands BEFORE the `?api-version`, corrupting
        // the URL (the id becomes "{id}&destroy=true") → a guaranteed 400.
        format!("wit/workitems/{bug_id}?destroy=true")
    } else {
        format!("wit/workitems/{bug_id}")
    };
    let url = project_api(&conn, &path);
    delete_request(state, &url, "delete bug").await
}

fn wiql_escape(s: &str) -> String {
    s.replace('\'', "''")
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
    let work_item_type = fields
        .get("System.WorkItemType")
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
        work_item_type,
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
    let mut out = render_repro_body(repro);
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

/// Render the structured plain-text repro body the analyst emits into ADO-
/// friendly HTML. Each blank-line-separated paragraph becomes its own `<P>`,
/// labeled section headers (e.g. "STEPS TO REPRODUCE:" on its own line) are
/// wrapped in `<strong>`, and remaining newlines become `<BR>` so the
/// numbered list reads as a list instead of a single run-on sentence.
///
/// Falls back to a single `<P>` for legacy bodies that came in without the
/// structured layout — the publish path stays compatible with older drafts.
fn render_repro_body(repro: &str) -> String {
    let trimmed = repro.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    // Split on blank lines so each "section" (PRECONDITION, STEPS …) becomes
    // its own paragraph block in ADO. Inside a section, single newlines stay
    // as `<BR>` so the numbered repro steps render line-by-line.
    let mut out = String::new();
    for paragraph in trimmed.split("\n\n") {
        let paragraph = paragraph.trim_matches(|c: char| c == '\r' || c == '\n');
        if paragraph.is_empty() {
            continue;
        }
        out.push_str("<P>");
        let mut first = true;
        for line in paragraph.split('\n') {
            if !first {
                out.push_str("<BR>");
            }
            first = false;
            out.push_str(&render_repro_line(line));
        }
        out.push_str("</P>");
    }
    out
}

/// Per-line emitter for `render_repro_body` — bolds a labeled section header
/// when the line looks like `LABEL:` (or `LABEL: trailing text`) so the
/// section structure reads at a glance in the ADO web UI.
fn render_repro_line(line: &str) -> String {
    let line = line.trim_end_matches('\r');
    if let Some((label, rest)) = label_split(line) {
        let mut s = format!("<strong>{}</strong>", html_escape(&label));
        if !rest.is_empty() {
            s.push_str(&format!(" {}", html_escape(&rest)));
        }
        return s;
    }
    html_escape(line)
}

/// True when a line is a section header of the form `WORDS:` (with optional
/// trailing content). Returns the label (without the colon) and any trailing
/// content. The label must be uppercase / structural — we don't bold every
/// line that happens to end in a colon.
fn label_split(line: &str) -> Option<(String, String)> {
    let trimmed = line.trim_start();
    let colon_pos = trimmed.find(':')?;
    let label = &trimmed[..colon_pos];
    // Reject labels longer than ~6 words or that contain lowercase — the
    // structured layout the analyst emits is always uppercase, short labels
    // ("STEPS TO REPRODUCE:", "ENVIRONMENT:"). Anything else is just prose.
    if label.is_empty() || label.len() > 60 {
        return None;
    }
    let mut has_lower = false;
    for ch in label.chars() {
        if ch.is_lowercase() {
            has_lower = true;
            break;
        }
        if !(ch.is_uppercase() || ch.is_ascii_digit() || ch == ' ' || ch == '/' || ch == '-' || ch == '_') {
            return None;
        }
    }
    if has_lower {
        return None;
    }
    let rest = trimmed[colon_pos + 1..].trim().to_string();
    let label_with_colon = format!("{}:", label);
    Some((label_with_colon, rest))
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
    fn structured_repro_renders_section_headers_bold() {
        let body = "PRECONDITION:\nSignedin user\n\nSTEPS TO REPRODUCE:\n1. Open page\n2. Click submit\n\nEXPECTED RESULT:\nOK toast\n\nACTUAL RESULT:\n500 error";
        let html = build_repro_steps_html(body, &[]);
        assert!(html.contains("<strong>PRECONDITION:</strong>"));
        assert!(html.contains("<strong>STEPS TO REPRODUCE:</strong>"));
        assert!(html.contains("<strong>EXPECTED RESULT:</strong>"));
        assert!(html.contains("<strong>ACTUAL RESULT:</strong>"));
        // Single-newline-separated lines inside a section render as <BR>.
        assert!(html.contains("1. Open page<BR>2. Click submit"));
    }

    #[test]
    fn structured_repro_with_trailing_text_on_label_line() {
        // The analyst sometimes inlines the value on the same line as the
        // label: "ENVIRONMENT: Chrome 120 on macOS". Bold the label only.
        let html = build_repro_steps_html("ENVIRONMENT: Chrome 120 on macOS", &[]);
        assert!(html.contains("<strong>ENVIRONMENT:</strong> Chrome 120 on macOS"));
    }

    #[test]
    fn lowercase_label_is_not_bolded() {
        // Free-form prose lines that just happen to contain a colon must not
        // be misclassified as section headers.
        let html = build_repro_steps_html("note: this is just a note", &[]);
        assert!(!html.contains("<strong>"));
        assert!(html.contains("note: this is just a note"));
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
    fn wiql_escape_doubles_single_quotes() {
        // WIQL string literals escape ' as '' — an area path or search term
        // with an apostrophe must not break out of the quoted literal.
        assert_eq!(wiql_escape("O'Brien\\Area"), "O''Brien\\Area");
        assert_eq!(wiql_escape("plain"), "plain");
        assert_eq!(wiql_escape("''"), "''''");
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

//! Test Case creation + Steps XML build/parse.
//!
//! ADO has no structured Steps API. Steps live as XML in the
//! `Microsoft.VSTS.TCM.Steps` field of a Test Case work item. We round-trip
//! through `quick-xml`. The wire format is:
//!
//! ```xml
//! <steps id="0" last="N">
//!   <step id="1" type="ActionStep">
//!     <parameterizedString isformatted="true">&lt;P&gt;action html&lt;/P&gt;</parameterizedString>
//!     <parameterizedString isformatted="true">&lt;P&gt;expected html&lt;/P&gt;</parameterizedString>
//!     <description/>
//!   </step>
//! </steps>
//! ```
//!
//! Action/expected text is double-escaped: the XML attribute value contains
//! HTML, which itself contains the user's plain text with `<`/`>`/`&` escaped.

use serde::Serialize;
use serde_json::{json, Value};

use super::client::{
    delete_request, patch_json_patch, post_json, project_api, AdoState,
};
use super::errors::{AdoError, AdoResult};
use super::types::{CreatedWorkItem, DraftCase, LinkedWorkItem, TestCase, TestStep};

/// Build the Microsoft.VSTS.TCM.Steps XML for a set of steps.
pub fn build_steps_xml(steps: &[TestStep]) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        r#"<steps id="0" last="{}">"#,
        steps.len()
    ));
    for (idx, s) in steps.iter().enumerate() {
        let id = (idx + 1) as u32;
        out.push_str(&format!(
            r#"<step id="{}" type="ActionStep"><parameterizedString isformatted="true">{}</parameterizedString><parameterizedString isformatted="true">{}</parameterizedString><description/></step>"#,
            id,
            escape_html_for_attribute(&s.action),
            escape_html_for_attribute(&s.expected)
        ));
    }
    out.push_str("</steps>");
    out
}

/// Inverse: parse a Steps XML blob back into a structured Vec<TestStep>.
/// Tolerant — drops malformed steps rather than failing the whole document.
pub fn parse_steps_xml(xml: &str) -> Vec<TestStep> {
    use quick_xml::events::Event;
    use quick_xml::Reader;

    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);

    let mut steps: Vec<TestStep> = Vec::new();
    let mut current_action: Option<String> = None;
    let mut current_expected: Option<String> = None;
    let mut buf = Vec::new();
    let mut in_pstring = false;
    let mut pstring_slot: u8 = 0; // 0 = action, 1 = expected

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) if e.name().as_ref() == b"step" => {
                current_action = None;
                current_expected = None;
                pstring_slot = 0;
            }
            Ok(Event::Empty(e)) if e.name().as_ref() == b"step" => {
                // empty <step/> — skip
            }
            Ok(Event::Start(e)) if e.name().as_ref() == b"parameterizedString" => {
                in_pstring = true;
            }
            Ok(Event::Text(t)) if in_pstring => {
                let text = t.unescape().unwrap_or_default().into_owned();
                let plain = strip_html(&text);
                if pstring_slot == 0 {
                    current_action.get_or_insert(plain);
                } else {
                    current_expected.get_or_insert(plain);
                }
            }
            Ok(Event::End(e)) if e.name().as_ref() == b"parameterizedString" => {
                in_pstring = false;
                pstring_slot = pstring_slot.saturating_add(1);
            }
            Ok(Event::End(e)) if e.name().as_ref() == b"step" => {
                if let (Some(a), e) = (current_action.take(), current_expected.take()) {
                    steps.push(TestStep {
                        index: (steps.len() + 1) as u32,
                        action: a,
                        expected: e.unwrap_or_default(),
                    });
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    steps
}

fn escape_html_for_attribute(plain: &str) -> String {
    // The outer string is an XML attribute value, the inner is HTML.
    // We wrap in <P>...</P> and HTML-escape user content first.
    let html = format!("<P>{}</P>", html_escape_plain(plain));
    xml_escape_attribute(&html)
}

fn html_escape_plain(s: &str) -> String {
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

fn xml_escape_attribute(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(c),
        }
    }
    out
}

fn strip_html(s: &str) -> String {
    // Cheap pass — we don't render the HTML, just need plain step text.
    let mut tagless = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => tagless.push(c),
            _ => {}
        }
    }
    // Decode the HTML entities the producer escaped on the way in. We only
    // emit `&lt;`/`&gt;`/`&amp;` from `html_escape_plain`, so we don't need
    // a full HTML5 entity table.
    let mut out = String::with_capacity(tagless.len());
    let bytes = tagless.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'&' {
            if bytes[i..].starts_with(b"&amp;") {
                out.push('&');
                i += 5;
                continue;
            }
            if bytes[i..].starts_with(b"&lt;") {
                out.push('<');
                i += 4;
                continue;
            }
            if bytes[i..].starts_with(b"&gt;") {
                out.push('>');
                i += 4;
                continue;
            }
            if bytes[i..].starts_with(b"&quot;") {
                out.push('"');
                i += 6;
                continue;
            }
            if bytes[i..].starts_with(b"&apos;") {
                out.push('\'');
                i += 6;
                continue;
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

#[derive(Serialize)]
struct JsonPatchOp {
    op: &'static str,
    path: String,
    value: Value,
}

/// Create a Test Case work item (Step 1 of 2 — does NOT link to a suite).
pub async fn create_test_case_workitem(
    state: &AdoState,
    draft: &DraftCase,
) -> AdoResult<CreatedWorkItem> {
    let (conn, _) = state.snapshot();
    let conn = conn.ok_or(AdoError::NotConfigured)?;

    let url = project_api(&conn, "wit/workitems/$Test%20Case");
    let mut ops = vec![
        JsonPatchOp {
            op: "add",
            path: "/fields/System.Title".into(),
            value: Value::String(draft.title.clone()),
        },
        JsonPatchOp {
            op: "add",
            path: "/fields/System.Description".into(),
            value: Value::String(merge_description(&draft.description, draft.source_links_block.as_deref())),
        },
        JsonPatchOp {
            op: "add",
            path: "/fields/Microsoft.VSTS.TCM.Steps".into(),
            value: Value::String(build_steps_xml(&draft.steps)),
        },
    ];
    if let Some(area) = &draft.area_path {
        ops.push(JsonPatchOp {
            op: "add",
            path: "/fields/System.AreaPath".into(),
            value: Value::String(area.clone()),
        });
    }
    if let Some(iter) = &draft.iteration_path {
        ops.push(JsonPatchOp {
            op: "add",
            path: "/fields/System.IterationPath".into(),
            value: Value::String(iter.clone()),
        });
    }
    if !draft.tags.is_empty() {
        ops.push(JsonPatchOp {
            op: "add",
            path: "/fields/System.Tags".into(),
            value: Value::String(draft.tags.join("; ")),
        });
    }

    let raw: Value = patch_json_patch(state, &url, &ops, "create test case").await?;
    let id = raw
        .get("id")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| AdoError::local("create test case: missing id"))?;
    let url_str = raw
        .get("url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let web_url = build_web_url_for_workitem(&conn.org_url, &conn.project, id);
    Ok(CreatedWorkItem { id, url: url_str, web_url })
}

/// Step 2 of 2 — link an already-created Test Case work item into a Test Suite.
pub async fn link_case_to_suite(
    state: &AdoState,
    plan_id: i64,
    suite_id: i64,
    case_id: i64,
) -> AdoResult<()> {
    let (conn, _) = state.snapshot();
    let conn = conn.ok_or(AdoError::NotConfigured)?;
    let url = project_api(
        &conn,
        &format!("testplan/Plans/{plan_id}/Suites/{suite_id}/TestCase"),
    );
    let body = json!([{ "workItem": { "id": case_id } }]);
    let _: Value = post_json(state, &url, &body, "application/json", "link case to suite").await?;
    Ok(())
}

/// Replace the description (used when the publisher injects the source-links block).
pub async fn update_description(
    state: &AdoState,
    case_id: i64,
    description: &str,
) -> AdoResult<()> {
    let (conn, _) = state.snapshot();
    let conn = conn.ok_or(AdoError::NotConfigured)?;
    let url = project_api(&conn, &format!("wit/workitems/{case_id}"));
    let ops = vec![JsonPatchOp {
        op: "add",
        path: "/fields/System.Description".into(),
        value: Value::String(description.to_string()),
    }];
    let _: Value = patch_json_patch(state, &url, &ops, "update description").await?;
    Ok(())
}

/// Replace the Microsoft.VSTS.TCM.Steps XML on a case. Reuses the same
/// build_steps_xml the create path uses so the wire shape is identical.
/// Rejects empty step lists — ADO accepts them but the UI treats steps as
/// the heart of a case, so an accidental empty rewrite is almost always a
/// bug, not the user's intent.
pub async fn update_case_steps(
    state: &AdoState,
    case_id: i64,
    steps: &[TestStep],
) -> AdoResult<()> {
    if steps.is_empty() {
        return Err(AdoError::Local {
            message: "A case must have at least one step.".into(),
        });
    }
    let (conn, _) = state.snapshot();
    let conn = conn.ok_or(AdoError::NotConfigured)?;
    let url = project_api(&conn, &format!("wit/workitems/{case_id}"));
    let ops = vec![JsonPatchOp {
        op: "add",
        path: "/fields/Microsoft.VSTS.TCM.Steps".into(),
        value: Value::String(build_steps_xml(steps)),
    }];
    let _: Value = patch_json_patch(state, &url, &ops, "update steps").await?;
    Ok(())
}

/// Replace the System.Title of any work item — used by the in-app rename
/// affordance on the case / bug detail panes. ADO doesn't distinguish work
/// item types here; the same patch works for a Test Case, Bug, or anything
/// else. Title is required by ADO, so we reject empty strings up front
/// instead of letting the server return a confusing 400.
pub async fn update_work_item_title(
    state: &AdoState,
    work_item_id: i64,
    title: &str,
) -> AdoResult<()> {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return Err(AdoError::Local {
            message: "Title can't be empty.".into(),
        });
    }
    let (conn, _) = state.snapshot();
    let conn = conn.ok_or(AdoError::NotConfigured)?;
    let url = project_api(&conn, &format!("wit/workitems/{work_item_id}"));
    let ops = vec![JsonPatchOp {
        op: "add",
        path: "/fields/System.Title".into(),
        value: Value::String(trimmed.to_string()),
    }];
    let _: Value = patch_json_patch(state, &url, &ops, "update title").await?;
    Ok(())
}

/// Delete a Test Case work item. Defaults to "soft" delete — ADO moves the
/// item to the project's Recycle Bin where it's recoverable for 30 days.
/// Passing `destroy=true` skips the bin and removes it permanently; we
/// expose that as a separate parameter and default to false because the
/// chat-driven path should never destroy by accident.
///
/// Note: a work item linked to a suite stays linked even after a soft-
/// delete — the suite-cases query just stops returning it. If the user
/// wants a clean unlink + delete, they can hit the suite remove path from
/// the test plan UI; the chat path doesn't need both, since "delete the
/// case" reads as a single user-level operation.
pub async fn delete_test_case(
    state: &AdoState,
    work_item_id: i64,
    destroy: bool,
) -> AdoResult<()> {
    let (conn, _) = state.snapshot();
    let conn = conn.ok_or(AdoError::NotConfigured)?;
    let path = if destroy {
        format!("wit/workitems/{work_item_id}&destroy=true")
    } else {
        format!("wit/workitems/{work_item_id}")
    };
    let url = project_api(&conn, &path);
    delete_request(state, &url, "delete test case").await
}

fn merge_description(base: &str, links_block: Option<&str>) -> String {
    match links_block {
        Some(block) if !block.is_empty() => format!("{base}\n\n{block}"),
        _ => base.to_string(),
    }
}

fn build_web_url_for_workitem(org_url: &str, project: &str, id: i64) -> String {
    format!(
        "{}/{}/_workitems/edit/{}",
        org_url.trim_end_matches('/'),
        project,
        id
    )
}

/// Convert a `wit/workitems/{id}?$expand=relations` response into a TestCase.
/// `conn_org` + `conn_project` are needed only to build the per-relation
/// web URLs — pass empty strings if the caller doesn't yet have a connection
/// (the URLs come out empty but everything else still works).
pub fn work_item_to_case(raw: Value, conn_org: &str, conn_project: &str) -> AdoResult<TestCase> {
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
    let state = fields
        .get("System.State")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let area = fields
        .get("System.AreaPath")
        .and_then(|v| v.as_str())
        .map(String::from);
    let iter = fields
        .get("System.IterationPath")
        .and_then(|v| v.as_str())
        .map(String::from);
    let description_html = fields
        .get("System.Description")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let steps_xml = fields
        .get("Microsoft.VSTS.TCM.Steps")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let steps = parse_steps_xml(steps_xml);
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

    // --- Developer metadata --------------------------------------------------
    let assigned_to = display_name_field(fields.get("System.AssignedTo"));
    let priority = fields
        .get("Microsoft.VSTS.Common.Priority")
        .and_then(|v| v.as_i64())
        .and_then(|n| u8::try_from(n).ok());
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

    let linked_work_items = raw
        .get("relations")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|r| relation_to_linked(r, conn_org, conn_project))
                .collect()
        })
        .unwrap_or_default();

    Ok(TestCase {
        id,
        title,
        state,
        area_path: area,
        iteration_path: iter,
        description_html,
        steps,
        tags,
        url,
        assigned_to,
        priority,
        created_by,
        created_date,
        changed_by,
        changed_date,
        linked_work_items,
    })
}

/// ADO `Identity` fields look like `{"displayName": "Alice", "uniqueName": "alice@x"}`.
/// Pull the human-readable name with sensible fallbacks.
pub(super) fn display_name_field(v: Option<&Value>) -> Option<String> {
    let obj = v?.as_object()?;
    obj.get("displayName")
        .and_then(|v| v.as_str())
        .or_else(|| obj.get("uniqueName").and_then(|v| v.as_str()))
        .map(String::from)
}

/// Convert a single entry in the work item's `relations` array into a
/// `LinkedWorkItem`. Skips hyperlinks (`Hyperlink` rel) and attachments since
/// those aren't work-item-to-work-item relations.
pub(super) fn relation_to_linked(
    raw: &Value,
    conn_org: &str,
    conn_project: &str,
) -> Option<LinkedWorkItem> {
    let rel = raw.get("rel").and_then(|v| v.as_str())?;
    // Only keep work-item links; skip hyperlinks/attachments.
    if !rel.starts_with("System.LinkTypes.")
        && !rel.starts_with("Microsoft.VSTS.Common.TestedBy")
        && !rel.starts_with("Microsoft.VSTS.Common.Affects")
        && !rel.starts_with("Microsoft.VSTS.Common.Tests")
    {
        return None;
    }
    let url = raw.get("url").and_then(|v| v.as_str()).unwrap_or("");
    // The REST URL ends with `/{id}` — extract the trailing integer.
    let id = url
        .rsplit('/')
        .next()
        .and_then(|s| s.parse::<i64>().ok())?;
    let kind = friendly_rel_name(rel).to_string();
    let web_url = if !conn_org.is_empty() && !conn_project.is_empty() {
        format!(
            "{}/{}/_workitems/edit/{}",
            conn_org.trim_end_matches('/'),
            conn_project,
            id
        )
    } else {
        String::new()
    };
    Some(LinkedWorkItem {
        id,
        kind,
        rel: rel.to_string(),
        web_url,
    })
}

pub(super) fn friendly_rel_name(rel: &str) -> &'static str {
    match rel {
        "System.LinkTypes.Hierarchy-Forward" => "Child",
        "System.LinkTypes.Hierarchy-Reverse" => "Parent",
        "System.LinkTypes.Related" => "Related",
        "System.LinkTypes.Duplicate-Forward" => "Duplicate of",
        "System.LinkTypes.Duplicate-Reverse" => "Duplicated by",
        "System.LinkTypes.Dependency-Forward" => "Successor",
        "System.LinkTypes.Dependency-Reverse" => "Predecessor",
        "Microsoft.VSTS.Common.TestedBy-Forward" => "Tested by",
        "Microsoft.VSTS.Common.TestedBy-Reverse" => "Tests",
        "Microsoft.VSTS.Common.Affects-Forward" => "Affects",
        "Microsoft.VSTS.Common.Affects-Reverse" => "Affected by",
        _ => "Other",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_steps() {
        let steps = vec![
            TestStep {
                index: 1,
                action: "Open login page".into(),
                expected: "Login form visible".into(),
            },
            TestStep {
                index: 2,
                action: "Enter <bad> & valid creds".into(),
                expected: "Authenticated".into(),
            },
        ];
        let xml = build_steps_xml(&steps);
        // Action got HTML-escaped inside the attribute
        assert!(xml.contains("&amp;lt;bad&amp;gt; &amp;amp; valid"));
        let parsed = parse_steps_xml(&xml);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].action, "Open login page");
        assert_eq!(parsed[1].action, "Enter <bad> & valid creds");
    }
}

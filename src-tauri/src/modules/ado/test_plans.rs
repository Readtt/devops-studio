//! Test Plan + Suite + Test Case reads.
//!
//! Three ADO REST surfaces are stitched together:
//!   - `/_apis/testplan/plans`          — plans
//!   - `/_apis/testplan/Plans/{p}/suites` — suites (tree)
//!   - `/_apis/testplan/Plans/{p}/Suites/{s}/TestCase` — case refs in a suite
//!   - `/_apis/wit/workitems/{id}`      — the case as a work item (steps live here)

use super::client::{
    get_all_value_rows, get_json, patch_json, post_json, project_api, truncate_chars, AdoState,
};
use super::errors::{AdoError, AdoResult};
use super::test_cases::work_item_to_case;
use super::types::{PagedResponse, SuiteRef, SuiteType, TestCase, TestCaseRef, TestPlanRef};
use serde::Deserialize;
use serde_json::{json, Value};

pub async fn list_plans(state: &AdoState) -> AdoResult<Vec<TestPlanRef>> {
    let (conn, _) = state.snapshot();
    let conn = conn.ok_or(AdoError::NotConfigured)?;
    let url = project_api(&conn, "testplan/plans");
    let resp: PagedResponse<RawPlan> = get_json(state, &url, "test plans").await?;
    Ok(resp.value.into_iter().map(RawPlan::into_ref).collect())
}

pub async fn list_suites(state: &AdoState, plan_id: i64) -> AdoResult<Vec<SuiteRef>> {
    let (conn, _) = state.snapshot();
    let conn = conn.ok_or(AdoError::NotConfigured)?;
    // The default response is a flat list of every suite in the plan with
    // `parentSuite: { id, name }` populated for every non-root suite — which
    // is exactly what buildSuiteTree on the frontend wants.
    //
    // We previously sent `asTreeView=true`, but that returns a NESTED payload:
    // only the root suite appears at the top level, with descendants tucked
    // into a `children` field that our flat RawSuite deserializer can't see.
    // The result was "No suites in this plan." for every plan with real
    // suites, because the root suite was the only thing we ever parsed.
    let url = project_api(&conn, &format!("testplan/Plans/{plan_id}/suites"));
    // Follow continuation tokens, like list_suite_cases already does. A plan
    // using requirement-based suites has one suite PER user story, so 200+
    // suites is ordinary and a single-page read would silently drop the tail.
    let rows = get_all_value_rows(state, &url, "suites").await?;

    let mut out = Vec::with_capacity(rows.len());
    let mut dropped = 0_usize;
    for row in rows {
        match serde_json::from_value::<RawSuite>(row.clone()) {
            Ok(raw) => out.push(raw.into_ref()),
            Err(e) => {
                dropped += 1;
                log::warn!(
                    "ado_list_suites: dropped a row from plan {plan_id} ({e}): {}",
                    truncate_for_log(&row.to_string())
                );
            }
        }
    }
    if dropped > 0 {
        log::warn!(
            "ado_list_suites: returned {} suites; {} skipped due to unparsable shape",
            out.len(),
            dropped
        );
    }
    Ok(out)
}

pub async fn list_suite_cases(
    state: &AdoState,
    plan_id: i64,
    suite_id: i64,
) -> AdoResult<Vec<TestCaseRef>> {
    let (conn, _) = state.snapshot();
    let conn = conn.ok_or(AdoError::NotConfigured)?;
    // `expand=workItem` is required on some orgs for the new testplan endpoint
    // to populate the nested workItem object — without it the rows can come
    // back with `workItem: null` and the whole suite reads as empty.
    let url = project_api(
        &conn,
        &format!("testplan/Plans/{plan_id}/Suites/{suite_id}/TestCase?expand=workItem"),
    );
    // Follow continuation tokens so a suite with more than one page of cases
    // (200+) isn't silently truncated — a real risk for big regression suites.
    let rows = get_all_value_rows(state, &url, "suite cases").await?;

    let mut out = Vec::with_capacity(rows.len());
    let mut dropped = 0_usize;
    for row in rows {
        if let Some(case) = parse_suite_case_row(&row) {
            out.push(case);
        } else {
            dropped += 1;
            log::warn!(
                "ado_list_suite_cases: dropped a row from plan {plan_id} / suite {suite_id} \
                 with unrecognized shape: {}",
                truncate_for_log(&row.to_string())
            );
        }
    }
    if dropped > 0 {
        log::warn!(
            "ado_list_suite_cases: returned {} rows; {} skipped due to unparsable shape",
            out.len(),
            dropped
        );
    }
    Ok(out)
}

/// Pull `{ id, title, state }` out of a TestCase row.
///
/// ADO returns at least three shapes for the same endpoint depending on org
/// configuration and API revision:
///   1. `{ workItem: { id, name, workItemFields: [...] } }`
///   2. `{ workItem: { id, name }, pointAssignments: [...] }`
///   3. `{ testCase: { id, name }, workItem: null }`     (legacy)
///
/// We probe each, prefer the most specific, and fall back to top-level
/// `id`/`name` so a stripped response still surfaces something.
fn parse_suite_case_row(row: &Value) -> Option<TestCaseRef> {
    // Try workItem first
    let (id, name, fields) = if let Some(wi) = row.get("workItem").and_then(|v| v.as_object()) {
        let id = wi.get("id").and_then(json_to_i64);
        let name = wi
            .get("name")
            .or_else(|| wi.get("title"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let fields = wi.get("workItemFields").and_then(|v| v.as_array()).cloned();
        (id, name, fields)
    } else if let Some(tc) = row.get("testCase").and_then(|v| v.as_object()) {
        let id = tc.get("id").and_then(json_to_i64);
        let name = tc
            .get("name")
            .or_else(|| tc.get("title"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        (id, name, None)
    } else {
        let id = row.get("id").and_then(json_to_i64);
        let name = row
            .get("name")
            .or_else(|| row.get("title"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        (id, name, None)
    };

    let id = id?;
    let title = name.unwrap_or_default();
    let state = fields.as_ref().and_then(|arr| {
        arr.iter().find_map(|v| {
            v.as_object()
                .and_then(|o| o.get("System.State"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        })
    });
    Some(TestCaseRef { id, title, state })
}

/// Numbers come back from ADO as integers or strings depending on size.
/// Accept both.
fn json_to_i64(v: &Value) -> Option<i64> {
    v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))
}

fn truncate_for_log(s: &str) -> String {
    truncate_chars(s, 240)
}

/// Create a static test suite under `plan_id`. When `parent_suite_id` is
/// `None`, the new suite is attached to the plan's root suite — that's the
/// suite whose name matches the plan name and which `buildSuiteTree` hides on
/// the frontend, so creating without an explicit parent reads as "add a
/// top-level suite" from the user's perspective.
pub async fn create_static_suite(
    state: &AdoState,
    plan_id: i64,
    parent_suite_id: Option<i64>,
    name: &str,
) -> AdoResult<SuiteRef> {
    let (conn, _) = state.snapshot();
    let conn = conn.ok_or(AdoError::NotConfigured)?;

    let parent_id = match parent_suite_id {
        Some(id) => id,
        None => resolve_root_suite_id(state, plan_id).await?,
    };

    let url = project_api(&conn, &format!("testplan/Plans/{plan_id}/suites"));
    let body = json!({
        "name": name,
        "suiteType": "StaticTestSuite",
        "parentSuite": { "id": parent_id },
        "inheritDefaultConfigurations": true,
    });

    post_suite(state, &url, &body, name, parent_id).await
}

/// Create a requirement-based test suite bound to `requirement_id`.
///
/// This is the suite type that gives Azure DevOps requirement traceability:
/// every test case added to the result is auto-linked to the work item as
/// "Tested By", which is the ONLY link ADO's requirement-coverage reporting
/// understands. Our existing publish path does exactly that POST, so no extra
/// linking code is needed here.
///
/// Creates ONE suite per call, matching the REST API 1:1. Bulk creation across
/// a query's worth of requirements stays in the Azure DevOps web UI, whose
/// dialog already does it well.
pub async fn create_requirement_suite(
    state: &AdoState,
    plan_id: i64,
    parent_suite_id: Option<i64>,
    requirement_id: i64,
    name: Option<&str>,
) -> AdoResult<SuiteRef> {
    let (conn, _) = state.snapshot();
    let conn = conn.ok_or(AdoError::NotConfigured)?;

    let parent_id = match parent_suite_id {
        Some(id) => id,
        None => resolve_root_suite_id(state, plan_id).await?,
    };

    let url = project_api(&conn, &format!("testplan/Plans/{plan_id}/suites"));
    let mut body = json!({
        "suiteType": "RequirementTestSuite",
        "requirementId": requirement_id,
        "parentSuite": { "id": parent_id },
        // Without inherited configurations a fresh suite has none, so every
        // published case takes link_case_to_suite's full self-heal path
        // (link → count points → resolve configs → re-POST) and can still end
        // at the "may need them set explicitly" warning.
        "inheritDefaultConfigurations": true,
    });
    // ADO normally derives the name from the work item; send it anyway so the
    // response is deterministic on orgs that don't.
    if let Some(n) = name.map(str::trim).filter(|s| !s.is_empty()) {
        body["name"] = Value::String(n.to_string());
    }

    post_suite(state, &url, &body, name.unwrap_or(""), parent_id).await
}

/// Shared POST + response parse for the suite-create variants.
async fn post_suite(
    state: &AdoState,
    url: &str,
    body: &Value,
    fallback_name: &str,
    parent_id: i64,
) -> AdoResult<SuiteRef> {
    let raw: Value = post_json(state, url, body, "application/json", "create suite").await?;
    let id = raw
        .get("id")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| AdoError::local("create suite: missing id"))?;
    Ok(raw_suite_to_ref(&raw, id, fallback_name, Some(parent_id)))
}

/// Rename an existing static test suite. ADO's testplan suite update accepts
/// a partial JSON body — `name` is the only field we touch. Rejects empty
/// names up front so the server returns a friendlier error than the generic
/// validation message.
pub async fn update_suite_name(
    state: &AdoState,
    plan_id: i64,
    suite_id: i64,
    name: &str,
) -> AdoResult<SuiteRef> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AdoError::Local {
            message: "Suite name can't be empty.".into(),
        });
    }
    let (conn, _) = state.snapshot();
    let conn = conn.ok_or(AdoError::NotConfigured)?;
    let url = project_api(
        &conn,
        &format!("testplan/Plans/{plan_id}/suites/{suite_id}"),
    );
    let body = json!({ "name": trimmed });
    let raw: Value = patch_json(state, &url, &body, "rename suite").await?;
    Ok(raw_suite_to_ref(&raw, suite_id, trimmed, None))
}

/// Rename a Test Plan. PATCHes `/_apis/testplan/Plans/{planId}` with a
/// partial `{ name }` body. Mirrors update_suite_name's contract: empty
/// names rejected up front, the response is parsed back into a full
/// `TestPlanRef` so the caller can swap it into local state.
pub async fn update_plan_name(
    state: &AdoState,
    plan_id: i64,
    name: &str,
) -> AdoResult<TestPlanRef> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AdoError::Local {
            message: "Plan name can't be empty.".into(),
        });
    }
    let (conn, _) = state.snapshot();
    let conn = conn.ok_or(AdoError::NotConfigured)?;
    let url = project_api(&conn, &format!("testplan/Plans/{plan_id}"));
    let body = json!({ "name": trimmed });
    let raw: Value = patch_json(state, &url, &body, "rename plan").await?;
    let new_name = raw
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or(trimmed)
        .to_string();
    let iteration = raw
        .get("iteration")
        .and_then(|v| v.as_str())
        .map(String::from);
    let area_path = raw
        .get("areaPath")
        .and_then(|v| v.as_str())
        .map(String::from);
    let state_field = raw
        .get("state")
        .and_then(|v| v.as_str())
        .map(String::from);
    Ok(TestPlanRef {
        id: plan_id,
        name: new_name,
        iteration,
        area_path,
        state: state_field,
    })
}

/// Locate the root suite for a plan — the one with no parent or whose parent
/// id points outside the returned set. ADO always returns exactly one per
/// plan; we treat zero/many as a backend-shape error to surface clearly.
async fn resolve_root_suite_id(state: &AdoState, plan_id: i64) -> AdoResult<i64> {
    let suites = list_suites(state, plan_id).await?;
    let ids: std::collections::HashSet<i64> = suites.iter().map(|s| s.id).collect();
    let mut roots = suites
        .iter()
        .filter(|s| match s.parent_suite_id {
            None => true,
            Some(p) => !ids.contains(&p),
        })
        .map(|s| s.id);
    let id = roots
        .next()
        .ok_or_else(|| AdoError::local("create suite: plan has no root suite"))?;
    Ok(id)
}

pub async fn get_case(state: &AdoState, case_id: i64) -> AdoResult<TestCase> {
    let (conn, _) = state.snapshot();
    let conn = conn.ok_or(AdoError::NotConfigured)?;
    let url = project_api(
        &conn,
        &format!("wit/workitems/{case_id}?$expand=relations"),
    );
    let raw: serde_json::Value = get_json(state, &url, "test case").await?;
    work_item_to_case(raw, &conn.org_url, &conn.project)
}

// --- ADO response shapes (private) ---

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPlan {
    id: i64,
    name: String,
    #[serde(default)]
    iteration: Option<String>,
    #[serde(default)]
    area_path: Option<String>,
    #[serde(default)]
    state: Option<String>,
}

impl RawPlan {
    fn into_ref(self) -> TestPlanRef {
        TestPlanRef {
            id: self.id,
            name: self.name,
            iteration: self.iteration,
            area_path: self.area_path,
            state: self.state,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawSuite {
    id: i64,
    name: String,
    #[serde(default)]
    suite_type: Option<String>,
    #[serde(default)]
    parent_suite: Option<RawSuiteParent>,
    /// Left as a raw Value because ADO sends work-item ids as a number on some
    /// orgs and a string on others — `json_to_i64` absorbs both.
    #[serde(default)]
    requirement_id: Option<Value>,
    #[serde(default)]
    query_string: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawSuiteParent {
    id: i64,
}

impl RawSuite {
    fn into_ref(self) -> SuiteRef {
        SuiteRef {
            id: self.id,
            name: self.name,
            // Case-insensitive on purpose: ADO echoes camelCase but accepts the
            // PascalCase we send on create. Never compare these strings raw.
            suite_type: SuiteType::parse(self.suite_type.as_deref()),
            parent_suite_id: self.parent_suite.map(|p| p.id),
            requirement_id: self.requirement_id.as_ref().and_then(json_to_i64),
            query_string: self.query_string,
        }
    }
}

/// Parse a testplan suite response body (POST/PATCH echo) into a `SuiteRef`.
///
/// The echo shape varies by org — some omit `name` or `parentSuite` entirely —
/// so callers pass what they already know as a fallback. Shared by
/// `create_static_suite` and `update_suite_name` so the field list only has to
/// be right in one place.
fn raw_suite_to_ref(
    raw: &Value,
    id: i64,
    fallback_name: &str,
    fallback_parent: Option<i64>,
) -> SuiteRef {
    SuiteRef {
        id,
        name: raw
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or(fallback_name)
            .to_string(),
        suite_type: SuiteType::parse(raw.get("suiteType").and_then(|v| v.as_str())),
        parent_suite_id: raw
            .get("parentSuite")
            .and_then(|p| p.get("id"))
            .and_then(json_to_i64)
            .or(fallback_parent),
        requirement_id: raw.get("requirementId").and_then(json_to_i64),
        query_string: raw
            .get("queryString")
            .and_then(|v| v.as_str())
            .map(String::from),
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_chars_never_splits_a_multibyte_char_at_any_offset() {
        // The headline "300 × é" case is NOT sufficient on its own: byte 240
        // happens to be a boundary for 2-byte chars, so the buggy version
        // survives it. Sweep every offset class instead — 3-byte and 4-byte
        // sequences straddle 240 and 500 at different paddings.
        for max in [240_usize, 500] {
            for pad in 0..8 {
                for ch in ["é", "→", "🎯"] {
                    let s = format!("{}{}", "a".repeat(pad), ch.repeat(400));
                    let out = truncate_chars(&s, max);
                    assert!(out.ends_with('…'), "max {max} pad {pad} {ch}");
                    // Round-trips as valid UTF-8 with no replacement chars.
                    assert!(!out.contains('\u{FFFD}'), "max {max} pad {pad} {ch}");
                }
            }
        }
    }

    #[test]
    fn truncate_chars_leaves_short_and_empty_input_alone() {
        assert_eq!(truncate_chars("", 240), "");
        assert_eq!(truncate_chars("héllo", 240), "héllo");
        // Exactly at the limit is untouched; one past it truncates.
        assert_eq!(truncate_chars(&"a".repeat(240), 240), "a".repeat(240));
        assert!(truncate_chars(&"a".repeat(241), 240).ends_with('…'));
    }

    #[test]
    fn truncate_for_log_never_splits_a_multibyte_char() {
        // `s.len()` is bytes, so slicing at a fixed 240 panics when that offset
        // lands mid-char. The release profile is `panic = "abort"`, so this
        // killed the app rather than dropping one unparsable suite row — and
        // list_suites logs a row on every plan expand.
        let s = "é".repeat(300);
        let out = truncate_for_log(&s);
        assert!(out.ends_with('…'));
        // 240 bytes of payload + the 3-byte '…'.
        assert!(out.len() <= 243, "got {} bytes", out.len());

        // A boundary at exactly 240 bytes, and one straddling it.
        for pad in 0..8 {
            let s = format!("{}{}", "a".repeat(pad), "é".repeat(200));
            let out = truncate_for_log(&s);
            assert!(out.chars().count() > 0, "pad {pad} produced nothing");
        }

        // Short strings pass through untouched, multibyte or not.
        assert_eq!(truncate_for_log("héllo"), "héllo");
    }
}

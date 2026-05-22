//! Test Plan + Suite + Test Case reads.
//!
//! Three ADO REST surfaces are stitched together:
//!   - `/_apis/testplan/plans`          — plans
//!   - `/_apis/testplan/Plans/{p}/suites` — suites (tree)
//!   - `/_apis/testplan/Plans/{p}/Suites/{s}/TestCase` — case refs in a suite
//!   - `/_apis/wit/workitems/{id}`      — the case as a work item (steps live here)

use super::client::{get_json, get_raw_json, patch_json, post_json, project_api, AdoState};
use super::errors::{AdoError, AdoResult};
use super::test_cases::work_item_to_case;
use super::types::{PagedResponse, SuiteRef, TestCase, TestCaseRef, TestPlanRef};
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
    let resp: PagedResponse<RawSuite> = get_json(state, &url, "suites").await?;
    Ok(resp.value.into_iter().map(RawSuite::into_ref).collect())
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
    let raw: Value = get_raw_json(state, &url, "suite cases").await?;
    let rows = raw
        .get("value")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

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
    if s.len() <= 240 { s.to_string() } else { format!("{}…", &s[..240]) }
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
    });

    let raw: Value = post_json(state, &url, &body, "application/json", "create suite").await?;
    let id = raw
        .get("id")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| AdoError::local("create suite: missing id"))?;
    let new_name = raw
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or(name)
        .to_string();
    let suite_type = raw
        .get("suiteType")
        .and_then(|v| v.as_str())
        .map(String::from);
    Ok(SuiteRef {
        id,
        name: new_name,
        suite_type,
        parent_suite_id: Some(parent_id),
    })
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
    let new_name = raw
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or(trimmed)
        .to_string();
    let suite_type = raw
        .get("suiteType")
        .and_then(|v| v.as_str())
        .map(String::from);
    let parent_suite_id = raw
        .get("parentSuite")
        .and_then(|p| p.get("id"))
        .and_then(json_to_i64);
    Ok(SuiteRef {
        id: suite_id,
        name: new_name,
        suite_type,
        parent_suite_id,
    })
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
            suite_type: self.suite_type,
            parent_suite_id: self.parent_suite.map(|p| p.id),
        }
    }
}


//! Test Plan + Suite + Test Case reads.
//!
//! Three ADO REST surfaces are stitched together:
//!   - `/_apis/testplan/plans`          — plans
//!   - `/_apis/testplan/Plans/{p}/suites` — suites (tree)
//!   - `/_apis/testplan/Plans/{p}/Suites/{s}/TestCase` — case refs in a suite
//!   - `/_apis/wit/workitems/{id}`      — the case as a work item (steps live here)

use super::client::{get_json, project_api, AdoState};
use super::errors::{AdoError, AdoResult};
use super::test_cases::work_item_to_case;
use super::types::{PagedResponse, SuiteRef, TestCase, TestCaseRef, TestPlanRef};
use serde::Deserialize;

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
    let url = project_api(
        &conn,
        &format!("testplan/Plans/{plan_id}/suites?asTreeView=true"),
    );
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
    let url = project_api(
        &conn,
        &format!("testplan/Plans/{plan_id}/Suites/{suite_id}/TestCase"),
    );
    let resp: PagedResponse<RawSuiteCase> = get_json(state, &url, "suite cases").await?;
    Ok(resp.value.into_iter().filter_map(RawSuiteCase::into_ref).collect())
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawSuiteCase {
    #[serde(default)]
    work_item: Option<RawSuiteCaseWorkItem>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawSuiteCaseWorkItem {
    id: i64,
    name: Option<String>,
    #[serde(default)]
    work_item_fields: Option<Vec<serde_json::Value>>,
}

impl RawSuiteCase {
    fn into_ref(self) -> Option<TestCaseRef> {
        let wi = self.work_item?;
        // The testplan suite endpoint returns the case title under `name`;
        // older API versions surface a fields array. Either is fine.
        let state = wi.work_item_fields.as_ref().and_then(|arr| {
            arr.iter().find_map(|v| {
                v.as_object()
                    .and_then(|o| o.get("System.State"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
            })
        });
        Some(TestCaseRef {
            id: wi.id,
            title: wi.name.unwrap_or_default(),
            state,
        })
    }
}

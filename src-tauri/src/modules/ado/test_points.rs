//! Test execution: reading test points for a case-in-suite and recording
//! Pass / Fail / Blocked / Not Applicable outcomes — the ADO "Execute" flow.
//!
//! ADO models execution on TEST POINTS, not on the test-case work item. A
//! point is the (test case × configuration) pair inside one suite of one
//! plan, so the same case living in two suites carries two independent
//! outcomes. We read and update the point's latest outcome via the TestPlan
//! REST surface:
//!   GET   testplan/Plans/{p}/Suites/{s}/TestPoint?testCaseId={c}
//!   PATCH testplan/Plans/{p}/Suites/{s}/TestPoint   (body: [{ id, results:{outcome} }])
//!
//! The "which suites contain this case" lookup uses the older test API
//! (`test/suites?testCaseId=`) which is the only endpoint that answers it.

use super::client::{get_raw_json, patch_json, patch_json_patch, project_api, AdoState};
use super::errors::{AdoError, AdoResult};
use super::types::{CaseSuiteMembership, TestPointInfo};
use serde_json::{json, Value};

/// Numbers come back from ADO as integers or strings depending on size and
/// endpoint. Accept both. (Mirrors the helper in `test_plans.rs`.)
fn json_to_i64(v: &Value) -> Option<i64> {
    v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))
}

/// Outcomes the Execute bar is allowed to set. ADO's enum is larger, but
/// these are the ones we surface — plus `Active` which resets a point back to
/// "not run". Rejecting anything else keeps a typo in a chat-driven payload
/// from reaching the wire as a silently-ignored outcome.
fn validate_outcome(outcome: &str) -> AdoResult<&str> {
    match outcome {
        "Passed" | "Failed" | "Blocked" | "NotApplicable" | "Active" => Ok(outcome),
        other => Err(AdoError::local(format!(
            "Unsupported outcome '{other}'. Expected Passed, Failed, Blocked, NotApplicable, or Active."
        ))),
    }
}

/// List the test points for one case inside one suite. Usually one row, but a
/// suite with multiple test configurations yields one point per configuration.
pub async fn list_test_points(
    state: &AdoState,
    plan_id: i64,
    suite_id: i64,
    case_id: i64,
) -> AdoResult<Vec<TestPointInfo>> {
    let (conn, _) = state.snapshot();
    let conn = conn.ok_or(AdoError::NotConfigured)?;
    let url = project_api(
        &conn,
        &format!("testplan/Plans/{plan_id}/Suites/{suite_id}/TestPoint?testCaseId={case_id}"),
    );
    let raw: Value = get_raw_json(state, &url, "test points").await?;
    let rows = raw
        .get("value")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(rows.iter().filter_map(parse_test_point).collect())
}

/// Record an outcome on a single test point. Returns the updated point so the
/// caller can reflect the new state without a second round trip; we parse it
/// out of the PATCH response when present and synthesize it from the known
/// inputs otherwise (the renderer reloads the list either way).
pub async fn set_test_point_outcome(
    state: &AdoState,
    plan_id: i64,
    suite_id: i64,
    point_id: i64,
    outcome: &str,
) -> AdoResult<TestPointInfo> {
    let outcome = validate_outcome(outcome)?;
    let (conn, _) = state.snapshot();
    let conn = conn.ok_or(AdoError::NotConfigured)?;
    let url = project_api(
        &conn,
        &format!("testplan/Plans/{plan_id}/Suites/{suite_id}/TestPoint"),
    );
    // The TestPlan "update points" endpoint takes an ARRAY of point updates.
    let body = json!([{ "id": point_id, "results": { "outcome": outcome } }]);
    let raw: Value = patch_json(state, &url, &body, "set test outcome").await?;

    // Response is either `{ value: [point] }`, a bare `[point]`, or the single
    // point object. Probe all three to enrich config/tester — but ALWAYS
    // return the outcome we just wrote. ADO's PATCH echo can lag (it sometimes
    // returns the prior `results.outcome` until the result record settles), so
    // trusting the echoed outcome would make the UI show the old value right
    // after a successful write — exactly the "switching doesn't stick" bug.
    let echoed = raw
        .get("value")
        .and_then(|v| v.as_array())
        .and_then(|a| a.first())
        .or_else(|| raw.as_array().and_then(|a| a.first()))
        .map(|p| p.to_owned())
        .or_else(|| raw.as_object().map(|_| raw.clone()))
        .and_then(|p| parse_test_point(&p));

    Ok(match echoed {
        Some(point) => TestPointInfo {
            outcome: outcome.to_string(),
            ..point
        },
        None => TestPointInfo {
            id: point_id,
            configuration_id: None,
            configuration_name: None,
            outcome: outcome.to_string(),
            tester: None,
            last_updated: None,
        },
    })
}

/// Drop a note onto the case's discussion (System.History). Used to preserve
/// a tester's failure reason in ADO when they record a Fail/Blocked outcome —
/// the TestPoint API has no per-point comment field, so the case discussion
/// is the durable place for it.
pub async fn add_case_comment(state: &AdoState, case_id: i64, comment: &str) -> AdoResult<()> {
    let (conn, _) = state.snapshot();
    let conn = conn.ok_or(AdoError::NotConfigured)?;
    let url = project_api(&conn, &format!("wit/workitems/{case_id}"));
    let ops = json!([{ "op": "add", "path": "/fields/System.History", "value": comment }]);
    let _: Value = patch_json_patch(state, &url, &ops, "add case comment").await?;
    Ok(())
}

/// Find every (plan, suite) that contains a given test case. Uses the legacy
/// test API — `testplan` has no equivalent reverse lookup.
pub async fn list_suites_for_case(
    state: &AdoState,
    case_id: i64,
) -> AdoResult<Vec<CaseSuiteMembership>> {
    let (conn, _) = state.snapshot();
    let conn = conn.ok_or(AdoError::NotConfigured)?;
    let url = project_api(&conn, &format!("test/suites?testCaseId={case_id}"));
    let raw: Value = get_raw_json(state, &url, "suites for case").await?;
    let rows = raw
        .get("value")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(rows.iter().filter_map(parse_membership).collect())
}

fn parse_test_point(row: &Value) -> Option<TestPointInfo> {
    let obj = row.as_object()?;
    let id = obj.get("id").and_then(json_to_i64)?;

    let (configuration_id, configuration_name) =
        match obj.get("configuration").and_then(|v| v.as_object()) {
            Some(cfg) => (
                cfg.get("id").and_then(json_to_i64),
                cfg.get("name").and_then(|v| v.as_str()).map(String::from),
            ),
            None => (None, None),
        };

    // `results.outcome` is the modern testplan shape; older orgs nest it under
    // `lastResult`. Default to "Unspecified" so a never-run point reads as
    // "not run" rather than blank.
    let results = obj.get("results").and_then(|v| v.as_object());
    let outcome = results
        .and_then(|r| r.get("outcome"))
        .or_else(|| obj.get("lastResult").and_then(|v| v.get("outcome")))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(String::from)
        .unwrap_or_else(|| "Unspecified".to_string());

    let tester = obj
        .get("tester")
        .and_then(|v| v.as_object())
        .and_then(|t| {
            t.get("displayName")
                .or_else(|| t.get("uniqueName"))
                .and_then(|v| v.as_str())
        })
        .map(String::from);

    let last_updated = results
        .and_then(|r| r.get("lastUpdatedDate"))
        .and_then(|v| v.as_str())
        .map(String::from);

    Some(TestPointInfo {
        id,
        configuration_id,
        configuration_name,
        outcome,
        tester,
        last_updated,
    })
}

fn parse_membership(row: &Value) -> Option<CaseSuiteMembership> {
    let obj = row.as_object()?;
    let suite_id = obj.get("id").and_then(json_to_i64)?;
    let suite_name = obj.get("name").and_then(|v| v.as_str()).map(String::from);
    let plan = obj.get("plan").and_then(|v| v.as_object());
    let plan_id = plan.and_then(|p| p.get("id")).and_then(json_to_i64)?;
    let plan_name = plan
        .and_then(|p| p.get("name"))
        .and_then(|v| v.as_str())
        .map(String::from);
    Some(CaseSuiteMembership {
        plan_id,
        plan_name,
        suite_id,
        suite_name,
    })
}

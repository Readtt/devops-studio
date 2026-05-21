//! Local persistence of completed generation runs.
//!
//! Stores each `GenerationRun` to `runs.json` in the app's data directory
//! via `tauri-plugin-store` (already a project dep — no extra crate). The
//! file holds the most-recent N runs as a JSON array, oldest dropped first
//! when the cap is exceeded.
//!
//! This is local-only by design: history is a productivity nicety, not a
//! shared artefact. Anything the user wants permanent goes to ADO via
//! `ado_create_case_in_suite` / `ado_create_bug`.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

const STORE_PATH: &str = "devops-studio-history.json";
const KEY_RUNS: &str = "runs";
const MAX_RUNS: usize = 100;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationRun {
    /// Stable id (UUID/short slug) chosen by the caller. The history store
    /// upserts on it so re-saving the same run replaces the prior entry.
    pub id: String,
    /// ISO-8601 timestamp (UTC) of when the run completed.
    pub timestamp: String,
    pub plan_id: Option<i64>,
    pub plan_name: Option<String>,
    pub suite_id: Option<i64>,
    pub suite_name: Option<String>,
    /// Generation mode label (e.g. "happy-path", "thorough", "bug-hunt").
    pub mode: String,
    /// First 500 chars of the requirements/spec the user fed in. Trimming is
    /// the caller's job — we just store what we're given.
    #[serde(default)]
    pub spec_excerpt: Option<String>,
    pub cases: Vec<CaseSummary>,
    pub bugs: Vec<BugSummary>,
    pub publish_log: Vec<PublishLogEntry>,
    /// "draft" — generated and saved at review time, never published.
    /// "published" — at least one case/bug was published (see publish_log).
    /// Old entries from before this field existed were only saved by the
    /// publish path; migrate them to "published" on read so the UI doesn't
    /// surface them all as drafts.
    #[serde(default)]
    pub status: Option<String>,
    /// Full draft body — the structured ReviewedCase[] / ReviewedBug[] +
    /// requirements + mode the session held when the row was saved. Present
    /// on drafts so the Generator can fully restore review state when the
    /// user clicks "Open" in the history pane. Absent on legacy / published
    /// rows that only stored titles. Rust treats the payload as opaque JSON;
    /// the TS side owns the schema.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub draft_payload: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaseSummary {
    pub title: String,
    /// Set after publish succeeds; None means the case was generated but never
    /// published (skipped, failed, or still in draft).
    #[serde(default)]
    pub ado_id: Option<i64>,
    #[serde(default)]
    pub web_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BugSummary {
    pub title: String,
    pub severity: String,
    #[serde(default)]
    pub ado_id: Option<i64>,
    #[serde(default)]
    pub web_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishLogEntry {
    pub uid: String,
    /// "case" | "bug".
    pub kind: String,
    pub title: String,
    /// "ok" | "failed" | "skipped".
    pub status: String,
    #[serde(default)]
    pub error: Option<String>,
}

fn load_runs(app: &AppHandle) -> Vec<GenerationRun> {
    let Ok(store) = app.store(STORE_PATH) else {
        return Vec::new();
    };
    let mut runs: Vec<GenerationRun> = match store.get(KEY_RUNS) {
        Some(v) => serde_json::from_value(v).unwrap_or_default(),
        None => Vec::new(),
    };
    // Migrate pre-status entries: anything stored before the status field
    // existed could only have come from the publish path, so treat it as
    // published rather than surfacing the whole archive as drafts.
    for r in &mut runs {
        if r.status.is_none() {
            r.status = Some("published".into());
        }
    }
    runs
}

fn save_runs(app: &AppHandle, runs: &[GenerationRun]) -> Result<(), String> {
    let store = app.store(STORE_PATH).map_err(|e| e.to_string())?;
    store.set(KEY_RUNS, serde_json::to_value(runs).map_err(|e| e.to_string())?);
    store.save().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn history_save_run(app: AppHandle, run: GenerationRun) -> Result<(), String> {
    let mut runs = load_runs(&app);
    if let Some(idx) = runs.iter().position(|r| r.id == run.id) {
        runs[idx] = run;
    } else {
        runs.push(run);
    }
    // Newest first; trim to cap.
    runs.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    if runs.len() > MAX_RUNS {
        runs.truncate(MAX_RUNS);
    }
    save_runs(&app, &runs)
}

#[tauri::command]
pub async fn history_list_runs(app: AppHandle) -> Result<Vec<GenerationRun>, String> {
    Ok(load_runs(&app))
}

#[tauri::command]
pub async fn history_get_run(
    app: AppHandle,
    run_id: String,
) -> Result<Option<GenerationRun>, String> {
    Ok(load_runs(&app).into_iter().find(|r| r.id == run_id))
}

#[tauri::command]
pub async fn history_delete_run(app: AppHandle, run_id: String) -> Result<(), String> {
    let mut runs = load_runs(&app);
    let before = runs.len();
    runs.retain(|r| r.id != run_id);
    if runs.len() == before {
        return Ok(());
    }
    save_runs(&app, &runs)
}

#[cfg(test)]
mod tests {
    // Note: these tests can't easily run against a real Tauri store. The
    // pure logic (upsert, sort, truncate) lives inline above; integration
    // tests with a temp dir would belong to a Phase 2 test pass.
    use super::*;

    #[test]
    fn run_serializes_with_camel_case() {
        let run = GenerationRun {
            id: "r1".into(),
            timestamp: "2026-05-20T12:00:00Z".into(),
            plan_id: Some(7),
            plan_name: Some("Sprint 42".into()),
            suite_id: None,
            suite_name: None,
            mode: "thorough".into(),
            spec_excerpt: None,
            cases: vec![],
            bugs: vec![],
            publish_log: vec![],
            status: Some("draft".into()),
            draft_payload: None,
        };
        let j = serde_json::to_value(&run).unwrap();
        assert_eq!(j["planId"], 7);
        assert_eq!(j["planName"], "Sprint 42");
        // snake_case keys should not leak.
        assert!(j.get("plan_id").is_none());
        assert!(j.get("publish_log").is_none());
        assert_eq!(j["publishLog"].as_array().unwrap().len(), 0);
    }
}

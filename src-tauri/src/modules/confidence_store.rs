//! Local SQLite-backed persistence for test-case confidence verdicts.
//!
//! Schema:
//!   confidence (
//!     case_id      INTEGER PRIMARY KEY,
//!     verdict_json TEXT NOT NULL,   -- JSON: ConfidenceVerdict from the TS side
//!     updated_at   TEXT NOT NULL
//!   );
//!
//! Keyed by case id alone: a verdict is about the case definition vs the code,
//! not which suite it's viewed in. The verdict JSON is opaque to Rust (the TS
//! side owns the shape) so it stays forward-compatible. Verdicts are local and
//! recomputable — only the resulting Pass/Fail is ever written back to ADO.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, State};

#[derive(Default)]
pub struct ConfidenceStoreState {
    inner: Arc<Mutex<Option<Connection>>>,
}

impl ConfidenceStoreState {
    fn with_conn<F, R>(&self, app: &AppHandle, f: F) -> Result<R, String>
    where
        F: FnOnce(&mut Connection) -> Result<R, String>,
    {
        let mut guard = self
            .inner
            .lock()
            .map_err(|e| format!("confidence lock: {e}"))?;
        if guard.is_none() {
            let path = sqlite_path(app)?;
            let conn = Connection::open(&path).map_err(|e| e.to_string())?;
            init_schema(&conn)?;
            *guard = Some(conn);
        }
        let conn = guard.as_mut().expect("connection initialized above");
        f(conn)
    }
}

fn sqlite_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("local data dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("confidence.sqlite"))
}

fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS confidence (
            case_id      INTEGER PRIMARY KEY,
            verdict_json TEXT NOT NULL,
            updated_at   TEXT NOT NULL
        );
        "#,
    )
    .map_err(|e| e.to_string())
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ConfidenceRow {
    pub case_id: i64,
    /// Opaque JSON-encoded ConfidenceVerdict, owned by the TS side.
    pub verdict_json: String,
    pub updated_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfidenceSaveInput {
    pub case_id: i64,
    pub verdict_json: String,
    pub updated_at: String,
}

#[tauri::command]
pub async fn confidence_save(
    app: AppHandle,
    state: State<'_, ConfidenceStoreState>,
    input: ConfidenceSaveInput,
) -> Result<(), String> {
    state.with_conn(&app, |conn| {
        conn.execute(
            "INSERT OR REPLACE INTO confidence (case_id, verdict_json, updated_at)
             VALUES (?1, ?2, ?3)",
            params![input.case_id, input.verdict_json, input.updated_at],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
}

/// Drop a stored verdict. Called when a case's steps change so a stale score
/// can't reappear when the case is reopened.
#[tauri::command]
pub async fn confidence_delete(
    app: AppHandle,
    state: State<'_, ConfidenceStoreState>,
    case_id: i64,
) -> Result<(), String> {
    state.with_conn(&app, |conn| {
        conn.execute("DELETE FROM confidence WHERE case_id = ?1", params![case_id])
            .map_err(|e| e.to_string())?;
        Ok(())
    })
}

#[tauri::command]
pub async fn confidence_get(
    app: AppHandle,
    state: State<'_, ConfidenceStoreState>,
    case_id: i64,
) -> Result<Option<ConfidenceRow>, String> {
    state.with_conn(&app, |conn| {
        let mut stmt = conn
            .prepare(
                "SELECT case_id, verdict_json, updated_at FROM confidence WHERE case_id = ?1",
            )
            .map_err(|e| e.to_string())?;
        stmt.query_row(params![case_id], |r| {
            Ok(ConfidenceRow {
                case_id: r.get(0)?,
                verdict_json: r.get(1)?,
                updated_at: r.get(2)?,
            })
        })
        .optional()
        .map_err(|e| e.to_string())
    })
}

#[tauri::command]
pub async fn confidence_get_many(
    app: AppHandle,
    state: State<'_, ConfidenceStoreState>,
    case_ids: Vec<i64>,
) -> Result<Vec<ConfidenceRow>, String> {
    if case_ids.is_empty() {
        return Ok(Vec::new());
    }
    state.with_conn(&app, |conn| {
        // Build a parameter list (?,?,…). Case-id counts are small (a suite),
        // so a single IN query is fine.
        let placeholders = case_ids
            .iter()
            .map(|_| "?")
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT case_id, verdict_json, updated_at FROM confidence WHERE case_id IN ({placeholders})"
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let params: Vec<&dyn rusqlite::ToSql> =
            case_ids.iter().map(|id| id as &dyn rusqlite::ToSql).collect();
        let rows = stmt
            .query_map(params.as_slice(), |r| {
                Ok(ConfidenceRow {
                    case_id: r.get(0)?,
                    verdict_json: r.get(1)?,
                    updated_at: r.get(2)?,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| e.to_string())?);
        }
        Ok(out)
    })
}

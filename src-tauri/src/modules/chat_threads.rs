//! Local SQLite-backed persistence for suite-chat threads.
//!
//! Schema (v1):
//!   chat_threads (
//!     plan_id    INTEGER NOT NULL,
//!     suite_id   INTEGER NOT NULL,
//!     model_id   TEXT,
//!     messages   TEXT NOT NULL,   -- JSON: ChatMessage[] from the TS side
//!     updated_at TEXT NOT NULL,
//!     PRIMARY KEY (plan_id, suite_id)
//!   );
//!
//! We persist one auto-saved thread per (plan, suite). The UI's "New thread"
//! button clears the row in place; multi-thread history is a follow-up.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, State};

#[derive(Default)]
pub struct ChatThreadsState {
    inner: Arc<Mutex<Option<Connection>>>,
}

impl ChatThreadsState {
    fn with_conn<F, R>(&self, app: &AppHandle, f: F) -> Result<R, String>
    where
        F: FnOnce(&mut Connection) -> Result<R, String>,
    {
        let mut guard = self
            .inner
            .lock()
            .map_err(|e| format!("chat_threads lock: {e}"))?;
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
    Ok(dir.join("chat_threads.sqlite"))
}

fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS chat_threads (
            plan_id    INTEGER NOT NULL,
            suite_id   INTEGER NOT NULL,
            model_id   TEXT,
            messages   TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (plan_id, suite_id)
        );
        "#,
    )
    .map_err(|e| e.to_string())
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChatThread {
    pub plan_id: i64,
    pub suite_id: i64,
    pub model_id: Option<String>,
    /// Opaque JSON-encoded messages array, owned by the TS side. The Rust
    /// store doesn't introspect — it just stores the blob so schema drift
    /// on the TS message shape is forward-compatible.
    pub messages: String,
    pub updated_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatThreadSaveInput {
    pub plan_id: i64,
    pub suite_id: i64,
    pub model_id: Option<String>,
    pub messages: String,
    pub updated_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatThreadKey {
    pub plan_id: i64,
    pub suite_id: i64,
}

#[tauri::command]
pub async fn chat_threads_save(
    app: AppHandle,
    state: State<'_, ChatThreadsState>,
    input: ChatThreadSaveInput,
) -> Result<(), String> {
    state.with_conn(&app, |conn| {
        conn.execute(
            "INSERT OR REPLACE INTO chat_threads (plan_id, suite_id, model_id, messages, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                input.plan_id,
                input.suite_id,
                input.model_id,
                input.messages,
                input.updated_at,
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
}

#[tauri::command]
pub async fn chat_threads_get(
    app: AppHandle,
    state: State<'_, ChatThreadsState>,
    input: ChatThreadKey,
) -> Result<Option<ChatThread>, String> {
    state.with_conn(&app, |conn| {
        let mut stmt = conn
            .prepare(
                "SELECT plan_id, suite_id, model_id, messages, updated_at
                 FROM chat_threads
                 WHERE plan_id = ?1 AND suite_id = ?2",
            )
            .map_err(|e| e.to_string())?;
        let row = stmt
            .query_row(params![input.plan_id, input.suite_id], |r| {
                Ok(ChatThread {
                    plan_id: r.get(0)?,
                    suite_id: r.get(1)?,
                    model_id: r.get(2)?,
                    messages: r.get(3)?,
                    updated_at: r.get(4)?,
                })
            });
        match row {
            Ok(t) => Ok(Some(t)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    })
}

#[tauri::command]
pub async fn chat_threads_delete(
    app: AppHandle,
    state: State<'_, ChatThreadsState>,
    input: ChatThreadKey,
) -> Result<(), String> {
    state.with_conn(&app, |conn| {
        conn.execute(
            "DELETE FROM chat_threads WHERE plan_id = ?1 AND suite_id = ?2",
            params![input.plan_id, input.suite_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
}

#[tauri::command]
pub async fn chat_threads_list(
    app: AppHandle,
    state: State<'_, ChatThreadsState>,
) -> Result<Vec<ChatThread>, String> {
    state.with_conn(&app, |conn| {
        let mut stmt = conn
            .prepare(
                "SELECT plan_id, suite_id, model_id, messages, updated_at
                 FROM chat_threads
                 ORDER BY updated_at DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(ChatThread {
                    plan_id: r.get(0)?,
                    suite_id: r.get(1)?,
                    model_id: r.get(2)?,
                    messages: r.get(3)?,
                    updated_at: r.get(4)?,
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

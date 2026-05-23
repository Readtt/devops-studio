//! Local SQLite-backed persistence for suite-chat threads.
//!
//! Schema (v2):
//!   chat_threads (
//!     plan_id    INTEGER NOT NULL,
//!     suite_id   INTEGER NOT NULL,
//!     thread_id  TEXT NOT NULL,
//!     title      TEXT,
//!     model_id   TEXT,
//!     messages   TEXT NOT NULL,   -- JSON: ChatMessage[] from the TS side
//!     updated_at TEXT NOT NULL,
//!     PRIMARY KEY (plan_id, suite_id, thread_id)
//!   );
//!
//! v1 used `(plan_id, suite_id)` as the primary key and stored a single
//! thread per suite — the `New thread` button wiped the row. v2 adds
//! `thread_id` (TEXT, opaque to Rust) so the UI can keep multiple parallel
//! threads on the same suite. Existing v1 rows migrate as
//! `thread_id = "default"` so no chat history is lost on upgrade.

use rusqlite::{params, Connection, OptionalExtension};
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
    // Migration path: v1 had no `thread_id` column. ALTER TABLE can't change
    // a primary key in SQLite, so when we detect the v1 shape we rename the
    // old table out of the way, create the v2 table, and copy rows over
    // with thread_id="default".
    let has_table = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='chat_threads'",
            [],
            |_| Ok(true),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or(false);

    if has_table {
        let has_thread_id = column_exists(conn, "chat_threads", "thread_id")?;
        if !has_thread_id {
            conn.execute_batch(
                r#"
                ALTER TABLE chat_threads RENAME TO chat_threads_v1;
                CREATE TABLE chat_threads (
                    plan_id    INTEGER NOT NULL,
                    suite_id   INTEGER NOT NULL,
                    thread_id  TEXT NOT NULL,
                    title      TEXT,
                    model_id   TEXT,
                    messages   TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (plan_id, suite_id, thread_id)
                );
                INSERT INTO chat_threads (plan_id, suite_id, thread_id, title, model_id, messages, updated_at)
                SELECT plan_id, suite_id, 'default', NULL, model_id, messages, updated_at FROM chat_threads_v1;
                DROP TABLE chat_threads_v1;
                "#,
            )
            .map_err(|e| format!("chat_threads v1→v2 migration: {e}"))?;
        }
    } else {
        conn.execute_batch(
            r#"
            CREATE TABLE chat_threads (
                plan_id    INTEGER NOT NULL,
                suite_id   INTEGER NOT NULL,
                thread_id  TEXT NOT NULL,
                title      TEXT,
                model_id   TEXT,
                messages   TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (plan_id, suite_id, thread_id)
            );
            "#,
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn column_exists(conn: &Connection, table: &str, col: &str) -> Result<bool, String> {
    let sql = format!("PRAGMA table_info({})", table);
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            let name: String = r.get(1)?;
            Ok(name)
        })
        .map_err(|e| e.to_string())?;
    for r in rows {
        if r.map_err(|e| e.to_string())? == col {
            return Ok(true);
        }
    }
    Ok(false)
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChatThread {
    pub plan_id: i64,
    pub suite_id: i64,
    pub thread_id: String,
    pub title: Option<String>,
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
    pub thread_id: String,
    pub title: Option<String>,
    pub model_id: Option<String>,
    pub messages: String,
    pub updated_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatThreadKey {
    pub plan_id: i64,
    pub suite_id: i64,
    pub thread_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatThreadSuiteKey {
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
            "INSERT OR REPLACE INTO chat_threads (plan_id, suite_id, thread_id, title, model_id, messages, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                input.plan_id,
                input.suite_id,
                input.thread_id,
                input.title,
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
                "SELECT plan_id, suite_id, thread_id, title, model_id, messages, updated_at
                 FROM chat_threads
                 WHERE plan_id = ?1 AND suite_id = ?2 AND thread_id = ?3",
            )
            .map_err(|e| e.to_string())?;
        let row = stmt.query_row(
            params![input.plan_id, input.suite_id, input.thread_id],
            |r| {
                Ok(ChatThread {
                    plan_id: r.get(0)?,
                    suite_id: r.get(1)?,
                    thread_id: r.get(2)?,
                    title: r.get(3)?,
                    model_id: r.get(4)?,
                    messages: r.get(5)?,
                    updated_at: r.get(6)?,
                })
            },
        );
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
            "DELETE FROM chat_threads WHERE plan_id = ?1 AND suite_id = ?2 AND thread_id = ?3",
            params![input.plan_id, input.suite_id, input.thread_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
}

/// Delete EVERY thread under a (planId, suiteId). Used by "Delete all
/// chats for this suite" in the history panel.
#[tauri::command]
pub async fn chat_threads_delete_suite(
    app: AppHandle,
    state: State<'_, ChatThreadsState>,
    input: ChatThreadSuiteKey,
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
                "SELECT plan_id, suite_id, thread_id, title, model_id, messages, updated_at
                 FROM chat_threads
                 ORDER BY updated_at DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(ChatThread {
                    plan_id: r.get(0)?,
                    suite_id: r.get(1)?,
                    thread_id: r.get(2)?,
                    title: r.get(3)?,
                    model_id: r.get(4)?,
                    messages: r.get(5)?,
                    updated_at: r.get(6)?,
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

/// List every thread belonging to a specific (planId, suiteId). Powers the
/// thread switcher in the suite-chat header without forcing the UI to filter
/// the global list client-side.
#[tauri::command]
pub async fn chat_threads_list_for_suite(
    app: AppHandle,
    state: State<'_, ChatThreadsState>,
    input: ChatThreadSuiteKey,
) -> Result<Vec<ChatThread>, String> {
    state.with_conn(&app, |conn| {
        let mut stmt = conn
            .prepare(
                "SELECT plan_id, suite_id, thread_id, title, model_id, messages, updated_at
                 FROM chat_threads
                 WHERE plan_id = ?1 AND suite_id = ?2
                 ORDER BY updated_at DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![input.plan_id, input.suite_id], |r| {
                Ok(ChatThread {
                    plan_id: r.get(0)?,
                    suite_id: r.get(1)?,
                    thread_id: r.get(2)?,
                    title: r.get(3)?,
                    model_id: r.get(4)?,
                    messages: r.get(5)?,
                    updated_at: r.get(6)?,
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

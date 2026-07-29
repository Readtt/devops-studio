//! Local SQLite-backed persistence for in-flight AI run checkpoints
//! (Generator, Commit Review).
//!
//! A checkpoint captures enough of a run's inputs + agentic transcript to
//! resume it after a failure, a stop, or a crash. Unlike Commit Review's
//! history (`commit_review.rs`) or suite-chat threads (`chat_threads.rs`),
//! this is EPHEMERAL working state, not a record the user browses: a
//! checkpoint is deleted the moment its run finishes successfully, and each
//! surface is trimmed to its `TRIM_PER_SURFACE` newest rows on every save so
//! a habit of starting-and-abandoning runs can't grow the table without
//! bound. It gets its own DB file — rather than columns on `commit_reviews`
//! or a table in the history/chat stores — because that write-heavy,
//! short-lived, mostly-deleted lifecycle doesn't match either of those.
//!
//! `payload` is an opaque JSON blob owned by the TS side (the same
//! convention as `chat_threads.rs`'s `messages` column) — the Rust store
//! never parses it, so the checkpoint shape can evolve per-surface without a
//! migration here.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, State};

/// Rows kept per surface; enforced on every save.
const TRIM_PER_SURFACE: i64 = 10;

#[derive(Default)]
pub struct AiCheckpointsState {
    inner: Arc<Mutex<Option<Connection>>>,
}

impl AiCheckpointsState {
    fn with_conn<F, R>(&self, app: &AppHandle, f: F) -> Result<R, String>
    where
        F: FnOnce(&mut Connection) -> Result<R, String>,
    {
        let mut guard = self
            .inner
            .lock()
            .map_err(|e| format!("ai_checkpoints lock: {e}"))?;
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
    Ok(dir.join("ai_checkpoints.sqlite"))
}

fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS ai_checkpoints (
            run_id     TEXT PRIMARY KEY,
            surface    TEXT NOT NULL,
            cwd        TEXT,
            payload    TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ai_checkpoints_surface_updated
            ON ai_checkpoints (surface, updated_at DESC);
        "#,
    )
    .map_err(|e| format!("ai_checkpoints init: {e}"))
}

/// Full row — used both as the save input and the `get` output.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AiCheckpointRow {
    pub run_id: String,
    pub surface: String,
    pub cwd: Option<String>,
    /// Opaque JSON-encoded checkpoint payload, owned by the TS side. The Rust
    /// store doesn't introspect — it just stores the blob so schema drift on
    /// the TS payload shape is forward-compatible.
    pub payload: String,
    pub created_at: String,
    pub updated_at: String,
}

/// Summary projection for a resume list — no payload blob, mirroring
/// `commit_review_list`'s no-blob rationale (a picker shouldn't load every
/// transcript just to render N rows).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AiCheckpointListEntry {
    pub run_id: String,
    pub cwd: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunIdKey {
    pub run_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListInput {
    pub surface: String,
    pub cwd: Option<String>,
}

#[tauri::command]
pub async fn ai_checkpoint_save(
    app: AppHandle,
    state: State<'_, AiCheckpointsState>,
    input: AiCheckpointRow,
) -> Result<(), String> {
    state.with_conn(&app, |conn| {
        conn.execute(
            "INSERT OR REPLACE INTO ai_checkpoints (run_id, surface, cwd, payload, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                input.run_id,
                input.surface,
                input.cwd,
                input.payload,
                input.created_at,
                input.updated_at,
            ],
        )
        .map_err(|e| e.to_string())?;
        // Per-surface trim: an abandoned Generator run and an abandoned
        // Commit Review run don't compete for the same 10 slots.
        conn.execute(
            "DELETE FROM ai_checkpoints WHERE surface = ?1 AND run_id NOT IN (
                SELECT run_id FROM ai_checkpoints WHERE surface = ?1 ORDER BY updated_at DESC LIMIT ?2
             )",
            params![input.surface, TRIM_PER_SURFACE],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
}

#[tauri::command]
pub async fn ai_checkpoint_get(
    app: AppHandle,
    state: State<'_, AiCheckpointsState>,
    input: RunIdKey,
) -> Result<Option<AiCheckpointRow>, String> {
    state.with_conn(&app, |conn| {
        let mut stmt = conn
            .prepare(
                "SELECT run_id, surface, cwd, payload, created_at, updated_at
                 FROM ai_checkpoints WHERE run_id = ?1",
            )
            .map_err(|e| e.to_string())?;
        stmt.query_row(params![input.run_id], |r| {
            Ok(AiCheckpointRow {
                run_id: r.get(0)?,
                surface: r.get(1)?,
                cwd: r.get(2)?,
                payload: r.get(3)?,
                created_at: r.get(4)?,
                updated_at: r.get(5)?,
            })
        })
        .optional()
        .map_err(|e| e.to_string())
    })
}

/// Deleting a row that's already gone (or never existed) is not an error —
/// callers delete-on-success without checking existence first.
#[tauri::command]
pub async fn ai_checkpoint_delete(
    app: AppHandle,
    state: State<'_, AiCheckpointsState>,
    input: RunIdKey,
) -> Result<(), String> {
    state.with_conn(&app, |conn| {
        conn.execute(
            "DELETE FROM ai_checkpoints WHERE run_id = ?1",
            params![input.run_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
}

#[tauri::command]
pub async fn ai_checkpoint_list(
    app: AppHandle,
    state: State<'_, AiCheckpointsState>,
    input: ListInput,
) -> Result<Vec<AiCheckpointListEntry>, String> {
    state.with_conn(&app, |conn| {
        let mut stmt = conn
            .prepare(
                "SELECT run_id, cwd, created_at, updated_at FROM ai_checkpoints
                 WHERE surface = ?1 AND (?2 IS NULL OR cwd = ?2)
                 ORDER BY updated_at DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![input.surface, input.cwd], |r| {
                Ok(AiCheckpointListEntry {
                    run_id: r.get(0)?,
                    cwd: r.get(1)?,
                    created_at: r.get(2)?,
                    updated_at: r.get(3)?,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        conn
    }

    fn insert_row(
        conn: &Connection,
        run_id: &str,
        surface: &str,
        cwd: Option<&str>,
        payload: &str,
        created_at: &str,
        updated_at: &str,
    ) {
        conn.execute(
            "INSERT OR REPLACE INTO ai_checkpoints (run_id, surface, cwd, payload, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![run_id, surface, cwd, payload, created_at, updated_at],
        )
        .unwrap();
    }

    /// Mirrors the trim step inside `ai_checkpoint_save` — kept as a
    /// standalone helper since the command itself needs an `AppHandle`.
    fn trim(conn: &Connection, surface: &str) {
        conn.execute(
            "DELETE FROM ai_checkpoints WHERE surface = ?1 AND run_id NOT IN (
                SELECT run_id FROM ai_checkpoints WHERE surface = ?1 ORDER BY updated_at DESC LIMIT ?2
             )",
            params![surface, TRIM_PER_SURFACE],
        )
        .unwrap();
    }

    #[test]
    fn init_schema_is_idempotent() {
        let conn = mem();
        init_schema(&conn).unwrap();
        init_schema(&conn).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM ai_checkpoints", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn save_get_round_trip() {
        let conn = mem();
        insert_row(
            &conn,
            "r1",
            "generator",
            Some("/x"),
            "{\"v\":1}",
            "t0",
            "t0",
        );
        let row: (String, String, Option<String>, String, String, String) = conn
            .query_row(
                "SELECT run_id, surface, cwd, payload, created_at, updated_at
                 FROM ai_checkpoints WHERE run_id = 'r1'",
                [],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(row.0, "r1");
        assert_eq!(row.1, "generator");
        assert_eq!(row.2, Some("/x".to_string()));
        assert_eq!(row.3, "{\"v\":1}");
        assert_eq!(row.4, "t0");
        assert_eq!(row.5, "t0");
    }

    #[test]
    fn upsert_on_same_run_id_updates_payload_and_updated_at() {
        let conn = mem();
        insert_row(&conn, "r1", "generator", None, "{\"v\":1}", "t0", "t0");
        insert_row(&conn, "r1", "generator", None, "{\"v\":2}", "t0", "t1");
        let (payload, updated_at): (String, String) = conn
            .query_row(
                "SELECT payload, updated_at FROM ai_checkpoints WHERE run_id = 'r1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(payload, "{\"v\":2}");
        assert_eq!(updated_at, "t1");
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM ai_checkpoints", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1, "upsert must not leave a duplicate row");
    }

    #[test]
    fn trim_keeps_ten_newest_per_surface_and_spares_other_surfaces() {
        let conn = mem();
        for i in 0..12 {
            insert_row(
                &conn,
                &format!("g{i}"),
                "generator",
                None,
                "{}",
                "t0",
                &format!("t{:02}", i),
            );
        }
        insert_row(&conn, "cr1", "commit-review", None, "{}", "t0", "t00");
        trim(&conn, "generator");

        let gen_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM ai_checkpoints WHERE surface = 'generator'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(gen_count, 10);
        let oldest_kept: String = conn
            .query_row(
                "SELECT MIN(updated_at) FROM ai_checkpoints WHERE surface = 'generator'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            oldest_kept, "t02",
            "the two oldest rows (t00, t01) should be trimmed"
        );

        let cr_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM ai_checkpoints WHERE surface = 'commit-review'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            cr_count, 1,
            "trimming one surface must not touch another surface's rows"
        );
    }

    #[test]
    fn delete_existing_and_missing_row() {
        let conn = mem();
        insert_row(&conn, "r1", "generator", None, "{}", "t0", "t0");
        let n = conn
            .execute(
                "DELETE FROM ai_checkpoints WHERE run_id = ?1",
                params!["r1"],
            )
            .unwrap();
        assert_eq!(n, 1);
        // Deleting again (already gone) — and deleting a run_id that never
        // existed — must both succeed with zero rows affected, not error.
        let n2 = conn
            .execute(
                "DELETE FROM ai_checkpoints WHERE run_id = ?1",
                params!["r1"],
            )
            .unwrap();
        assert_eq!(n2, 0);
        let n3 = conn
            .execute(
                "DELETE FROM ai_checkpoints WHERE run_id = ?1",
                params!["never-existed"],
            )
            .unwrap();
        assert_eq!(n3, 0);
    }

    #[test]
    fn list_filters_by_surface_and_cwd_newest_first_excludes_payload() {
        let conn = mem();
        insert_row(
            &conn,
            "g1",
            "generator",
            Some("/a"),
            "{\"secret\":1}",
            "t0",
            "t01",
        );
        insert_row(
            &conn,
            "g2",
            "generator",
            Some("/b"),
            "{\"secret\":2}",
            "t0",
            "t02",
        );
        insert_row(
            &conn,
            "g3",
            "generator",
            Some("/a"),
            "{\"secret\":3}",
            "t0",
            "t03",
        );
        insert_row(
            &conn,
            "cr1",
            "commit-review",
            Some("/a"),
            "{\"secret\":4}",
            "t0",
            "t04",
        );

        let mut stmt = conn
            .prepare(
                "SELECT run_id, cwd, created_at, updated_at FROM ai_checkpoints
                 WHERE surface = ?1 AND (?2 IS NULL OR cwd = ?2)
                 ORDER BY updated_at DESC",
            )
            .unwrap();
        assert_eq!(
            stmt.column_count(),
            4,
            "list projection must not select payload"
        );

        let rows: Vec<(String, Option<String>, String, String)> = stmt
            .query_map(params!["generator", Some("/a")], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(
            rows.len(),
            2,
            "cwd filter should exclude g2 (/b) and the other surface"
        );
        assert_eq!(rows[0].0, "g3", "newest (t03) first");
        assert_eq!(rows[1].0, "g1");

        // No cwd filter (None) returns every row for the surface.
        let all_generator: Vec<String> = stmt
            .query_map(params!["generator", Option::<String>::None], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(all_generator.len(), 3);
    }
}

//! Local SQLite-backed persistence for Commit Review runs.
//!
//! A "run" is one analysis of a single git commit. Unlike suite-chat threads
//! (keyed by plan/suite) this is keyed by an opaque `run_id` minted by the TS
//! store at the moment a review starts. The row is written immediately with
//! `status = "running"` and updated in place as the two-stage analysis
//! progresses, so an interrupted run (closed tab, refresh, crash) leaves a
//! durable record the History tab can show — and `commit_review_sweep_stale`
//! reconciles any row still marked `running` after a reload into `interrupted`.
//!
//! `findings`, `applied_patches`, and `context` are opaque JSON/text owned by
//! the TS side — the Rust store never introspects them, so the finding schema
//! can evolve without a migration here. `finding_count` is stored separately
//! so the History list can render a count without shipping every blob.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, State};

/// Keep at most this many runs; older rows are trimmed on each save.
const MAX_RUNS: i64 = 200;

#[derive(Default)]
pub struct CommitReviewState {
    inner: Arc<Mutex<Option<Connection>>>,
}

impl CommitReviewState {
    fn with_conn<F, R>(&self, app: &AppHandle, f: F) -> Result<R, String>
    where
        F: FnOnce(&mut Connection) -> Result<R, String>,
    {
        let mut guard = self
            .inner
            .lock()
            .map_err(|e| format!("commit_review lock: {e}"))?;
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
    Ok(dir.join("commit_reviews.sqlite"))
}

fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS commit_reviews (
            run_id          TEXT PRIMARY KEY,
            cwd             TEXT NOT NULL,
            commit_sha      TEXT NOT NULL,
            commit_short    TEXT NOT NULL,
            commit_subject  TEXT,
            commits         TEXT,
            status          TEXT NOT NULL,
            model_id        TEXT,
            context         TEXT,
            findings        TEXT NOT NULL,
            applied_patches TEXT NOT NULL,
            error           TEXT,
            finding_count   INTEGER NOT NULL DEFAULT 0,
            duration_ms     INTEGER,
            created_at      TEXT NOT NULL,
            updated_at      TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_commit_reviews_updated
            ON commit_reviews(updated_at DESC);
        "#,
    )
    .map_err(|e| format!("commit_reviews init: {e}"))?;
    // Migration for DBs created before multi-commit support: add the `commits`
    // column (opaque JSON array of the reviewed commits, owned by the TS side,
    // like `findings`). The `commit_sha/short/subject` columns keep the primary
    // (first) commit for the History list + back-compat. A duplicate-column
    // error on an already-migrated (or freshly-created) DB is expected — ignore
    // only that, and surface anything else (locked/corrupt DB, disk error) so a
    // legacy DB that genuinely needs the column fails at init rather than later
    // in get/list queries that SELECT `commits`.
    if let Err(e) = conn.execute("ALTER TABLE commit_reviews ADD COLUMN commits TEXT", []) {
        if !e.to_string().to_lowercase().contains("duplicate column") {
            return Err(format!("commit_reviews migrate commits: {e}"));
        }
    }
    Ok(())
}

/// Full run record — used both as the save input and the `get` output.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CommitReviewRow {
    pub run_id: String,
    pub cwd: String,
    pub commit_sha: String,
    pub commit_short: String,
    pub commit_subject: Option<String>,
    /// Opaque JSON: the full reviewed-commit list `[{sha,short,subject}]`, owned
    /// by the TS side. Null on legacy single-commit rows (read the primary
    /// `commit_sha/short/subject` then).
    pub commits: Option<String>,
    /// running | done | error | cancelled | interrupted
    pub status: String,
    pub model_id: Option<String>,
    /// User-supplied "Add context" text (the ticket / requirements).
    pub context: Option<String>,
    /// Opaque JSON: the merged Finding[] from the TS side.
    pub findings: String,
    /// Opaque JSON: { [findingId]: AppliedPatchRecord }.
    pub applied_patches: String,
    pub error: Option<String>,
    pub finding_count: i64,
    pub duration_ms: Option<i64>,
    pub created_at: String,
    pub updated_at: String,
}

/// Lightweight projection for the History list — no findings/context blobs.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CommitReviewSummary {
    pub run_id: String,
    pub cwd: String,
    pub commit_sha: String,
    pub commit_short: String,
    pub commit_subject: Option<String>,
    /// Opaque JSON commit list (see `CommitReviewRow.commits`) so the History
    /// list can show a "N commits" badge without loading the full row.
    pub commits: Option<String>,
    pub status: String,
    pub model_id: Option<String>,
    pub finding_count: i64,
    pub duration_ms: Option<i64>,
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
pub struct SweepInput {
    /// ISO timestamp the renderer stamps onto swept rows (Rust has no clock dep).
    pub now: String,
}

#[tauri::command]
pub async fn commit_review_save(
    app: AppHandle,
    state: State<'_, CommitReviewState>,
    input: CommitReviewRow,
) -> Result<(), String> {
    state.with_conn(&app, |conn| {
        conn.execute(
            "INSERT OR REPLACE INTO commit_reviews (
                run_id, cwd, commit_sha, commit_short, commit_subject, commits, status,
                model_id, context, findings, applied_patches, error,
                finding_count, duration_ms, created_at, updated_at
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)",
            params![
                input.run_id,
                input.cwd,
                input.commit_sha,
                input.commit_short,
                input.commit_subject,
                input.commits,
                input.status,
                input.model_id,
                input.context,
                input.findings,
                input.applied_patches,
                input.error,
                input.finding_count,
                input.duration_ms,
                input.created_at,
                input.updated_at,
            ],
        )
        .map_err(|e| e.to_string())?;
        // Trim to the newest MAX_RUNS so the table can't grow without bound.
        conn.execute(
            "DELETE FROM commit_reviews WHERE run_id NOT IN (
                SELECT run_id FROM commit_reviews ORDER BY updated_at DESC LIMIT ?1
             )",
            params![MAX_RUNS],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
}

#[tauri::command]
pub async fn commit_review_get(
    app: AppHandle,
    state: State<'_, CommitReviewState>,
    input: RunIdKey,
) -> Result<Option<CommitReviewRow>, String> {
    state.with_conn(&app, |conn| {
        let mut stmt = conn
            .prepare(
                "SELECT run_id, cwd, commit_sha, commit_short, commit_subject, status,
                        model_id, context, findings, applied_patches, error,
                        finding_count, duration_ms, created_at, updated_at, commits
                 FROM commit_reviews WHERE run_id = ?1",
            )
            .map_err(|e| e.to_string())?;
        let row = stmt
            .query_row(params![input.run_id], |r| {
                Ok(CommitReviewRow {
                    run_id: r.get(0)?,
                    cwd: r.get(1)?,
                    commit_sha: r.get(2)?,
                    commit_short: r.get(3)?,
                    commit_subject: r.get(4)?,
                    status: r.get(5)?,
                    model_id: r.get(6)?,
                    context: r.get(7)?,
                    findings: r.get(8)?,
                    applied_patches: r.get(9)?,
                    error: r.get(10)?,
                    finding_count: r.get(11)?,
                    duration_ms: r.get(12)?,
                    created_at: r.get(13)?,
                    updated_at: r.get(14)?,
                    commits: r.get(15)?,
                })
            })
            .optional()
            .map_err(|e| e.to_string())?;
        Ok(row)
    })
}

#[tauri::command]
pub async fn commit_review_list(
    app: AppHandle,
    state: State<'_, CommitReviewState>,
) -> Result<Vec<CommitReviewSummary>, String> {
    state.with_conn(&app, |conn| {
        let mut stmt = conn
            .prepare(
                "SELECT run_id, cwd, commit_sha, commit_short, commit_subject, status,
                        model_id, finding_count, duration_ms, created_at, updated_at, commits
                 FROM commit_reviews ORDER BY updated_at DESC LIMIT ?1",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![MAX_RUNS], |r| {
                Ok(CommitReviewSummary {
                    run_id: r.get(0)?,
                    cwd: r.get(1)?,
                    commit_sha: r.get(2)?,
                    commit_short: r.get(3)?,
                    commit_subject: r.get(4)?,
                    status: r.get(5)?,
                    model_id: r.get(6)?,
                    finding_count: r.get(7)?,
                    duration_ms: r.get(8)?,
                    created_at: r.get(9)?,
                    updated_at: r.get(10)?,
                    commits: r.get(11)?,
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

#[tauri::command]
pub async fn commit_review_delete(
    app: AppHandle,
    state: State<'_, CommitReviewState>,
    input: RunIdKey,
) -> Result<(), String> {
    state.with_conn(&app, |conn| {
        conn.execute(
            "DELETE FROM commit_reviews WHERE run_id = ?1",
            params![input.run_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
}

/// Reconcile rows orphaned by a crash/refresh: any run still marked `running`
/// could not have survived a webview reload, so flip it to `interrupted`.
/// Called once on app mount. Returns the number of rows reconciled.
#[tauri::command]
pub async fn commit_review_sweep_stale(
    app: AppHandle,
    state: State<'_, CommitReviewState>,
    input: SweepInput,
) -> Result<usize, String> {
    state.with_conn(&app, |conn| {
        let n = conn
            .execute(
                "UPDATE commit_reviews SET status = 'interrupted', updated_at = ?1
                 WHERE status = 'running'",
                params![input.now],
            )
            .map_err(|e| e.to_string())?;
        Ok(n)
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

    #[test]
    fn schema_and_sweep() {
        let conn = mem();
        conn.execute(
            "INSERT INTO commit_reviews (run_id, cwd, commit_sha, commit_short, status,
                findings, applied_patches, finding_count, created_at, updated_at)
             VALUES ('r1','/x','abc','abc','running','[]','{}',0,'t0','t0')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO commit_reviews (run_id, cwd, commit_sha, commit_short, status,
                findings, applied_patches, finding_count, created_at, updated_at)
             VALUES ('r2','/x','def','def','done','[]','{}',2,'t0','t0')",
            [],
        )
        .unwrap();
        let n = conn
            .execute(
                "UPDATE commit_reviews SET status='interrupted', updated_at='t1' WHERE status='running'",
                [],
            )
            .unwrap();
        assert_eq!(n, 1);
        let status: String = conn
            .query_row("SELECT status FROM commit_reviews WHERE run_id='r1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(status, "interrupted");
        let untouched: String = conn
            .query_row("SELECT status FROM commit_reviews WHERE run_id='r2'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(untouched, "done");
    }
}

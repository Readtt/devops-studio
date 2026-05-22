//! Local SQLite-backed staleness index.
//!
//! Schema (see plan §Phase 8a):
//!   case_source_links (case_id, repo_id, branch, file_path, symbol, baseline_sha)
//!   repo_baselines    (repo_id, branch, last_seen_sha, last_scan_at)
//!   case_review_state (case_id, last_reviewed_at, flagged_at, flag_reason)
//!
//! The index is built incrementally:
//!   - The publish flow calls `index_case_links` after a successful publish
//!     to populate case_source_links and set the initial repo baseline.
//!   - `scan` walks each known (repo, branch), fetches commits since the
//!     baseline via ADO Git, and marks any case whose linked file changed.

use rusqlite::{params, Connection};
use serde::Deserialize;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, State};

use crate::modules::ado::client::AdoState;
use crate::modules::ado::errors::{AdoError, AdoResult};
use crate::modules::ado::repos;
use crate::modules::ado::tags;
use crate::modules::ado::types::StaleCaseInfo;

const STALE_TAG: &str = "devops-studio:needs-review";

#[derive(Default)]
pub struct StalenessState {
    inner: Arc<Mutex<Option<Connection>>>,
}

impl StalenessState {
    fn with_conn<F, R>(&self, app: &AppHandle, f: F) -> AdoResult<R>
    where
        F: FnOnce(&mut Connection) -> AdoResult<R>,
    {
        let mut guard = self
            .inner
            .lock()
            .map_err(|e| AdoError::local(format!("staleness lock: {e}")))?;
        if guard.is_none() {
            let path = sqlite_path(app)?;
            let conn = Connection::open(&path).map_err(AdoError::local)?;
            init_schema(&conn)?;
            *guard = Some(conn);
        }
        let conn = guard.as_mut().expect("connection initialized above");
        f(conn)
    }
}

fn sqlite_path(app: &AppHandle) -> AdoResult<PathBuf> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| AdoError::local(format!("local data dir: {e}")))?;
    std::fs::create_dir_all(&dir).map_err(AdoError::local)?;
    Ok(dir.join("staleness.sqlite"))
}

fn init_schema(conn: &Connection) -> AdoResult<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS repo_baselines (
            repo_id        TEXT NOT NULL,
            branch         TEXT NOT NULL,
            last_seen_sha  TEXT NOT NULL,
            last_scan_at   TEXT NOT NULL,
            PRIMARY KEY (repo_id, branch)
        );
        CREATE TABLE IF NOT EXISTS case_source_links (
            case_id       INTEGER NOT NULL,
            repo_id       TEXT NOT NULL,
            branch        TEXT NOT NULL,
            file_path     TEXT NOT NULL,
            symbol        TEXT,
            baseline_sha  TEXT NOT NULL,
            PRIMARY KEY (case_id, repo_id, branch, file_path)
        );
        CREATE INDEX IF NOT EXISTS idx_links_by_repo
            ON case_source_links(repo_id, branch);
        CREATE TABLE IF NOT EXISTS case_review_state (
            case_id           INTEGER PRIMARY KEY,
            last_reviewed_at  TEXT,
            flagged_at        TEXT,
            flag_reason       TEXT
        );
        "#,
    )
    .map_err(AdoError::local)?;
    Ok(())
}

fn now_iso() -> String {
    chrono_like_now()
}

/// Minimal RFC3339 timestamp generator — avoids pulling in a date crate just
/// for one ISO string. Always UTC, second precision.
fn chrono_like_now() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let (year, month, day, hour, minute, second) = epoch_to_ymdhms(now);
    format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z"
    )
}

/// Convert UNIX seconds to (year, month, day, hour, minute, second) in UTC.
/// Public-domain algorithm (Howard Hinnant) — handles all dates we care about.
fn epoch_to_ymdhms(secs: i64) -> (i32, u32, u32, u32, u32, u32) {
    let days = secs.div_euclid(86_400);
    let s = secs.rem_euclid(86_400) as u32;
    let hour = s / 3600;
    let minute = (s / 60) % 60;
    let second = s % 60;
    // Days since 1970-01-01 → year/month/day
    let z = days + 719_468;
    let era = if z >= 0 { z / 146_097 } else { (z - 146_096) / 146_097 };
    let doe = (z - era * 146_097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i32 + (era * 400) as i32;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    (year, m, d, hour, minute, second)
}

// --- Tauri commands ---

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexCaseLinksInput {
    pub case_id: i64,
    pub links: Vec<LinkInput>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkInput {
    pub repo_id: String,
    pub branch: String,
    pub file_path: String,
    pub symbol: Option<String>,
    /// Sha at generation time. If empty, we'll fetch the current branch HEAD
    /// and use that as the baseline.
    pub baseline_sha: Option<String>,
}

#[tauri::command]
pub async fn ado_index_case_links(
    app: AppHandle,
    ado: State<'_, AdoState>,
    stale: State<'_, StalenessState>,
    input: IndexCaseLinksInput,
) -> Result<(), AdoError> {
    if input.links.is_empty() {
        return Ok(());
    }

    // Determine baseline SHA per (repo, branch) — fetch HEAD once per pair if needed.
    let mut baselines: std::collections::HashMap<(String, String), String> =
        std::collections::HashMap::new();
    for l in &input.links {
        let provided = l.baseline_sha.clone().unwrap_or_default();
        let key = (l.repo_id.clone(), l.branch.clone());
        if !provided.is_empty() {
            baselines.entry(key).or_insert(provided);
            continue;
        }
        if baselines.contains_key(&key) {
            continue;
        }
        // No baseline given — try ADO for the latest commit on this branch.
        // If ADO doesn't know about the repo (common case: source is on
        // GitHub/GitLab/local, not in ADO Repos), don't fail the whole index
        // operation. We record an empty baseline so the case is still
        // tracked for review state and future scans; drift detection just
        // won't auto-flag this case until a real SHA shows up.
        let head = match repos::list_commits_since(&ado, &l.repo_id, &l.branch, None).await {
            Ok(commits) => commits
                .first()
                .map(|c| c.commit_id.clone())
                .unwrap_or_default(),
            Err(_) => String::new(),
        };
        baselines.insert(key, head);
    }

    stale.with_conn(&app, |conn| {
        let tx = conn.transaction().map_err(AdoError::local)?;
        let now = now_iso();
        for l in &input.links {
            let key = (l.repo_id.clone(), l.branch.clone());
            let baseline = baselines.get(&key).cloned().unwrap_or_default();
            tx.execute(
                "INSERT OR REPLACE INTO case_source_links
                    (case_id, repo_id, branch, file_path, symbol, baseline_sha)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    input.case_id,
                    l.repo_id,
                    l.branch,
                    l.file_path,
                    l.symbol,
                    baseline,
                ],
            )
            .map_err(AdoError::local)?;
            tx.execute(
                "INSERT OR REPLACE INTO repo_baselines
                    (repo_id, branch, last_seen_sha, last_scan_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![l.repo_id, l.branch, baseline, now],
            )
            .map_err(AdoError::local)?;
        }
        tx.execute(
            "INSERT OR REPLACE INTO case_review_state (case_id, last_reviewed_at, flagged_at, flag_reason)
             VALUES (?1, ?2, NULL, NULL)",
            params![input.case_id, now],
        )
        .map_err(AdoError::local)?;
        tx.commit().map_err(AdoError::local)?;
        Ok(())
    })
}

#[tauri::command]
pub async fn ado_scan_staleness(
    app: AppHandle,
    ado: State<'_, AdoState>,
    stale: State<'_, StalenessState>,
) -> Result<Vec<StaleCaseInfo>, AdoError> {
    // Snapshot the set of (repo, branch) pairs we care about, plus the
    // baselines and per-pair file→case map. Doing this in a short critical
    // section keeps the SQLite lock from blocking the ADO HTTP calls below.
    type RepoBranch = (String, String);
    type StaleSnapshot = (
        Vec<(RepoBranch, String)>,
        std::collections::HashMap<RepoBranch, Vec<(String, i64)>>,
    );
    let snapshot: StaleSnapshot = stale.with_conn(&app, |conn| {
        let mut pairs: Vec<(RepoBranch, String)> = Vec::new();
        {
            let mut stmt = conn
                .prepare(
                    "SELECT DISTINCT l.repo_id, l.branch, IFNULL(b.last_seen_sha,'')
                     FROM case_source_links l
                     LEFT JOIN repo_baselines b
                       ON b.repo_id = l.repo_id AND b.branch = l.branch",
                )
                .map_err(AdoError::local)?;
            let rows = stmt
                .query_map([], |r| Ok((
                    (r.get::<_, String>(0)?, r.get::<_, String>(1)?),
                    r.get::<_, String>(2)?,
                )))
                .map_err(AdoError::local)?;
            for r in rows {
                pairs.push(r.map_err(AdoError::local)?);
            }
        }

        let mut by_pair: std::collections::HashMap<RepoBranch, Vec<(String, i64)>> =
            std::collections::HashMap::new();
        {
            let mut stmt = conn
                .prepare("SELECT repo_id, branch, file_path, case_id FROM case_source_links")
                .map_err(AdoError::local)?;
            let rows = stmt
                .query_map([], |r| Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                )))
                .map_err(AdoError::local)?;
            for r in rows {
                let (repo, branch, path, case_id) = r.map_err(AdoError::local)?;
                by_pair
                    .entry((repo, branch))
                    .or_default()
                    .push((path, case_id));
            }
        }

        Ok((pairs, by_pair))
    })?;

    let (pairs, by_pair) = snapshot;
    if pairs.is_empty() {
        return Ok(Vec::new());
    }

    // Per case_id, aggregate changed files + commit count.
    let mut flagged: std::collections::HashMap<i64, (Vec<String>, u32)> =
        std::collections::HashMap::new();
    // Track new baselines to bump after a successful scan.
    let mut new_baselines: Vec<(String, String, String)> = Vec::new();

    for ((repo, branch), baseline) in pairs {
        let since = if baseline.is_empty() { None } else { Some(baseline.as_str()) };
        let commits = repos::list_commits_since(&ado, &repo, &branch, since).await?;
        if commits.is_empty() {
            continue;
        }
        let mut changed: std::collections::HashSet<String> =
            std::collections::HashSet::new();
        for c in &commits {
            for f in &c.changed_files {
                changed.insert(normalize_path(f));
            }
        }
        if let Some(links) = by_pair.get(&(repo.clone(), branch.clone())) {
            for (file_path, case_id) in links {
                if changed.contains(&normalize_path(file_path)) {
                    let entry = flagged.entry(*case_id).or_insert_with(|| (Vec::new(), 0));
                    if !entry.0.contains(file_path) {
                        entry.0.push(file_path.clone());
                    }
                    entry.1 = commits.len() as u32;
                }
            }
        }
        // The first element of the commits response is the newest.
        if let Some(latest) = commits.first() {
            new_baselines.push((repo, branch, latest.commit_id.clone()));
        }
    }

    // Persist flag state + bump baselines transactionally.
    stale.with_conn(&app, |conn| {
        let tx = conn.transaction().map_err(AdoError::local)?;
        let now = now_iso();
        for (case_id, (_files, _count)) in &flagged {
            tx.execute(
                "INSERT INTO case_review_state (case_id, last_reviewed_at, flagged_at, flag_reason)
                 VALUES (?1, NULL, ?2, 'source-changed')
                 ON CONFLICT(case_id) DO UPDATE SET
                    flagged_at = excluded.flagged_at,
                    flag_reason = excluded.flag_reason",
                params![case_id, now],
            )
            .map_err(AdoError::local)?;
        }
        for (repo, branch, sha) in &new_baselines {
            tx.execute(
                "INSERT OR REPLACE INTO repo_baselines (repo_id, branch, last_seen_sha, last_scan_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![repo, branch, sha, now],
            )
            .map_err(AdoError::local)?;
        }
        tx.commit().map_err(AdoError::local)?;
        Ok(())
    })?;

    Ok(flagged
        .into_iter()
        .map(|(case_id, (files, count))| StaleCaseInfo {
            case_id,
            reason: "source-changed".into(),
            changed_files: files,
            commit_count: count,
        })
        .collect())
}

fn normalize_path(s: &str) -> String {
    // ADO's commit-changes API returns paths prefixed with "/" — strip it
    // so we can match the user's recorded paths regardless of leading slash.
    s.trim_start_matches('/').to_string()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaseIdInput {
    pub case_id: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkForReviewInput {
    pub case_id: i64,
    pub reason: String,
}

#[tauri::command]
pub async fn ado_acknowledge_case(
    app: AppHandle,
    ado: State<'_, AdoState>,
    stale: State<'_, StalenessState>,
    input: CaseIdInput,
) -> Result<(), AdoError> {
    // Look up the (repo, branch) pairs this case is linked to, and the
    // current baseline. Then fetch HEAD on each branch and bump the per-link
    // baseline so future scans don't re-flag the same commits.
    type RepoBranch = (String, String);
    let pairs: Vec<RepoBranch> = stale.with_conn(&app, |conn| {
        let mut stmt = conn
            .prepare("SELECT DISTINCT repo_id, branch FROM case_source_links WHERE case_id = ?1")
            .map_err(AdoError::local)?;
        let rows = stmt
            .query_map(params![input.case_id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(AdoError::local)?;
        let mut out: Vec<RepoBranch> = Vec::new();
        for r in rows {
            out.push(r.map_err(AdoError::local)?);
        }
        Ok(out)
    })?;

    let mut heads: std::collections::HashMap<RepoBranch, String> =
        std::collections::HashMap::new();
    for p in &pairs {
        let commits = repos::list_commits_since(&ado, &p.0, &p.1, None).await?;
        let head = commits
            .first()
            .map(|c| c.commit_id.clone())
            .unwrap_or_default();
        heads.insert(p.clone(), head);
    }

    stale.with_conn(&app, |conn| {
        let tx = conn.transaction().map_err(AdoError::local)?;
        let now = now_iso();
        for ((repo, branch), head) in heads.iter() {
            tx.execute(
                "UPDATE case_source_links SET baseline_sha = ?1
                 WHERE case_id = ?2 AND repo_id = ?3 AND branch = ?4",
                params![head, input.case_id, repo, branch],
            )
            .map_err(AdoError::local)?;
            tx.execute(
                "INSERT OR REPLACE INTO repo_baselines (repo_id, branch, last_seen_sha, last_scan_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![repo, branch, head, now],
            )
            .map_err(AdoError::local)?;
        }
        tx.execute(
            "INSERT INTO case_review_state (case_id, last_reviewed_at, flagged_at, flag_reason)
             VALUES (?1, ?2, NULL, NULL)
             ON CONFLICT(case_id) DO UPDATE SET
                last_reviewed_at = excluded.last_reviewed_at,
                flagged_at = NULL,
                flag_reason = NULL",
            params![input.case_id, now],
        )
        .map_err(AdoError::local)?;
        tx.commit().map_err(AdoError::local)?;
        Ok(())
    })?;

    // Best-effort: remove the needs-review tag if it was applied. We don't
    // fail the whole acknowledge if this errors — the local state is what
    // matters; the tag is just a teammate-visible breadcrumb.
    let _ = tags::remove_tag(&ado, input.case_id, STALE_TAG).await;
    Ok(())
}

#[tauri::command]
pub async fn ado_mark_for_review(
    app: AppHandle,
    ado: State<'_, AdoState>,
    stale: State<'_, StalenessState>,
    input: MarkForReviewInput,
) -> Result<(), AdoError> {
    stale.with_conn(&app, |conn| {
        let now = now_iso();
        conn.execute(
            "INSERT INTO case_review_state (case_id, last_reviewed_at, flagged_at, flag_reason)
             VALUES (?1, NULL, ?2, ?3)
             ON CONFLICT(case_id) DO UPDATE SET
                flagged_at = excluded.flagged_at,
                flag_reason = excluded.flag_reason",
            params![input.case_id, now, input.reason],
        )
        .map_err(AdoError::local)?;
        Ok(())
    })?;
    let _ = tags::add_tag(&ado, input.case_id, STALE_TAG).await;
    Ok(())
}

//! Azure DevOps REST surface for DevOps Studio.
//!
//! Each Tauri command here is a thin wrapper around the typed inner module
//! functions. The state (Connection + PAT) is owned by AdoState; the PAT is
//! loaded from the OS keychain on demand via `secrets::secrets_get` so we
//! never persist it to disk in plaintext.
//!
//! Map of commands → renderer counterparts is in plan §Phase 3c.

pub mod auth;
pub mod bugs;
pub mod client;
pub mod errors;
pub mod projects;
pub mod repos;
pub mod tags;
pub mod test_cases;
pub mod test_plans;
pub mod test_points;
pub mod types;
pub mod work_items;

use serde::Deserialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_store::StoreExt;

use client::{keyring_service, pat_account, normalize_org_url, AdoState};
use errors::AdoError;
use types::{
    BranchRef, Bug, BugRef, CaseSuiteMembership, CommitInfo, Connection, ConnectionStatus,
    CreatedWorkItem, DraftBug, DraftCase, FileContent, ProjectRef, PullRequestRef, RepoRef,
    SuiteRef, TeamMember, TestCase, TestCaseRef, TestConnectionResult, TestPlanRef, TestPointInfo,
    WorkItemRef,
};

const STORE_PATH: &str = "devops-studio-settings.json";
const KEY_ORG: &str = "ado.orgUrl";
const KEY_PROJECT: &str = "ado.project";
const KEY_DEFAULT_BRANCH: &str = "ado.defaultTrackingBranch";

// --- Helpers ---

async fn load_pat(app: &AppHandle) -> Result<Option<String>, String> {
    crate::modules::secrets::secrets_get(
        app.clone(),
        app.state::<crate::modules::secrets::SecretsState>(),
        keyring_service().to_string(),
        pat_account().to_string(),
    )
    .await
}

async fn save_pat(app: &AppHandle, pat: &str) -> Result<(), String> {
    crate::modules::secrets::secrets_set(
        app.clone(),
        app.state::<crate::modules::secrets::SecretsState>(),
        keyring_service().to_string(),
        pat_account().to_string(),
        pat.to_string(),
    )
    .await
}

async fn delete_pat(app: &AppHandle) -> Result<(), String> {
    crate::modules::secrets::secrets_delete(
        app.clone(),
        app.state::<crate::modules::secrets::SecretsState>(),
        keyring_service().to_string(),
        pat_account().to_string(),
    )
    .await
}

fn load_connection_from_store(app: &AppHandle) -> Connection {
    let store = match app.store(STORE_PATH) {
        Ok(s) => s,
        Err(_) => return Connection::default(),
    };
    let raw_org_url = store
        .get(KEY_ORG)
        .and_then(|v| v.as_str().map(String::from))
        .unwrap_or_default();
    // Re-normalize on every load so older saves without a scheme don't
    // require the user to re-save the form to make the connection work.
    let org_url = normalize_org_url(&raw_org_url);
    let project = store
        .get(KEY_PROJECT)
        .and_then(|v| v.as_str().map(String::from))
        .unwrap_or_default();
    let default_tracking_branch = store
        .get(KEY_DEFAULT_BRANCH)
        .and_then(|v| v.as_str().map(String::from))
        .unwrap_or_else(|| "main".to_string());
    Connection {
        org_url,
        project,
        default_tracking_branch,
    }
}

fn save_connection_to_store(app: &AppHandle, conn: &Connection) -> Result<(), String> {
    let store = app.store(STORE_PATH).map_err(|e| e.to_string())?;
    store.set(KEY_ORG, serde_json::Value::String(conn.org_url.clone()));
    store.set(KEY_PROJECT, serde_json::Value::String(conn.project.clone()));
    store.set(
        KEY_DEFAULT_BRANCH,
        serde_json::Value::String(conn.default_tracking_branch.clone()),
    );
    store.save().map_err(|e| e.to_string())
}

/// Hydrate the in-memory AdoState from disk + keychain. Called at startup.
pub async fn hydrate(app: &AppHandle, state: &AdoState) {
    let conn = load_connection_from_store(app);
    let pat = load_pat(app).await.unwrap_or(None);
    state.set_connection(conn, pat);
}

// --- Connection / settings commands ---

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetConnectionInput {
    pub org_url: String,
    pub project: String,
    pub pat: Option<String>,
    pub default_tracking_branch: Option<String>,
}

#[tauri::command]
pub async fn ado_set_connection(
    app: AppHandle,
    state: State<'_, AdoState>,
    input: SetConnectionInput,
) -> Result<(), String> {
    let conn = Connection {
        org_url: normalize_org_url(&input.org_url),
        project: input.project,
        default_tracking_branch: input
            .default_tracking_branch
            .unwrap_or_else(|| "main".to_string()),
    };
    save_connection_to_store(&app, &conn)?;
    if let Some(pat) = input.pat.as_deref() {
        if pat.is_empty() {
            delete_pat(&app).await?;
        } else {
            save_pat(&app, pat).await?;
        }
    }
    state.set_connection(conn, input.pat);
    Ok(())
}

#[tauri::command]
pub async fn ado_get_connection(
    state: State<'_, AdoState>,
) -> Result<ConnectionStatus, String> {
    let (conn, pat) = state.snapshot();
    let c = conn.unwrap_or_default();
    let has_pat = pat.is_some();
    let configured = !c.org_url.is_empty() && !c.project.is_empty() && has_pat;
    Ok(ConnectionStatus {
        configured,
        has_pat,
        identity_name: None,
        org_url: c.org_url,
        project: c.project,
        default_tracking_branch: c.default_tracking_branch,
    })
}

#[tauri::command]
pub async fn ado_test_connection(
    state: State<'_, AdoState>,
) -> Result<TestConnectionResult, String> {
    Ok(auth::test_connection(&state).await)
}

#[tauri::command]
pub async fn ado_clear_pat(
    app: AppHandle,
    state: State<'_, AdoState>,
) -> Result<(), String> {
    delete_pat(&app).await?;
    state.clear_pat();
    Ok(())
}

// --- Test Plans reads ---

#[tauri::command]
pub async fn ado_list_plans(
    state: State<'_, AdoState>,
) -> Result<Vec<TestPlanRef>, AdoError> {
    test_plans::list_plans(&state).await
}

#[tauri::command]
pub async fn ado_list_suites(
    state: State<'_, AdoState>,
    plan_id: i64,
) -> Result<Vec<SuiteRef>, AdoError> {
    test_plans::list_suites(&state, plan_id).await
}

#[tauri::command]
pub async fn ado_list_suite_cases(
    state: State<'_, AdoState>,
    plan_id: i64,
    suite_id: i64,
) -> Result<Vec<TestCaseRef>, AdoError> {
    test_plans::list_suite_cases(&state, plan_id, suite_id).await
}

#[tauri::command]
pub async fn ado_get_case(
    state: State<'_, AdoState>,
    case_id: i64,
) -> Result<TestCase, AdoError> {
    test_plans::get_case(&state, case_id).await
}

// --- Test execution (Execute tab) ---

#[tauri::command]
pub async fn ado_list_test_points(
    state: State<'_, AdoState>,
    plan_id: i64,
    suite_id: i64,
    case_id: i64,
) -> Result<Vec<TestPointInfo>, AdoError> {
    test_points::list_test_points(&state, plan_id, suite_id, case_id).await
}

#[tauri::command]
pub async fn ado_list_suites_for_case(
    state: State<'_, AdoState>,
    case_id: i64,
) -> Result<Vec<CaseSuiteMembership>, AdoError> {
    test_points::list_suites_for_case(&state, case_id).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetOutcomeInput {
    pub plan_id: i64,
    pub suite_id: i64,
    pub point_id: i64,
    /// The work-item id of the case the point belongs to — only used to attach
    /// the optional `comment` to the case's discussion.
    pub case_id: i64,
    /// "Passed" | "Failed" | "Blocked" | "NotApplicable" | "Active".
    pub outcome: String,
    /// Optional failure note; recorded on the case's discussion when present.
    pub comment: Option<String>,
}

#[tauri::command]
pub async fn ado_set_test_point_outcome(
    state: State<'_, AdoState>,
    input: SetOutcomeInput,
) -> Result<TestPointInfo, AdoError> {
    let point = test_points::set_test_point_outcome(
        &state,
        input.plan_id,
        input.suite_id,
        input.point_id,
        &input.outcome,
    )
    .await?;
    // A comment is best-effort: the outcome is already recorded, so a failed
    // discussion write shouldn't surface as a failure of the whole action.
    if let Some(comment) = input.comment.as_deref() {
        let trimmed = comment.trim();
        if !trimmed.is_empty() {
            let note = format!(
                "Execution outcome set to {} via DevOps Studio.\n\n{}",
                input.outcome, trimmed
            );
            if let Err(e) = test_points::add_case_comment(&state, input.case_id, &note).await {
                log::warn!(
                    "ado_set_test_point_outcome: outcome saved but discussion comment failed: {e:?}"
                );
            }
        }
    }
    Ok(point)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSuiteInput {
    pub plan_id: i64,
    /// `None` means "attach under the plan's root suite" — i.e. add a
    /// top-level suite. Otherwise the new suite nests under this one.
    pub parent_suite_id: Option<i64>,
    pub name: String,
}

#[tauri::command]
pub async fn ado_create_suite(
    state: State<'_, AdoState>,
    input: CreateSuiteInput,
) -> Result<SuiteRef, AdoError> {
    test_plans::create_static_suite(&state, input.plan_id, input.parent_suite_id, &input.name)
        .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameSuiteInput {
    pub plan_id: i64,
    pub suite_id: i64,
    pub name: String,
}

#[tauri::command]
pub async fn ado_update_suite_name(
    state: State<'_, AdoState>,
    input: RenameSuiteInput,
) -> Result<SuiteRef, AdoError> {
    test_plans::update_suite_name(&state, input.plan_id, input.suite_id, &input.name).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenamePlanInput {
    pub plan_id: i64,
    pub name: String,
}

#[tauri::command]
pub async fn ado_update_plan_name(
    state: State<'_, AdoState>,
    input: RenamePlanInput,
) -> Result<TestPlanRef, AdoError> {
    test_plans::update_plan_name(&state, input.plan_id, &input.name).await
}

// --- Publishing ---

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateCaseInput {
    pub plan_id: i64,
    pub suite_id: i64,
    pub draft: DraftCase,
}

#[tauri::command]
pub async fn ado_create_case_in_suite(
    state: State<'_, AdoState>,
    input: CreateCaseInput,
) -> Result<CreatedWorkItem, AdoError> {
    let created = test_cases::create_test_case_workitem(&state, &input.draft).await?;
    test_cases::link_case_to_suite(&state, input.plan_id, input.suite_id, created.id).await?;
    Ok(created)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteCaseInput {
    pub case_id: i64,
    /// Default false: the case lands in ADO's Recycle Bin and can be
    /// restored for 30 days. true: permanently destroyed, irreversible.
    /// The chat-driven path always passes false; users who want to
    /// permanently nuke a case can use the ADO web UI's Destroy action.
    #[serde(default)]
    pub destroy: bool,
    /// Suite the case is being deleted from. ADO refuses to delete a Test
    /// Case work item while it's still referenced by a suite (400), so when
    /// these are present the backend unlinks the case from this suite first.
    #[serde(default)]
    pub plan_id: Option<i64>,
    #[serde(default)]
    pub suite_id: Option<i64>,
}

#[tauri::command]
pub async fn ado_delete_test_case(
    state: State<'_, AdoState>,
    input: DeleteCaseInput,
) -> Result<(), AdoError> {
    test_cases::delete_test_case(
        &state,
        input.case_id,
        input.destroy,
        input.plan_id,
        input.suite_id,
    )
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateBugInput {
    pub case_id: i64,
    pub draft: DraftBug,
}

#[tauri::command]
pub async fn ado_create_bug_and_link(
    state: State<'_, AdoState>,
    input: CreateBugInput,
) -> Result<CreatedWorkItem, AdoError> {
    let bug = bugs::create_bug(&state, &input.draft).await?;
    bugs::link_tested_by(&state, input.case_id, &bug.url).await?;
    Ok(bug)
}

/// Standalone bug creation. No required `TestedBy` link to a test case — the
/// draft carries its own `parent_case_id` if the caller wants a parent/child
/// relation, and `code_links` if it wants source anchors in the description.
#[tauri::command]
pub async fn ado_create_bug(
    state: State<'_, AdoState>,
    draft: DraftBug,
) -> Result<CreatedWorkItem, AdoError> {
    bugs::create_bug(&state, &draft).await
}

/// List everyone assignable across the project's teams for the "assign a
/// developer" picker in the generator's review phase.
#[tauri::command]
pub async fn ado_list_team_members(
    state: State<'_, AdoState>,
) -> Result<Vec<TeamMember>, AdoError> {
    projects::list_team_members(&state).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkBugToCaseInput {
    pub bug_id: i64,
    pub case_id: i64,
}

/// Link an existing bug to a test case as its Parent in the work-item tree.
/// Used by the Bug pane's "Set parent case" action.
#[tauri::command]
pub async fn ado_link_bug_to_case(
    state: State<'_, AdoState>,
    input: LinkBugToCaseInput,
) -> Result<(), AdoError> {
    bugs::link_bug_to_case_as_child(&state, input.bug_id, input.case_id).await
}

#[tauri::command]
pub async fn ado_get_bug(state: State<'_, AdoState>, bug_id: i64) -> Result<Bug, AdoError> {
    bugs::get_bug(&state, bug_id).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListBugsInput {
    #[serde(default)]
    pub area_path: Option<String>,
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub top: Option<i64>,
}

/// List bugs for the bug-context picker (WIQL-backed, optionally scoped by area
/// path / free-text title). Returns lightweight `BugRef`s; full bodies come
/// from `ado_get_bug` when a bug is selected.
#[tauri::command]
pub async fn ado_list_bugs(
    state: State<'_, AdoState>,
    input: ListBugsInput,
) -> Result<Vec<BugRef>, AdoError> {
    bugs::list_bugs(
        &state,
        input.area_path.as_deref(),
        input.query.as_deref(),
        input.top.unwrap_or(50),
    )
    .await
}

/// List work items of any type for the inline `#id` mention. Same input shape
/// as `ado_list_bugs`; returns `WorkItemRef`s carrying the work-item type.
#[tauri::command]
pub async fn ado_list_work_items(
    state: State<'_, AdoState>,
    input: ListBugsInput,
) -> Result<Vec<WorkItemRef>, AdoError> {
    bugs::list_work_items(
        &state,
        input.area_path.as_deref(),
        input.query.as_deref(),
        input.top.unwrap_or(50),
    )
    .await
}

/// Resolve a single work item by id (for `#123` exact matches in the mention).
#[tauri::command]
pub async fn ado_get_work_item_ref(
    state: State<'_, AdoState>,
    id: i64,
) -> Result<WorkItemRef, AdoError> {
    bugs::get_work_item_ref(&state, id).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateBugInput {
    pub bug_id: i64,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub repro_steps: Option<String>,
    #[serde(default)]
    pub severity: Option<String>,
    #[serde(default)]
    pub state: Option<String>,
}

/// Patch a bug's title / repro steps / severity / state. Unset fields are left
/// untouched.
#[tauri::command]
pub async fn ado_update_bug(
    state: State<'_, AdoState>,
    input: UpdateBugInput,
) -> Result<(), AdoError> {
    bugs::update_bug(
        &state,
        input.bug_id,
        &bugs::BugUpdate {
            title: input.title,
            repro_steps: input.repro_steps,
            severity: input.severity,
            state: input.state,
        },
    )
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteBugInput {
    pub bug_id: i64,
    #[serde(default)]
    pub destroy: bool,
}

/// Delete a bug. Soft-delete to the Recycle Bin by default (recoverable);
/// `destroy: true` permanently removes it.
#[tauri::command]
pub async fn ado_delete_bug(
    state: State<'_, AdoState>,
    input: DeleteBugInput,
) -> Result<(), AdoError> {
    bugs::delete_bug(&state, input.bug_id, input.destroy).await
}

#[tauri::command]
pub async fn ado_get_work_item_titles(
    state: State<'_, AdoState>,
    ids: Vec<i64>,
) -> Result<Vec<work_items::WorkItemTitle>, AdoError> {
    work_items::get_work_item_titles(&state, &ids).await
}

#[tauri::command]
pub async fn ado_list_projects(
    state: State<'_, AdoState>,
) -> Result<Vec<ProjectRef>, AdoError> {
    projects::list_projects(&state).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDescriptionInput {
    pub case_id: i64,
    pub description: String,
}

#[tauri::command]
pub async fn ado_update_case_description(
    state: State<'_, AdoState>,
    input: UpdateDescriptionInput,
) -> Result<(), AdoError> {
    test_cases::update_description(&state, input.case_id, &input.description).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTitleInput {
    pub work_item_id: i64,
    pub title: String,
}

#[tauri::command]
pub async fn ado_update_work_item_title(
    state: State<'_, AdoState>,
    input: UpdateTitleInput,
) -> Result<(), AdoError> {
    test_cases::update_work_item_title(&state, input.work_item_id, &input.title).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStepsInput {
    pub case_id: i64,
    pub steps: Vec<crate::modules::ado::types::TestStep>,
}

#[tauri::command]
pub async fn ado_update_case_steps(
    state: State<'_, AdoState>,
    input: UpdateStepsInput,
) -> Result<(), AdoError> {
    test_cases::update_case_steps(&state, input.case_id, &input.steps).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagInput {
    pub work_item_id: i64,
    pub tag: String,
}

#[tauri::command]
pub async fn ado_add_tag(
    state: State<'_, AdoState>,
    input: TagInput,
) -> Result<(), AdoError> {
    tags::add_tag(&state, input.work_item_id, &input.tag).await
}

#[tauri::command]
pub async fn ado_remove_tag(
    state: State<'_, AdoState>,
    input: TagInput,
) -> Result<(), AdoError> {
    tags::remove_tag(&state, input.work_item_id, &input.tag).await
}

// --- Repos ---

#[tauri::command]
pub async fn ado_list_repos(
    state: State<'_, AdoState>,
) -> Result<Vec<RepoRef>, AdoError> {
    repos::list_repos(&state).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetFileInput {
    pub repo_id: String,
    pub branch: String,
    pub path: String,
}

#[tauri::command]
pub async fn ado_get_file(
    state: State<'_, AdoState>,
    input: GetFileInput,
) -> Result<FileContent, AdoError> {
    repos::get_file(&state, &input.repo_id, &input.branch, &input.path).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitsSinceInput {
    pub repo_id: String,
    pub branch: String,
    pub since_sha: Option<String>,
}

#[tauri::command]
pub async fn ado_list_commits_since(
    state: State<'_, AdoState>,
    input: CommitsSinceInput,
) -> Result<Vec<CommitInfo>, AdoError> {
    repos::list_commits_since(&state, &input.repo_id, &input.branch, input.since_sha.as_deref())
        .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListBranchesInput {
    pub repo_id: String,
}

/// List a repo's branches (Code Review source picker branch combobox).
#[tauri::command]
pub async fn ado_list_branches(
    state: State<'_, AdoState>,
    input: ListBranchesInput,
) -> Result<Vec<BranchRef>, AdoError> {
    repos::list_branches(&state, &input.repo_id).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentCommitsInput {
    pub repo_id: String,
    pub branch: String,
    #[serde(default)]
    pub top: Option<i64>,
}

/// Recent commits on a branch — lightweight (no per-commit changes), for the
/// source picker's recent-commits list.
#[tauri::command]
pub async fn ado_list_recent_commits(
    state: State<'_, AdoState>,
    input: RecentCommitsInput,
) -> Result<Vec<CommitInfo>, AdoError> {
    repos::list_recent_commits(&state, &input.repo_id, &input.branch, input.top.unwrap_or(25))
        .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffCommitInput {
    pub repo_id: String,
    pub commit_id: String,
}

/// Diff a single commit (vs its parent) into the DiffSummary shape the Code
/// Review pane consumes.
#[tauri::command]
pub async fn ado_diff_commit(
    state: State<'_, AdoState>,
    input: DiffCommitInput,
) -> Result<repos::AdoDiff, AdoError> {
    repos::diff_commit(&state, &input.repo_id, &input.commit_id).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffBranchesInput {
    pub repo_id: String,
    pub base_branch: String,
    pub target_branch: String,
}

/// Diff target branch vs base branch.
#[tauri::command]
pub async fn ado_diff_branches(
    state: State<'_, AdoState>,
    input: DiffBranchesInput,
) -> Result<repos::AdoDiff, AdoError> {
    repos::diff_branches(&state, &input.repo_id, &input.base_branch, &input.target_branch).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListPullRequestsInput {
    pub repo_id: String,
    #[serde(default)]
    pub top: Option<i64>,
}

/// List active pull requests for the repo (Code Review PR picker).
#[tauri::command]
pub async fn ado_list_pull_requests(
    state: State<'_, AdoState>,
    input: ListPullRequestsInput,
) -> Result<Vec<PullRequestRef>, AdoError> {
    repos::list_pull_requests(&state, &input.repo_id, input.top.unwrap_or(30)).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffPullRequestInput {
    pub repo_id: String,
    pub pr_id: i64,
}

/// Diff a pull request (source vs target).
#[tauri::command]
pub async fn ado_diff_pull_request(
    state: State<'_, AdoState>,
    input: DiffPullRequestInput,
) -> Result<repos::AdoDiff, AdoError> {
    repos::diff_pull_request(&state, &input.repo_id, input.pr_id).await
}

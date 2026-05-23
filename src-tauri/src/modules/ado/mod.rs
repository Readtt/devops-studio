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
pub mod types;
pub mod work_items;

use serde::Deserialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_store::StoreExt;

use client::{keyring_service, pat_account, normalize_org_url, AdoState};
use errors::AdoError;
use types::{
    Bug, CommitInfo, Connection, ConnectionStatus, CreatedWorkItem, DraftBug, DraftCase,
    FileContent, ProjectRef, RepoRef, SuiteRef, TestCase, TestCaseRef, TestConnectionResult,
    TestPlanRef,
};

const STORE_PATH: &str = "devops-studio-settings.json";
const KEY_ORG: &str = "ado.orgUrl";
const KEY_PROJECT: &str = "ado.project";
const KEY_DEFAULT_PLAN: &str = "ado.defaultPlanId";
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
    let default_plan_id = store.get(KEY_DEFAULT_PLAN).and_then(|v| v.as_i64());
    let default_tracking_branch = store
        .get(KEY_DEFAULT_BRANCH)
        .and_then(|v| v.as_str().map(String::from))
        .unwrap_or_else(|| "main".to_string());
    Connection {
        org_url,
        project,
        default_plan_id,
        default_tracking_branch,
    }
}

fn save_connection_to_store(app: &AppHandle, conn: &Connection) -> Result<(), String> {
    let store = app.store(STORE_PATH).map_err(|e| e.to_string())?;
    store.set(KEY_ORG, serde_json::Value::String(conn.org_url.clone()));
    store.set(KEY_PROJECT, serde_json::Value::String(conn.project.clone()));
    if let Some(p) = conn.default_plan_id {
        store.set(KEY_DEFAULT_PLAN, serde_json::Value::from(p));
    }
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
    pub default_plan_id: Option<i64>,
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
        default_plan_id: input.default_plan_id,
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
        default_plan_id: c.default_plan_id,
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
}

#[tauri::command]
pub async fn ado_delete_test_case(
    state: State<'_, AdoState>,
    input: DeleteCaseInput,
) -> Result<(), AdoError> {
    test_cases::delete_test_case(&state, input.case_id, input.destroy).await
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

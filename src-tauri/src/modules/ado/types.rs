//! Serde structs mirroring the ADO REST surface we use.
//!
//! Only fields DevOps Studio needs are modelled — extra fields in responses
//! are ignored by serde's default behavior. This keeps the code stable when
//! Microsoft adds new optional fields.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub org_url: String,
    pub project: String,
    pub default_plan_id: Option<i64>,
    pub default_tracking_branch: String,
}

impl Default for Connection {
    fn default() -> Self {
        Self {
            org_url: String::new(),
            project: String::new(),
            default_plan_id: None,
            default_tracking_branch: "main".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionStatus {
    pub configured: bool,
    pub has_pat: bool,
    pub identity_name: Option<String>,
    pub org_url: String,
    pub project: String,
    pub default_plan_id: Option<i64>,
    pub default_tracking_branch: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestConnectionResult {
    pub ok: bool,
    pub identity_name: Option<String>,
    pub error: Option<crate::modules::ado::errors::AdoError>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionData {
    #[serde(default)]
    pub authenticated_user: Option<AdoIdentity>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdoIdentity {
    pub display_name: Option<String>,
    pub provider_display_name: Option<String>,
    pub unique_name: Option<String>,
}

// --- Test Plans ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestPlanRef {
    pub id: i64,
    pub name: String,
    #[serde(default)]
    pub iteration: Option<String>,
    #[serde(default)]
    pub area_path: Option<String>,
    #[serde(default)]
    pub state: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuiteRef {
    pub id: i64,
    pub name: String,
    #[serde(default)]
    pub suite_type: Option<String>,
    #[serde(default)]
    pub parent_suite_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestCaseRef {
    pub id: i64,
    pub title: String,
    #[serde(default)]
    pub state: Option<String>,
}

// --- Work Items (Test Case, Bug) ---

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestCase {
    pub id: i64,
    pub title: String,
    pub state: String,
    pub area_path: Option<String>,
    pub iteration_path: Option<String>,
    pub description_html: String,
    pub steps: Vec<TestStep>,
    pub tags: Vec<String>,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestStep {
    /// 1-indexed step number.
    pub index: u32,
    pub action: String,
    pub expected: String,
}

// --- Drafts the frontend hands the publisher ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftCase {
    pub title: String,
    pub description: String,
    pub steps: Vec<TestStep>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub area_path: Option<String>,
    #[serde(default)]
    pub iteration_path: Option<String>,
    /// Markdown source-links block to inject into the description.
    #[serde(default)]
    pub source_links_block: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftBug {
    pub title: String,
    pub repro_steps: String,
    /// "1-Critical" | "2-High" | "3-Medium" | "4-Low"
    pub severity: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedWorkItem {
    pub id: i64,
    pub url: String,
    pub web_url: String,
}

// --- Repos ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoRef {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub default_branch: Option<String>,
    #[serde(default)]
    pub web_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub content: String,
    pub sha: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub commit_id: String,
    pub author_name: Option<String>,
    pub comment: Option<String>,
    pub committed_date: Option<String>,
    #[serde(default)]
    pub changed_files: Vec<String>,
}

// --- Staleness ---

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StaleCaseInfo {
    pub case_id: i64,
    pub reason: String,
    pub changed_files: Vec<String>,
    pub commit_count: u32,
}

// --- Generic paged response from ADO REST ---

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", bound(deserialize = "T: Deserialize<'de>"))]
pub struct PagedResponse<T> {
    /// ADO returns the total in `count`. We don't currently use it; keep
    /// it in the struct so `#[serde(deny_unknown_fields)]` could be added
    /// later without breaking deserialization.
    #[serde(default)]
    #[allow(dead_code)]
    pub count: usize,
    #[serde(default = "Vec::new")]
    pub value: Vec<T>,
}

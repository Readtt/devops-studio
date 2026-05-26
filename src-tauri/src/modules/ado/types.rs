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
    /// Per-tenant UUID returned by every real Azure DevOps server. Used in
    /// `auth::test_connection` to distinguish a genuine ADO response from a
    /// CDN/wildcard tenant that 200s with an empty payload.
    #[serde(default)]
    pub instance_id: Option<String>,
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

// --- Test execution (test points) ---

/// A test point — the (test case × configuration) pair inside one suite of
/// one plan. Pass/Fail/Blocked outcomes live on the POINT, never on the case
/// work item, so the same case in two suites carries two independent results.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestPointInfo {
    pub id: i64,
    pub configuration_id: Option<i64>,
    pub configuration_name: Option<String>,
    /// Latest outcome as ADO reports it: "Passed" | "Failed" | "Blocked" |
    /// "NotApplicable" | "Unspecified" | "NotExecuted" | "Active" | …
    pub outcome: String,
    pub tester: Option<String>,
    pub last_updated: Option<String>,
}

/// A (plan, suite) pair that contains a given test case. Powers the
/// execution-target picker when a case is opened without suite context.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaseSuiteMembership {
    pub plan_id: i64,
    pub plan_name: Option<String>,
    pub suite_id: i64,
    pub suite_name: Option<String>,
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
    // --- Developer-facing metadata (Phase 4) ----------------------------------
    #[serde(default)]
    pub assigned_to: Option<String>,
    /// "1" (highest) to "4" — ADO stores Priority as an integer in this field.
    #[serde(default)]
    pub priority: Option<u8>,
    #[serde(default)]
    pub created_by: Option<String>,
    /// ISO-8601 string straight from ADO.
    #[serde(default)]
    pub created_date: Option<String>,
    #[serde(default)]
    pub changed_by: Option<String>,
    #[serde(default)]
    pub changed_date: Option<String>,
    /// Parent / Child / Related / Tested-By links pulled from the work item's
    /// `relations` array. Titles are not fetched here — the UI shows the id
    /// and rel kind, with a click-through to ADO web.
    #[serde(default)]
    pub linked_work_items: Vec<LinkedWorkItem>,
}

/// A single relation entry on a work item.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedWorkItem {
    pub id: i64,
    /// Friendly display name we map onto the raw ADO `rel` string —
    /// "Parent" / "Child" / "Related" / "Tested By" / "Tests" / "Other".
    pub kind: String,
    /// Raw `rel` value from ADO so the UI can disambiguate edge cases.
    pub rel: String,
    /// `{org}/{project}/_workitems/edit/{id}` — built locally; ADO's `url`
    /// field on the relation is the REST URL, not the web one.
    pub web_url: String,
}

/// Fully-projected Bug for the BugPane. Mirrors TestCase but carries Bug
/// fields (severity, repro steps, code-links block). The Bug code-links
/// parser is on the TS side — we return repro_steps_html verbatim and let
/// the UI extract the structured block.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bug {
    pub id: i64,
    pub title: String,
    pub state: String,
    /// "1 - Critical" | "2 - High" | "3 - Medium" | "4 - Low" (or empty).
    #[serde(default)]
    pub severity: Option<String>,
    /// "1" .. "4" — same scale as TestCase.priority.
    #[serde(default)]
    pub priority: Option<u8>,
    pub area_path: Option<String>,
    pub iteration_path: Option<String>,
    /// Raw HTML for repro steps. Includes the devops-studio:code-links block
    /// the TS side parses out into structured anchors.
    pub repro_steps_html: String,
    pub tags: Vec<String>,
    pub url: String,
    #[serde(default)]
    pub assigned_to: Option<String>,
    #[serde(default)]
    pub created_by: Option<String>,
    #[serde(default)]
    pub created_date: Option<String>,
    #[serde(default)]
    pub changed_by: Option<String>,
    #[serde(default)]
    pub changed_date: Option<String>,
    #[serde(default)]
    pub linked_work_items: Vec<LinkedWorkItem>,
}

/// Lightweight bug projection for the bug-context picker — just the fields a
/// row shows. Full repro/relations come from `get_bug` when a bug is selected.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BugRef {
    pub id: i64,
    pub title: String,
    pub state: String,
    /// "1 - Critical" | "2 - High" | "3 - Medium" | "4 - Low" (or empty).
    #[serde(default)]
    pub severity: Option<String>,
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
    /// Source-code references attached to the bug. Serialized into the bug's
    /// description as a `<!-- devops-studio:code-links -->` block so we can
    /// round-trip them out of ADO later.
    #[serde(default)]
    pub code_links: Vec<CodeLink>,
    /// If set, the created bug is linked as a Child of this test case
    /// (rel = `System.LinkTypes.Hierarchy-Reverse`). Use this when bug
    /// generation is driven by a specific case; leave None for standalone bugs.
    #[serde(default)]
    pub parent_case_id: Option<i64>,
}

/// Source-code anchor on a bug or test case. Paths are stored relative to the
/// user's chosen source directory so they survive moving the working copy.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeLink {
    pub file: String,
    pub start_line: u32,
    /// Inclusive end line. Omit for a single-line anchor (start == end).
    #[serde(default)]
    pub end_line: Option<u32>,
    /// Optional Git commit SHA the anchor was captured against, so we can
    /// detect drift when the file changes later.
    #[serde(default)]
    pub commit_sha: Option<String>,
}

/// ADO project metadata returned by `_apis/projects`. Used to populate the
/// project dropdown in Settings.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRef {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    /// "wellFormed" | "createPending" | "deleting" — only "wellFormed" is
    /// safe to query against, but we surface the rest so the UI can disable.
    #[serde(default)]
    pub state: Option<String>,
    /// "private" | "public" — interesting mostly for org-wide reporting.
    #[serde(default)]
    pub visibility: Option<String>,
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

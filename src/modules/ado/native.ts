/**
 * Thin TypeScript wrapper around the Tauri ADO commands.
 *
 * Each function:
 *   - Sends a single typed Tauri invoke.
 *   - Validates the response with the corresponding zod schema (catches
 *     wire-format drift early during development).
 *   - Re-throws errors with the original AdoError shape so the UI can switch
 *     on `kind` for targeted handling (e.g. show "Re-authorize SSO" hint).
 */
import { invoke } from "@tauri-apps/api/core";
import {
  BugSchema,
  ConnectionStatusSchema,
  CommitInfoSchema,
  CaseSuiteMembershipSchema,
  CreatedWorkItemSchema,
  FileContentSchema,
  ProjectRefSchema,
  RepoRefSchema,
  StaleCaseInfoSchema,
  SuiteRefSchema,
  TestCaseRefSchema,
  TestCaseSchema,
  TestConnectionResultSchema,
  TestPlanRefSchema,
  TestPointInfoSchema,
  type AdoError,
  type Bug,
  type CaseSuiteMembership,
  type CommitInfo,
  type ConnectionStatus,
  type CreatedWorkItem,
  type DraftBug,
  type DraftCase,
  type ExecutionOutcome,
  type FileContent,
  type ProjectRef,
  type RepoRef,
  type StaleCaseInfo,
  type SuiteRef,
  type TestCase,
  type TestCaseRef,
  type TestConnectionResult,
  type TestPlanRef,
  type TestPointInfo,
} from "./types";

/** Convert an unknown Tauri rejection value into a typed AdoError when possible. */
export function toAdoError(err: unknown): AdoError {
  if (err && typeof err === "object" && "kind" in (err as Record<string, unknown>)) {
    return err as AdoError;
  }
  return { kind: "local", message: String(err) };
}

/** Produce a one-line human-readable string from an AdoError for UI display. */
export function adoErrorMessage(err: AdoError | null | undefined): string {
  if (!err) return "";
  switch (err.kind) {
    case "not-configured":
      return "Azure DevOps is not configured. Open settings to connect.";
    case "bad-pat":
      return `PAT rejected: ${err.reason}`;
    case "sso-required":
      return "PAT is not SSO-authorized. Open the PAT page and click Authorize SSO.";
    case "forbidden":
      return `Access denied to ${err.resource}.`;
    case "not-found":
      return `Not found: ${err.resource}.`;
    case "rate-limited":
      return `Rate limited — retry in ${err.retryAfterS}s.`;
    case "network":
      return `Network error: ${err.message}`;
    case "server":
      return `Server returned ${err.status}.`;
    case "local":
      return err.message;
  }
}

// --- Connection ---

export type SetConnectionArgs = {
  orgUrl: string;
  project: string;
  /** Provide a non-empty PAT to set; empty string clears it; undefined leaves it as-is. */
  pat?: string;
  defaultPlanId?: number | null;
  defaultTrackingBranch?: string;
};

export async function setConnection(input: SetConnectionArgs): Promise<void> {
  await invoke("ado_set_connection", { input });
}

export async function getConnection(): Promise<ConnectionStatus> {
  const raw = await invoke("ado_get_connection");
  return ConnectionStatusSchema.parse(raw);
}

export async function testConnection(): Promise<TestConnectionResult> {
  const raw = await invoke("ado_test_connection");
  return TestConnectionResultSchema.parse(raw);
}

export async function clearPat(): Promise<void> {
  await invoke("ado_clear_pat");
}

// --- Projects (used by the Project dropdown in Settings) ---

export async function listProjects(): Promise<ProjectRef[]> {
  const raw = await invoke("ado_list_projects");
  return ProjectRefSchema.array().parse(raw);
}

// --- Test Plans reads ---

export async function listPlans(): Promise<TestPlanRef[]> {
  const raw = await invoke("ado_list_plans");
  return TestPlanRefSchema.array().parse(raw);
}

export async function listSuites(planId: number): Promise<SuiteRef[]> {
  const raw = await invoke("ado_list_suites", { planId });
  return SuiteRefSchema.array().parse(raw);
}

export async function listSuiteCases(
  planId: number,
  suiteId: number,
): Promise<TestCaseRef[]> {
  const raw = await invoke("ado_list_suite_cases", { planId, suiteId });
  return TestCaseRefSchema.array().parse(raw);
}

export type CreateSuiteArgs = {
  planId: number;
  /** `null` attaches the new suite under the plan's root (i.e. top-level). */
  parentSuiteId: number | null;
  name: string;
};

export async function createSuite(input: CreateSuiteArgs): Promise<SuiteRef> {
  const raw = await invoke("ado_create_suite", { input });
  return SuiteRefSchema.parse(raw);
}

/** Rename an existing static test suite. ADO returns the updated SuiteRef
 *  on success; an empty name is rejected on the Rust side. */
export async function updateSuiteName(
  planId: number,
  suiteId: number,
  name: string,
): Promise<SuiteRef> {
  const raw = await invoke("ado_update_suite_name", {
    input: { planId, suiteId, name },
  });
  return SuiteRefSchema.parse(raw);
}

/** Rename a Test Plan. Same contract as updateSuiteName — returns the
 *  refreshed TestPlanRef so callers can swap it into local state without
 *  another fetch. */
export async function updatePlanName(
  planId: number,
  name: string,
): Promise<TestPlanRef> {
  const raw = await invoke("ado_update_plan_name", {
    input: { planId, name },
  });
  return TestPlanRefSchema.parse(raw);
}

export async function getCase(caseId: number): Promise<TestCase> {
  const raw = await invoke("ado_get_case", { caseId });
  return TestCaseSchema.parse(raw);
}

// --- Test execution (Execute tab) ---

/** Read the test point(s) for a case inside a specific plan + suite. One row
 *  per test configuration — usually just the default config. */
export async function listTestPoints(
  planId: number,
  suiteId: number,
  caseId: number,
): Promise<TestPointInfo[]> {
  const raw = await invoke("ado_list_test_points", { planId, suiteId, caseId });
  return TestPointInfoSchema.array().parse(raw);
}

/** Which (plan, suite) pairs contain this case — for the execution-target
 *  picker shown when a case is opened without suite context. */
export async function listSuitesForCase(
  caseId: number,
): Promise<CaseSuiteMembership[]> {
  const raw = await invoke("ado_list_suites_for_case", { caseId });
  return CaseSuiteMembershipSchema.array().parse(raw);
}

/** Record an outcome on a test point. An optional `comment` is appended to
 *  the case's ADO discussion so a failure reason is preserved. Returns the
 *  point's refreshed state. */
export async function setTestPointOutcome(input: {
  planId: number;
  suiteId: number;
  pointId: number;
  caseId: number;
  outcome: ExecutionOutcome;
  comment?: string | null;
}): Promise<TestPointInfo> {
  const raw = await invoke("ado_set_test_point_outcome", {
    input: {
      planId: input.planId,
      suiteId: input.suiteId,
      pointId: input.pointId,
      caseId: input.caseId,
      outcome: input.outcome,
      comment: input.comment ?? null,
    },
  });
  return TestPointInfoSchema.parse(raw);
}

// --- Publishing ---

export async function createCaseInSuite(
  planId: number,
  suiteId: number,
  draft: DraftCase,
): Promise<CreatedWorkItem> {
  const raw = await invoke("ado_create_case_in_suite", {
    input: { planId, suiteId, draft },
  });
  return CreatedWorkItemSchema.parse(raw);
}

/** Soft-delete a test case (moves it to ADO's Recycle Bin — recoverable
 *  for 30 days). Pass `destroy: true` only when permanent deletion is
 *  intentional; the chat-driven path defaults to soft so accidents are
 *  reversible. */
export async function deleteTestCase(input: {
  caseId: number;
  destroy?: boolean;
}): Promise<void> {
  await invoke("ado_delete_test_case", {
    input: { caseId: input.caseId, destroy: input.destroy ?? false },
  });
}

export async function createBugAndLink(
  caseId: number,
  draft: DraftBug,
): Promise<CreatedWorkItem> {
  const raw = await invoke("ado_create_bug_and_link", {
    input: { caseId, draft },
  });
  return CreatedWorkItemSchema.parse(raw);
}

/**
 * Standalone bug creation. No required link to a test case — pass
 * `draft.parentCaseId` to nest the bug under a case in the work-item tree,
 * or leave undefined for a free-standing bug.
 */
export async function createBug(draft: DraftBug): Promise<CreatedWorkItem> {
  const raw = await invoke("ado_create_bug", { draft });
  return CreatedWorkItemSchema.parse(raw);
}

/** Link an existing bug to a case as its Parent in the work-item tree. */
export async function linkBugToCase(
  bugId: number,
  caseId: number,
): Promise<void> {
  await invoke("ado_link_bug_to_case", { input: { bugId, caseId } });
}

/** Fetch a Bug work item by id for the BugPane. */
export async function getBug(bugId: number): Promise<Bug> {
  const raw = await invoke("ado_get_bug", { bugId });
  return BugSchema.parse(raw);
}

export async function updateCaseDescription(
  caseId: number,
  description: string,
): Promise<void> {
  await invoke("ado_update_case_description", {
    input: { caseId, description },
  });
}

/** Rename any work item (test case, bug, etc) by patching System.Title.
 *  Trims whitespace on the Rust side and rejects empty titles before
 *  hitting the wire. */
export async function updateWorkItemTitle(
  workItemId: number,
  title: string,
): Promise<void> {
  await invoke("ado_update_work_item_title", {
    input: { workItemId, title },
  });
}

/** Replace the full step list on a test case. The Rust side rebuilds
 *  Microsoft.VSTS.TCM.Steps XML via the same path the create flow uses.
 *  Empty step lists are rejected — ADO accepts them but the UI treats it
 *  as an almost-certain bug rather than intent. */
export async function updateCaseSteps(
  caseId: number,
  steps: { index: number; action: string; expected: string }[],
): Promise<void> {
  await invoke("ado_update_case_steps", {
    input: { caseId, steps },
  });
}

export async function addTag(workItemId: number, tag: string): Promise<void> {
  await invoke("ado_add_tag", { input: { workItemId, tag } });
}

export async function removeTag(workItemId: number, tag: string): Promise<void> {
  await invoke("ado_remove_tag", { input: { workItemId, tag } });
}

// --- Repos ---

export async function listRepos(): Promise<RepoRef[]> {
  const raw = await invoke("ado_list_repos");
  return RepoRefSchema.array().parse(raw);
}

export async function getFile(
  repoId: string,
  branch: string,
  path: string,
): Promise<FileContent> {
  const raw = await invoke("ado_get_file", {
    input: { repoId, branch, path },
  });
  return FileContentSchema.parse(raw);
}

export async function listCommitsSince(
  repoId: string,
  branch: string,
  sinceSha?: string,
): Promise<CommitInfo[]> {
  const raw = await invoke("ado_list_commits_since", {
    input: { repoId, branch, sinceSha },
  });
  return CommitInfoSchema.array().parse(raw);
}

// --- Staleness ---

export async function scanStaleness(): Promise<StaleCaseInfo[]> {
  const raw = await invoke("ado_scan_staleness");
  return StaleCaseInfoSchema.array().parse(raw);
}

export async function acknowledgeCase(caseId: number): Promise<void> {
  await invoke("ado_acknowledge_case", { input: { caseId } });
}

export async function markForReview(
  caseId: number,
  reason: string,
): Promise<void> {
  await invoke("ado_mark_for_review", { input: { caseId, reason } });
}

export type WorkItemTitle = {
  id: number;
  title: string;
};

/** Batch-fetch System.Title for a list of work-item ids. Used to surface
 *  human-readable previews on linked-work-item rows. */
export async function getWorkItemTitles(
  ids: number[],
): Promise<WorkItemTitle[]> {
  if (ids.length === 0) return [];
  const raw = await invoke<WorkItemTitle[]>("ado_get_work_item_titles", { ids });
  return raw;
}

export type IndexLinkInput = {
  repoId: string;
  branch: string;
  filePath: string;
  symbol?: string | null;
  baselineSha?: string;
};

export async function indexCaseLinks(
  caseId: number,
  links: IndexLinkInput[],
): Promise<void> {
  await invoke("ado_index_case_links", { input: { caseId, links } });
}

/**
 * Build a deep-link to ADO Repos web for a given source link.
 * Used by Phase 7 source-link chips.
 */
export function buildAdoReposWebUrl(args: {
  orgUrl: string;
  project: string;
  repoName: string;
  branch: string;
  filePath: string;
  lineRange?: { start: number; end: number };
}): string {
  const params = new URLSearchParams({
    path: args.filePath,
    version: `GB${args.branch}`,
  });
  if (args.lineRange) {
    params.set("line", String(args.lineRange.start));
    params.set("lineEnd", String(args.lineRange.end));
  }
  const org = args.orgUrl.replace(/\/$/, "");
  return `${org}/${encodeURIComponent(args.project)}/_git/${encodeURIComponent(args.repoName)}?${params}`;
}

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
import { z } from "zod";
import {
  AdoDiffSummarySchema,
  BranchRefSchema,
  BugSchema,
  BugRefSchema,
  ConnectionStatusSchema,
  CommitInfoSchema,
  CaseSuiteMembershipSchema,
  CreatedWorkItemSchema,
  FileContentSchema,
  ProjectRefSchema,
  PublishedCaseSchema,
  PullRequestRefSchema,
  RepoRefSchema,
  SuiteBugSchema,
  SuiteRefSchema,
  TeamMemberSchema,
  TestCaseRefSchema,
  TestCaseSchema,
  TestConnectionResultSchema,
  TestPlanRefSchema,
  TestPointInfoSchema,
  WorkItemRefSchema,
  type AdoError,
  type AdoDiffSummary,
  type BranchRef,
  type Bug,
  type BugRef,
  type WorkItemRef,
  type CaseSuiteMembership,
  type CommitInfo,
  type PullRequestRef,
  type ConnectionStatus,
  type CreatedWorkItem,
  type DraftBug,
  type DraftCase,
  type ExecutionOutcome,
  type FileContent,
  type ProjectRef,
  type PublishedCase,
  type RepoRef,
  type SuiteBug,
  type SuiteRef,
  type TeamMember,
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
    case "server": {
      const detail = extractAdoErrorDetail(err.bodyExcerpt);
      return detail
        ? `Azure DevOps error ${err.status}: ${detail}`
        : `Server returned ${err.status}.`;
    }
    case "local":
      return err.message;
  }
}

/** ADO error bodies are usually JSON ({"message":"TF...: …"}). Pull the human
 *  message out so the UI shows WHY a request failed instead of a bare status
 *  code; fall back to the raw (whitespace-collapsed) excerpt. */
function extractAdoErrorDetail(bodyExcerpt: string): string {
  const body = (bodyExcerpt ?? "").trim();
  if (!body) return "";
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    if (typeof parsed.message === "string" && parsed.message.trim()) {
      return parsed.message.trim().slice(0, 300);
    }
  } catch {
    // not JSON — fall through to the raw excerpt
  }
  return body.replace(/\s+/g, " ").slice(0, 300);
}

// --- Connection ---

export type SetConnectionArgs = {
  orgUrl: string;
  project: string;
  /** Provide a non-empty PAT to set; empty string clears it; undefined leaves it as-is. */
  pat?: string;
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

/** Every Bug linked to a suite's test cases, with each bug's ADO workflow state
 *  category resolved (so the caller can filter "open" without hardcoding state
 *  names). Walks the suite's cases and their work-item relations server-side. */
export async function listSuiteBugs(
  planId: number,
  suiteId: number,
): Promise<SuiteBug[]> {
  const raw = await invoke("ado_list_suite_bugs", { planId, suiteId });
  return SuiteBugSchema.array().parse(raw);
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

export type CreateRequirementSuiteArgs = {
  planId: number;
  /** `null` attaches the new suite under the plan's root (i.e. top-level). */
  parentSuiteId: number | null;
  /** Work item the suite tracks. Must be a type in the project's Requirement
   *  category — see {@link listRequirementTypes}. */
  requirementId: number;
  /** Requirement title. Optional; ADO derives the name from the work item. */
  name?: string | null;
};

/** Create ONE requirement-based suite. Every test case added to it is
 *  auto-linked to the requirement as "Tested By" — the only link Azure DevOps'
 *  requirement-coverage reporting understands. Bulk creation across a query's
 *  worth of requirements stays in the ADO web UI. */
export async function createRequirementSuite(
  input: CreateRequirementSuiteArgs,
): Promise<SuiteRef> {
  const raw = await invoke("ado_create_requirement_suite", {
    input: { ...input, name: input.name ?? null },
  });
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

/** Create a Test Case work item and link it into the suite. The result carries
 *  `testPointCount` — zero means Azure DevOps made no test point, so the case
 *  won't show in its Execute tab; `pointWarning` then explains why. */
export async function createCaseInSuite(
  planId: number,
  suiteId: number,
  draft: DraftCase,
): Promise<PublishedCase> {
  const raw = await invoke("ado_create_case_in_suite", {
    input: { planId, suiteId, draft },
  });
  return PublishedCaseSchema.parse(raw);
}

/** Delete a test case. Pass `planId`/`suiteId` (the suite it's being deleted
 *  from) so the backend can unlink it from that suite first — ADO returns 400
 *  if you try to delete a Test Case work item while a suite still references
 *  it. The case then lands in ADO's Recycle Bin (recoverable for 30 days).
 *  Pass `destroy: true` only when permanent deletion is intentional; the
 *  chat-driven path defaults to soft so accidents are reversible. */
export async function deleteTestCase(input: {
  caseId: number;
  planId?: number | null;
  suiteId?: number | null;
  destroy?: boolean;
}): Promise<void> {
  await invoke("ado_delete_test_case", {
    input: {
      caseId: input.caseId,
      destroy: input.destroy ?? false,
      planId: input.planId ?? null,
      suiteId: input.suiteId ?? null,
    },
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

/** List everyone assignable across the project's teams for the review-phase
 *  developer picker. Returns deduped, name-sorted people; empty when the PAT
 *  can't read any team's membership. */
export async function listTeamMembers(): Promise<TeamMember[]> {
  const raw = await invoke("ado_list_team_members");
  return TeamMemberSchema.array().parse(raw);
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

/** List bugs for the bug-context picker. WIQL-backed; optionally scope by
 *  `areaPath` and/or a free-text `query` on the title. Returns lightweight
 *  rows newest-changed first — full bodies come from `getBug` on selection. */
export async function listBugs(input?: {
  areaPath?: string | null;
  query?: string | null;
  top?: number;
}): Promise<BugRef[]> {
  const raw = await invoke("ado_list_bugs", {
    input: {
      areaPath: input?.areaPath ?? null,
      query: input?.query ?? null,
      top: input?.top ?? null,
    },
  });
  return BugRefSchema.array().parse(raw);
}

/** Search work items of ANY type for the inline `#id` mention. WIQL-backed,
 *  newest-changed first; full bodies come from `getBug` (works for any type)
 *  on selection. */
export async function searchWorkItems(input?: {
  areaPath?: string | null;
  query?: string | null;
  top?: number;
  /** Narrow to these work-item types. Omit/empty = every type except the
   *  test-management artifacts. The requirement-suite picker passes the
   *  project's Requirement category so only valid choices appear. */
  workItemTypes?: string[];
}): Promise<WorkItemRef[]> {
  const raw = await invoke("ado_list_work_items", {
    input: {
      areaPath: input?.areaPath ?? null,
      query: input?.query ?? null,
      top: input?.top ?? null,
      workItemTypes: input?.workItemTypes ?? [],
    },
  });
  return WorkItemRefSchema.array().parse(raw);
}

/** Work-item types this project treats as requirements ("User Story" on Agile,
 *  "Product Backlog Item" on Scrum, …). Only these can back a
 *  requirement-based test suite. */
export async function listRequirementTypes(): Promise<string[]> {
  const raw = await invoke("ado_list_requirement_types");
  return z.string().array().parse(raw);
}

/** Resolve a single work item by id (for `#123` exact matches). */
export async function getWorkItem(id: number): Promise<WorkItemRef> {
  const raw = await invoke("ado_get_work_item_ref", { id });
  return WorkItemRefSchema.parse(raw);
}

/** Patch a bug's title / repro steps / severity / state. Only the fields you
 *  pass are changed; everything omitted is left untouched. */
export async function updateBug(input: {
  bugId: number;
  title?: string;
  reproSteps?: string;
  severity?: string;
  state?: string;
}): Promise<void> {
  await invoke("ado_update_bug", {
    input: {
      bugId: input.bugId,
      title: input.title ?? null,
      reproSteps: input.reproSteps ?? null,
      severity: input.severity ?? null,
      state: input.state ?? null,
    },
  });
}

/** Soft-delete a bug (moves it to ADO's Recycle Bin — recoverable). Pass
 *  `destroy: true` only for permanent deletion; the chat-driven path defaults
 *  to soft so accidents are reversible. */
export async function deleteBug(input: {
  bugId: number;
  destroy?: boolean;
}): Promise<void> {
  await invoke("ado_delete_bug", {
    input: { bugId: input.bugId, destroy: input.destroy ?? false },
  });
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

/** List a repo's branches (Code Review source picker). */
export async function adoListBranches(repoId: string): Promise<BranchRef[]> {
  const raw = await invoke("ado_list_branches", { input: { repoId } });
  return BranchRefSchema.array().parse(raw);
}

/** Recent commits on a branch — lightweight, for the source picker list. */
export async function adoListRecentCommits(
  repoId: string,
  branch: string,
  top?: number,
): Promise<CommitInfo[]> {
  const raw = await invoke("ado_list_recent_commits", {
    input: { repoId, branch, top: top ?? null },
  });
  return CommitInfoSchema.array().parse(raw);
}

// --- ADO diffs (Code Review ADO source) ---

/** Diff a single commit vs its parent. */
export async function adoDiffCommit(
  repoId: string,
  commitId: string,
): Promise<AdoDiffSummary> {
  const raw = await invoke("ado_diff_commit", { input: { repoId, commitId } });
  return AdoDiffSummarySchema.parse(raw);
}

/** Diff a target branch vs a base branch. */
export async function adoDiffBranches(
  repoId: string,
  baseBranch: string,
  targetBranch: string,
): Promise<AdoDiffSummary> {
  const raw = await invoke("ado_diff_branches", {
    input: { repoId, baseBranch, targetBranch },
  });
  return AdoDiffSummarySchema.parse(raw);
}

/** List active pull requests for the PR picker. */
export async function adoListPullRequests(
  repoId: string,
  top?: number,
): Promise<PullRequestRef[]> {
  const raw = await invoke("ado_list_pull_requests", {
    input: { repoId, top: top ?? null },
  });
  return PullRequestRefSchema.array().parse(raw);
}

/** Diff a pull request (source vs target). */
export async function adoDiffPullRequest(
  repoId: string,
  prId: number,
): Promise<AdoDiffSummary> {
  const raw = await invoke("ado_diff_pull_request", { input: { repoId, prId } });
  return AdoDiffSummarySchema.parse(raw);
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

/**
 * Build a deep-link to ADO Repos web for a given source link.
 * Used by Phase 7 source-link chips.
 */
export function buildAdoReposWebUrl(args: {
  orgUrl: string;
  project: string;
  repoName: string;
  /** Omitted when the link carries no branch — a case published with source
   *  tagging off, or from a detached HEAD. `?version=` is then left off too, so
   *  ADO resolves the repo's own default branch instead of a `main` we made up
   *  (a 404 on every repo whose default is `master` or `develop`). */
  branch?: string;
  filePath: string;
  lineRange?: { start: number; end: number };
}): string {
  const params = new URLSearchParams({ path: args.filePath });
  if (args.branch) params.set("version", `GB${args.branch}`);
  if (args.lineRange) {
    params.set("line", String(args.lineRange.start));
    params.set("lineEnd", String(args.lineRange.end));
  }
  const org = args.orgUrl.replace(/\/$/, "");
  return `${org}/${encodeURIComponent(args.project)}/_git/${encodeURIComponent(args.repoName)}?${params}`;
}

import { z } from "zod";

// --- Connection ---

export const ConnectionStatusSchema = z.object({
  configured: z.boolean(),
  hasPat: z.boolean(),
  identityName: z.string().nullable().optional(),
  orgUrl: z.string(),
  project: z.string(),
  defaultTrackingBranch: z.string(),
});
export type ConnectionStatus = z.infer<typeof ConnectionStatusSchema>;

export const AdoErrorSchema = z.union([
  z.object({ kind: z.literal("not-configured") }),
  z.object({ kind: z.literal("bad-pat"), reason: z.string() }),
  z.object({ kind: z.literal("sso-required") }),
  z.object({ kind: z.literal("forbidden"), resource: z.string() }),
  z.object({ kind: z.literal("not-found"), resource: z.string() }),
  z.object({ kind: z.literal("rate-limited"), retryAfterS: z.number() }),
  z.object({ kind: z.literal("network"), message: z.string() }),
  z.object({ kind: z.literal("server"), status: z.number(), bodyExcerpt: z.string() }),
  z.object({ kind: z.literal("local"), message: z.string() }),
]);
export type AdoError = z.infer<typeof AdoErrorSchema>;

export const TestConnectionResultSchema = z.object({
  ok: z.boolean(),
  identityName: z.string().nullable().optional(),
  error: AdoErrorSchema.nullable().optional(),
});
export type TestConnectionResult = z.infer<typeof TestConnectionResultSchema>;

// --- Test Plans ---

export const TestPlanRefSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  iteration: z.string().nullable().optional(),
  areaPath: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
});
export type TestPlanRef = z.infer<typeof TestPlanRefSchema>;

export const SuiteRefSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  suiteType: z.string().nullable().optional(),
  parentSuiteId: z.number().int().nullable().optional(),
});
export type SuiteRef = z.infer<typeof SuiteRefSchema>;

export const TestCaseRefSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  state: z.string().nullable().optional(),
});
export type TestCaseRef = z.infer<typeof TestCaseRefSchema>;

export const TestStepSchema = z.object({
  index: z.number().int(),
  action: z.string(),
  expected: z.string(),
});
export type TestStep = z.infer<typeof TestStepSchema>;

// --- Test execution (Execute tab) ---

/** Outcomes the Execute bar can set. `Active` resets a point to "not run". */
export const EXECUTION_OUTCOMES = [
  "Passed",
  "Failed",
  "Blocked",
  "NotApplicable",
  "Active",
] as const;
export const ExecutionOutcomeSchema = z.enum(EXECUTION_OUTCOMES);
export type ExecutionOutcome = z.infer<typeof ExecutionOutcomeSchema>;

/** A test point: a case × configuration inside one suite of one plan. The
 *  Pass/Fail/Blocked outcome lives here, not on the case work item. */
export const TestPointInfoSchema = z.object({
  id: z.number().int(),
  configurationId: z.number().int().nullable().optional(),
  configurationName: z.string().nullable().optional(),
  /** Raw ADO outcome string — may be any of the EXECUTION_OUTCOMES plus
   *  "Unspecified" / "NotExecuted" for a point that's never been run. */
  outcome: z.string(),
  tester: z.string().nullable().optional(),
  lastUpdated: z.string().nullable().optional(),
});
export type TestPointInfo = z.infer<typeof TestPointInfoSchema>;

/** A (plan, suite) that contains a given case — for the target picker shown
 *  when a case is opened without suite context. */
export const CaseSuiteMembershipSchema = z.object({
  planId: z.number().int(),
  planName: z.string().nullable().optional(),
  suiteId: z.number().int(),
  suiteName: z.string().nullable().optional(),
});
export type CaseSuiteMembership = z.infer<typeof CaseSuiteMembershipSchema>;

export const LinkedWorkItemSchema = z.object({
  id: z.number().int(),
  /** Friendly label: "Parent" / "Child" / "Related" / "Tested by" / "Tests" / "Other". */
  kind: z.string(),
  /** Raw ADO `rel` (e.g. "System.LinkTypes.Hierarchy-Reverse"). */
  rel: z.string(),
  /** Built locally as `{org}/{project}/_workitems/edit/{id}`. */
  webUrl: z.string(),
});
export type LinkedWorkItem = z.infer<typeof LinkedWorkItemSchema>;

export const TestCaseSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  state: z.string(),
  areaPath: z.string().nullable().optional(),
  iterationPath: z.string().nullable().optional(),
  descriptionHtml: z.string(),
  steps: z.array(TestStepSchema),
  tags: z.array(z.string()),
  url: z.string(),
  // Phase 4: developer-facing metadata
  assignedTo: z.string().nullable().optional(),
  priority: z.number().int().min(1).max(4).nullable().optional(),
  createdBy: z.string().nullable().optional(),
  createdDate: z.string().nullable().optional(),
  changedBy: z.string().nullable().optional(),
  changedDate: z.string().nullable().optional(),
  linkedWorkItems: z.array(LinkedWorkItemSchema).default([]),
});
export type TestCase = z.infer<typeof TestCaseSchema>;

// --- Drafts ---

export const DraftCaseSchema = z.object({
  title: z.string().min(1),
  description: z.string(),
  steps: z.array(TestStepSchema).min(1),
  tags: z.array(z.string()).default([]),
  areaPath: z.string().nullable().optional(),
  iterationPath: z.string().nullable().optional(),
  sourceLinksBlock: z.string().nullable().optional(),
});
export type DraftCase = z.infer<typeof DraftCaseSchema>;

export const CodeLinkSchema = z.object({
  /** Path relative to the user's chosen source directory. */
  file: z.string().min(1),
  startLine: z.number().int().nonnegative(),
  endLine: z.number().int().nonnegative().nullable().optional(),
  commitSha: z.string().nullable().optional(),
});
export type CodeLink = z.infer<typeof CodeLinkSchema>;

export const DraftBugSchema = z.object({
  title: z.string().min(1),
  reproSteps: z.string(),
  severity: z.enum(["1 - Critical", "2 - High", "3 - Medium", "4 - Low"]),
  codeLinks: z.array(CodeLinkSchema).default([]),
  /** If set, the bug is linked as a Child of this test case on creation. */
  parentCaseId: z.number().int().nullable().optional(),
  /** ADO identity (unique name / email, or display name) to set as Assigned To. */
  assignedTo: z.string().nullable().optional(),
});
export type DraftBug = z.infer<typeof DraftBugSchema>;

/** A person who can be assigned a bug — the project's default-team members. */
export const TeamMemberSchema = z.object({
  displayName: z.string(),
  uniqueName: z.string(),
});
export type TeamMember = z.infer<typeof TeamMemberSchema>;

export const BugSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  state: z.string(),
  /** ADO work-item type ("Bug", "Task", "User Story", …). Present so a
   *  generic work-item attachment can label itself even though this fetch is
   *  still shaped as a Bug. */
  workItemType: z.string().optional().default(""),
  severity: z.string().nullable().optional(),
  priority: z.number().int().min(1).max(4).nullable().optional(),
  areaPath: z.string().nullable().optional(),
  iterationPath: z.string().nullable().optional(),
  reproStepsHtml: z.string(),
  tags: z.array(z.string()),
  url: z.string(),
  assignedTo: z.string().nullable().optional(),
  createdBy: z.string().nullable().optional(),
  createdDate: z.string().nullable().optional(),
  changedBy: z.string().nullable().optional(),
  changedDate: z.string().nullable().optional(),
  linkedWorkItems: z.array(LinkedWorkItemSchema).default([]),
});
export type Bug = z.infer<typeof BugSchema>;

/** Lightweight bug projection for the bug-context picker — id + the few fields
 *  a row shows. Full repro/relations come from `getBug` when a bug is selected. */
export const BugRefSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  state: z.string(),
  severity: z.string().nullable().optional(),
});
export type BugRef = z.infer<typeof BugRefSchema>;

/** A Bug linked to a suite's test cases, with its ADO workflow state *category*
 *  resolved. The category lets callers decide "open" (not Completed/Removed)
 *  without hardcoding process-specific or localized state names. */
export const SuiteBugSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  state: z.string(),
  stateCategory: z.string(),
  severity: z.string().nullable().optional(),
  assignedTo: z.string().nullable().optional(),
  /** Browser-openable work-item URL, so a copy can hyperlink the bug id. */
  webUrl: z.string(),
});
export type SuiteBug = z.infer<typeof SuiteBugSchema>;

/** Lightweight work-item projection for the inline `#id` mention — like
 *  BugRef but spans every work-item type and carries the type so the picker
 *  can label each row. */
export const WorkItemRefSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  state: z.string(),
  /** "Bug" | "Task" | "User Story" | "Feature" | "Epic" | … */
  workItemType: z.string(),
  severity: z.string().nullable().optional(),
});
export type WorkItemRef = z.infer<typeof WorkItemRefSchema>;

export const ProjectRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  /** "wellFormed" | "createPending" | "deleting" — see Rust projects.rs. */
  state: z.string().nullable().optional(),
  visibility: z.string().nullable().optional(),
});
export type ProjectRef = z.infer<typeof ProjectRefSchema>;

export const CreatedWorkItemSchema = z.object({
  id: z.number().int(),
  url: z.string(),
  webUrl: z.string(),
});
export type CreatedWorkItem = z.infer<typeof CreatedWorkItemSchema>;

// --- Repos ---

export const RepoRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  defaultBranch: z.string().nullable().optional(),
  webUrl: z.string().nullable().optional(),
  // Canonical HTTPS clone URL (dev.azure.com/{org}/{project}/_git/{repo}) — used
  // by the "Get source code" clone wizard; distinct from webUrl (browser URL).
  remoteUrl: z.string().nullable().optional(),
  // Owning project name (present on the org-wide list).
  project: z.string().nullable().optional(),
});
export type RepoRef = z.infer<typeof RepoRefSchema>;

export const FileContentSchema = z.object({
  content: z.string(),
  sha: z.string().nullable().optional(),
});
export type FileContent = z.infer<typeof FileContentSchema>;

export const CommitInfoSchema = z.object({
  commitId: z.string(),
  authorName: z.string().nullable().optional(),
  comment: z.string().nullable().optional(),
  committedDate: z.string().nullable().optional(),
  changedFiles: z.array(z.string()),
});
export type CommitInfo = z.infer<typeof CommitInfoSchema>;

export const BranchRefSchema = z.object({
  name: z.string(),
  objectId: z.string().nullable().optional(),
});
export type BranchRef = z.infer<typeof BranchRefSchema>;

export const PullRequestRefSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  sourceBranch: z.string(),
  targetBranch: z.string(),
});
export type PullRequestRef = z.infer<typeof PullRequestRefSchema>;

/** Diff payload returned by the ADO diff commands. Structurally matches the
 *  code-review pane's DiffSummary so an ADO diff feeds the same pipeline. */
export const AdoDiffSummarySchema = z.object({
  base: z.string(),
  head: z.string(),
  files: z.array(
    z.object({
      path: z.string(),
      additions: z.number(),
      deletions: z.number(),
      status: z.string(),
    }),
  ),
  rawPatch: z.string(),
  truncated: z.boolean(),
});
export type AdoDiffSummary = z.infer<typeof AdoDiffSummarySchema>;

// --- Source link (renderer-side shape, used by Phase 7) ---

export const SourceLinkSchema = z.object({
  repoId: z.string(),
  repoName: z.string(),
  generationBranch: z.string(),
  generationSha: z.string(),
  trackingBranch: z.string(),
  filePath: z.string(),
  symbol: z.string().nullable().optional(),
  lineRange: z
    .object({ start: z.number().int(), end: z.number().int() })
    .nullable()
    .optional(),
});
export type SourceLink = z.infer<typeof SourceLinkSchema>;

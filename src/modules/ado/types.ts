import { z } from "zod";

// --- Connection ---

export const ConnectionStatusSchema = z.object({
  configured: z.boolean(),
  hasPat: z.boolean(),
  identityName: z.string().nullable().optional(),
  orgUrl: z.string(),
  project: z.string(),
  defaultPlanId: z.number().int().nullable().optional(),
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

export const DraftBugSchema = z.object({
  title: z.string().min(1),
  reproSteps: z.string(),
  severity: z.enum(["1 - Critical", "2 - High", "3 - Medium", "4 - Low"]),
});
export type DraftBug = z.infer<typeof DraftBugSchema>;

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

// --- Staleness ---

export const StaleCaseInfoSchema = z.object({
  caseId: z.number().int(),
  reason: z.string(),
  changedFiles: z.array(z.string()),
  commitCount: z.number().int(),
});
export type StaleCaseInfo = z.infer<typeof StaleCaseInfoSchema>;

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

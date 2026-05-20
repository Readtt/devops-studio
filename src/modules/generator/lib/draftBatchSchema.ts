import { z } from "zod";

export const TestStepDraftSchema = z.object({
  action: z.string().min(1),
  expected: z.string().min(1),
});

export const DraftSourceLinkSchema = z.object({
  /** Repo display name (matches what the user attached). */
  repoName: z.string(),
  /** Optional repo id; if absent we fall back to repoName for the index. */
  repoId: z.string().nullable().optional(),
  filePath: z.string(),
  symbol: z.string().nullable().optional(),
  lineRange: z
    .object({ start: z.number().int(), end: z.number().int() })
    .nullable()
    .optional(),
});
export type DraftSourceLink = z.infer<typeof DraftSourceLinkSchema>;

export const DraftCaseLLMSchema = z.object({
  title: z.string().min(8).max(160),
  description: z.string().default(""),
  steps: z.array(TestStepDraftSchema).min(1).max(12),
  tags: z.array(z.string()).default([]),
  areaPath: z.string().nullable().optional(),
  iterationPath: z.string().nullable().optional(),
  rationale: z.string().default(""),
  /** Links to attached source files. The publisher persists these in the
   *  description's source-links block (Phase 7). */
  sourceLinks: z.array(DraftSourceLinkSchema).default([]),
});

export const DraftBugLLMSchema = z.object({
  title: z.string().min(8).max(160),
  reproSteps: z.string().min(1),
  severity: z.enum(["1 - Critical", "2 - High", "3 - Medium", "4 - Low"]),
  /** Index into DraftBatch.cases that this bug attaches to, if any. */
  linkedDraftCaseIndex: z.number().int().nonnegative().nullable().optional(),
});

export const DraftBatchLLMSchema = z.object({
  cases: z.array(DraftCaseLLMSchema).default([]),
  bugs: z.array(DraftBugLLMSchema).default([]),
});

export type TestStepDraft = z.infer<typeof TestStepDraftSchema>;
export type DraftCaseLLM = z.infer<typeof DraftCaseLLMSchema>;
export type DraftBugLLM = z.infer<typeof DraftBugLLMSchema>;
export type DraftBatchLLM = z.infer<typeof DraftBatchLLMSchema>;

export type SimilarMatch = {
  caseId: number;
  title: string;
  score: number;
};

/** Per-case UI state in the review phase. */
export type ReviewedCase = DraftCaseLLM & {
  /** Stable id within this session. */
  uid: string;
  /** Inclusion decision from the reviewer. */
  decision: "keep" | "skip";
  /** Existing cases with high title similarity (Jaro-Winkler ≥ 0.85). */
  similarMatches: SimilarMatch[];
};

export type ReviewedBug = DraftBugLLM & {
  uid: string;
  decision: "keep" | "skip";
};

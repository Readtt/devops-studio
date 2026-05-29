import { z } from "zod";
import type { ExecutionOutcome } from "@/modules/ado";
import type { ConfidenceVerdict } from "@/modules/test-plans/lib/confidence";

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

/** Code anchor a bug-suggestion model can emit when it grounded the bug in
 *  actual source. Mirrors the existing CodeLink shape used by cases so the
 *  publish path can format both through the shared HTML emitter. */
export const DraftBugCodeRefSchema = z.object({
  /** Path relative to the user's source directory. */
  file: z.string().min(1),
  startLine: z.number().int().nonnegative(),
  endLine: z.number().int().nonnegative().nullable().optional(),
  /** Optional human-readable anchor inside the file, e.g. "LoginController.Authenticate". */
  symbol: z.string().nullable().optional(),
});
export type DraftBugCodeRef = z.infer<typeof DraftBugCodeRefSchema>;

export const DraftBugLLMSchema = z.object({
  title: z.string().min(8).max(160),
  reproSteps: z.string().min(1),
  severity: z.enum(["1 - Critical", "2 - High", "3 - Medium", "4 - Low"]),
  /** Index into DraftBatch.cases that this bug attaches to, if any. */
  linkedDraftCaseIndex: z.number().int().nonnegative().nullable().optional(),
  /** Source anchors the analyst found while investigating. Embedded as a
   *  parseable HTML comment block on the published bug's reproSteps so the
   *  client can later render them as clickable code-viewer chips. */
  codeRefs: z.array(DraftBugCodeRefSchema).default([]),
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
  /** Run outcome the reviewer picked for this case. Recorded against the
   *  case's test point right after publish. Excludes "Active" — undefined
   *  means "leave unset / not run". */
  desiredOutcome?: Exclude<ExecutionOutcome, "Active">;
  /** AI confidence verdict for this draft case. Persists in the draft payload
   *  so it survives reopening a run from generation history. */
  verdict?: ConfidenceVerdict;
};

export type ReviewedBug = DraftBugLLM & {
  uid: string;
  decision: "keep" | "skip";
};

/** Pull the JSON object out of a model response that may be fenced or wrapped
 *  in prose. Shared by both run engines (Vercel + Claude CLI). */
export function extractBatchJson(s: string): string {
  // Strip a ```json … ``` fence if present.
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) return fence[1].trim();
  // Otherwise take from the first { to the last } if there's surrounding prose.
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first >= 0 && last > first) return s.slice(first, last + 1);
  return s;
}

/** Parse a model batch response into a validated DraftBatch. Permissive by
 *  design — an unparseable/invalid response yields an empty batch rather than
 *  crashing the review UI — but it now logs the failure so "the model
 *  generated nothing" can be distinguished from "the model returned malformed
 *  JSON" when debugging. */
export function parseDraftBatch(text: string): DraftBatchLLM {
  const candidate = extractBatchJson(text.trim());
  try {
    return DraftBatchLLMSchema.parse(JSON.parse(candidate));
  } catch (e) {
    console.warn("[generator] could not parse model batch response:", e);
    return { cases: [], bugs: [] };
  }
}

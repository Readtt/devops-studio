// Confidence verdict — the AI's calibrated prediction of whether a test case
// would PASS when run against the current source, produced by reading the code
// and tracing each step. NOT a real test run: it's a grounded prediction, so
// the rubric (in confidenceEvalPrompt) forces per-step code evidence and an
// explicit "Unknown" when the code path can't be located.
//
// Threshold semantics (the QA workflow): >= 90 confidence on a Pass marks the
// case an auto-pass candidate; anything below is flagged for manual testing.

import { z } from "zod";

export const AUTO_PASS_THRESHOLD = 90;

export type PredictedOutcome = "Pass" | "Fail" | "Blocked" | "Unknown";

/** One traced step's finding. `ref` is the file:line the step was verified
 *  against (null when the step couldn't be grounded in code — which caps
 *  confidence per the rubric). */
export const EvidenceItemSchema = z.object({
  step: z.number().int().nonnegative(),
  finding: z.string(),
  ref: z.string().nullable().default(null),
});
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;

/** The portion of the verdict the MODEL emits (strict JSON). The runner adds
 *  evaluatedAt / modelId / runs around it. */
export const ConfidenceVerdictLLMSchema = z.object({
  predictedOutcome: z.enum(["Pass", "Fail", "Blocked", "Unknown"]),
  confidence: z.number().min(0).max(100),
  evidence: z.array(EvidenceItemSchema).default([]),
  reasoning: z.string().default(""),
  caveats: z.array(z.string()).default([]),
});
export type ConfidenceVerdictLLM = z.infer<typeof ConfidenceVerdictLLMSchema>;

/** Full persisted verdict. */
export type ConfidenceVerdict = ConfidenceVerdictLLM & {
  /** ISO-8601 timestamp the verdict was produced. */
  evaluatedAt: string;
  /** Model that produced it (for provenance + "re-evaluate on a better model"). */
  modelId: string;
  /** Number of self-consistency runs that fed this verdict (1 = single pass). */
  runs?: number;
};

/** Color grammar for the confidence chip — reuses the OUTCOME_CHIP tints so it
 *  sits consistently next to the Passed/Failed/Blocked chips. */
export function confidenceTone(confidence: number): {
  className: string;
  band: "high" | "medium" | "low";
} {
  if (confidence >= AUTO_PASS_THRESHOLD) {
    return {
      className: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
      band: "high",
    };
  }
  if (confidence >= 60) {
    return {
      className: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
      band: "medium",
    };
  }
  return {
    className: "bg-rose-500/15 text-rose-600 dark:text-rose-300",
    band: "low",
  };
}

/** Whether this verdict qualifies the case for a one-click auto-pass: a Pass
 *  prediction at or above the threshold. Everything else needs manual testing. */
export function isAutoPassCandidate(v: ConfidenceVerdict | null | undefined): boolean {
  return !!v && v.predictedOutcome === "Pass" && v.confidence >= AUTO_PASS_THRESHOLD;
}

/** Parse a model response into a verdict (permissive — strips fences/preamble).
 *  Returns null when nothing valid was found so the caller can surface an
 *  honest "couldn't evaluate" instead of a fabricated score. */
export function parseConfidenceVerdict(text: string): ConfidenceVerdictLLM | null {
  const candidate = extractJson(text.trim());
  try {
    return ConfidenceVerdictLLMSchema.parse(JSON.parse(candidate));
  } catch {
    return null;
  }
}

function extractJson(s: string): string {
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) return fence[1].trim();
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first >= 0 && last > first) return s.slice(first, last + 1);
  return s;
}

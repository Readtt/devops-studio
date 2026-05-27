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

/** Pass-readiness — a single 0–100 "how safe is it to just mark this case
 *  Passed?" score. This is the number the chip surfaces, so QA reads one axis:
 *  high = green = click Pass, low = red = go test it. Derived from the model's
 *  prediction: a confident Pass scores high (its confidence); a confident Fail
 *  or Blocked scores low (the inverse — 94%-confident Fail → 6% pass-ready).
 *  Unknown has no honest score, so it returns null and the chip renders a
 *  neutral "?". The detail panel still shows the raw predicted outcome +
 *  confidence behind this number. */
export function passReadiness(v: {
  predictedOutcome: PredictedOutcome;
  confidence: number;
}): number | null {
  switch (v.predictedOutcome) {
    case "Pass":
      return clampPct(v.confidence);
    case "Fail":
    case "Blocked":
      return clampPct(100 - v.confidence);
    case "Unknown":
    default:
      return null;
  }
}

/** Color grammar for the pass-readiness chip. Green only when an actual Pass
 *  clears the auto-pass bar — a Fail's inverse score can never read as "safe to
 *  pass", even when it's high (a barely-confident Fail is "verify", not "pass").
 *  Amber = "probably, verify first"; red = "likely fails, go test"; grey =
 *  Unknown. */
export function readinessTone(
  readiness: number | null,
  outcome: PredictedOutcome,
): { className: string } {
  if (readiness === null || outcome === "Unknown") {
    return { className: "bg-foreground/[0.08] text-muted-foreground" };
  }
  if (outcome === "Pass" && readiness >= AUTO_PASS_THRESHOLD) {
    return {
      className: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
    };
  }
  if (readiness >= 60) {
    return { className: "bg-amber-500/15 text-amber-700 dark:text-amber-300" };
  }
  return { className: "bg-rose-500/15 text-rose-600 dark:text-rose-300" };
}

function clampPct(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
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

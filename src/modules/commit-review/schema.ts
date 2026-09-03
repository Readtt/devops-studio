// Schemas for the two-stage Commit Review engine.
//
//   Stage 1 (Investigate) → CandidateFinding[]  (evidence-grounded)
//   Stage 2 (Verify)       → Verdict[]            (skeptical refutation)
//   merged                 → Finding[]            (what the UI renders)
//
// suggestedFix reuses PatchSchema so ApplyPatchCard consumes it unchanged.

import { z } from "zod";
import { completeItemsOfTruncatedArray } from "@/modules/ai/lib/extractJson";
import { PatchSchema } from "./patchSchema";

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export const CONFIDENCES = ["high", "medium", "low"] as const;
export const CATEGORIES = [
  "security",
  "performance",
  "correctness",
  "requirements",
  "maintainability",
] as const;

export const SeveritySchema = z.enum(SEVERITIES);
export const ConfidenceSchema = z.enum(CONFIDENCES);
export const CategorySchema = z.enum(CATEGORIES);

export type Severity = (typeof SEVERITIES)[number];
export type Confidence = (typeof CONFIDENCES)[number];
export type Category = (typeof CATEGORIES)[number];

/** Sort weight so the UI can group Critical → Low deterministically. */
export const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export const CONFIDENCE_RANK: Record<Confidence, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

// ---- Stage 1: candidate findings ------------------------------------------

export const CandidateFindingSchema = z.object({
  /** Model-minted stable id so Stage 2 verdicts can join back. */
  id: z.string().min(1),
  title: z.string().min(1),
  category: CategorySchema,
  severity: SeveritySchema,
  /** Full path relative to the source root (matches Read/Grep + the diff). */
  file: z.string().min(1),
  startLine: z.number().int().nonnegative(),
  endLine: z.number().int().nonnegative(),
  /** 1–2 short paragraphs: the change and its failure, then the blast radius
   *  (shape mandated by FINDING_WRITING_RULES in commitReviewPrompts). */
  explanation: z.string().min(1),
  /** The checks that ground this finding, as "<repo>/<path>:<line> — what it
   *  showed" lines (semi-formal reasoning; same contract). */
  evidence: z.string().default(""),
  /** Numbered steps that reach the failure, traced from the code (contract in
   *  FINDING_WRITING_RULES). `.optional()`, never `.default("")`: a default
   *  makes the field REQUIRED on the inferred output type, which would break
   *  every `: CandidateFinding` fixture under tsc while vitest stayed green. */
  reproSteps: z.string().optional(),
  confidence: ConfidenceSchema,
  /** A one-spot fix, when the model is confident in it.
   *  `.catch(null)` so a single malformed embedded patch (e.g. the model emits
   *  startLine:0) degrades to no-fix instead of failing the whole batch parse
   *  and discarding every other finding. */
  suggestedFix: PatchSchema.nullable().catch(null).optional(),
  /** Requirements-conformance findings only. `unclear` when there's no concrete
   *  contradiction — never speculate intent gaps. */
  requirementStatus: z
    .enum(["violated", "satisfied", "unclear"])
    .nullable()
    .optional(),
});

export const Stage1Schema = z.object({
  findings: z.array(CandidateFindingSchema).default([]),
  /** Optional decomposition of the provided requirements, for transparency. */
  criteria: z
    .array(
      z.object({
        text: z.string(),
        status: z.enum(["met", "unmet", "unclear"]),
      }),
    )
    .optional(),
});

export type CandidateFinding = z.infer<typeof CandidateFindingSchema>;
export type Stage1 = z.infer<typeof Stage1Schema>;

/** Salvage the complete, individually-valid findings out of a Stage 1 answer
 *  that failed whole-batch validation — cut off mid-structure by an output cap
 *  (`finish: length`), or parseable but with some malformed elements. Same
 *  partial-batch acceptance the generator applies to cases/bugs: findings are
 *  independent items, and the ones that arrived intact are real work. The
 *  verify pass exists to skeptically filter candidates, so a salvaged partial
 *  set feeds it exactly what it was built for. Never throws; [] when nothing
 *  survives. */
export function salvageCandidateFindings(text: string): CandidateFinding[] {
  const out: CandidateFinding[] = [];
  for (const item of completeItemsOfTruncatedArray(text, "findings")) {
    const r = CandidateFindingSchema.safeParse(item);
    if (r.success) out.push(r.data);
  }
  return out;
}

// ---- Stage 2: verdicts -----------------------------------------------------

export const VerdictSchema = z.object({
  /** Matches a Stage 1 finding id. */
  id: z.string().min(1),
  verdict: z.enum(["confirmed", "refuted", "uncertain"]),
  finalSeverity: SeveritySchema.optional(),
  finalConfidence: ConfidenceSchema.optional(),
  /** What the verifier tried to disprove it with (kept for the UI/debugging). */
  refutationAttempt: z.string().default(""),
  /** Verifier may tighten or null out the fix. `.catch(null)` so a malformed
   *  embedded patch degrades to no-fix instead of nuking the whole verdict
   *  batch parse. */
  suggestedFix: PatchSchema.nullable().catch(null).optional(),
});

export const Stage2Schema = z.object({
  verdicts: z.array(VerdictSchema).default([]),
});

export type Verdict = z.infer<typeof VerdictSchema>;
export type Stage2 = z.infer<typeof Stage2Schema>;

// ---- Merged finding (what gets persisted + rendered) ----------------------

export type Finding = CandidateFinding & {
  /** True once Stage 2 confirmed it (vs. carried through as "uncertain"). */
  verified?: boolean;
};

/** Stable comparator: severity first, then confidence, then title. */
export function compareFindings(a: Finding, b: Finding): number {
  const s = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (s !== 0) return s;
  const c = CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence];
  if (c !== 0) return c;
  return a.title.localeCompare(b.title);
}

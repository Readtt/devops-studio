// Confidence verdict — the AI's calibrated prediction of whether a test case
// would PASS when run against the current source, produced by reading the code
// and tracing each step. NOT a real test run: it's a grounded prediction, so
// the rubric (in confidenceEvalPrompt) forces per-step code evidence and an
// explicit "Unknown" when the code path can't be located.
//
// The model reasons in PASS terms directly: it emits `passLikelihood` (0-100 =
// "how likely a tester sees every Expected Result right now") plus a categorical
// `predictedOutcome`. We do NOT ask for fail-confidence and invert it — the
// number the model produces is the number the chip shows.
//
// Threshold semantics (the QA workflow): a Pass with passLikelihood >= 90 marks
// the case an auto-pass candidate; anything below is flagged for manual testing.

import { z } from "zod";
import { extractJsonBlock } from "@/modules/ai/lib/extractJson";

export const AUTO_PASS_THRESHOLD = 90;

export type PredictedOutcome = "Pass" | "Fail" | "Blocked" | "Unknown";

/** One traced step's finding. `ref` is the file:line the step was verified
 *  against (null when the step couldn't be grounded in code — which caps
 *  pass-likelihood per the rubric). */
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
  /** Direct probability (0-100) the case passes against current code. */
  passLikelihood: z.number().min(0).max(100),
  evidence: z.array(EvidenceItemSchema).default([]),
  reasoning: z.string().default(""),
  caveats: z.array(z.string()).default([]),
});
export type ConfidenceVerdictLLM = z.infer<typeof ConfidenceVerdictLLMSchema>;

/** Pre-pass-likelihood shape: the model used to emit `confidence` (confidence
 *  IN the predicted outcome — high for a confident Fail) which we inverted. We
 *  still read it so verdicts stored before the reframe keep rendering. */
const LegacyVerdictLLMSchema = z.object({
  predictedOutcome: z.enum(["Pass", "Fail", "Blocked", "Unknown"]),
  confidence: z.number().min(0).max(100),
  evidence: z.array(EvidenceItemSchema).default([]),
  reasoning: z.string().default(""),
  caveats: z.array(z.string()).default([]),
});

/** One repo's source state at evaluation time. A verdict graded across three
 *  repos carries three of these — comparing all of them against one repo's HEAD
 *  is how a verdict reads as permanently stale for the wrong reason. */
export type VerdictSource = {
  repoId: string;
  repoName: string;
  /** Branch at evaluation time. Provenance/display only — staleness is decided
   *  by {@link VerdictSource.sha} (the same branch moves). */
  branch: string | null;
  /** Short HEAD sha. Null when the repo wasn't readable at eval time. */
  sha: string | null;
};

/** Full persisted verdict. */
export type ConfidenceVerdict = ConfidenceVerdictLLM & {
  /** ISO-8601 timestamp the verdict was produced. */
  evaluatedAt: string;
  /** Model that produced it (for provenance + "re-evaluate on a better model"). */
  modelId: string;
  /** Number of self-consistency runs that fed this verdict (1 = single pass). */
  runs?: number;
  /** Source state of every repo the grader could read, so the UI can flag the
   *  verdict stale once any of them moves past it — a branch switch or new
   *  commits — instead of showing a guess as if it still reflects the code.
   *  Empty/absent when code search was off or no repo was readable; the
   *  staleness check degrades to "unknown" then. */
  sources?: VerdictSource[];
  /** @deprecated Single-repo stamp from verdicts saved before the workspace
   *  held more than one. Still READ (as the first repo's, which is what it
   *  was) so old verdicts keep their staleness hint; never written. */
  sourceSha?: string | null;
  /** @deprecated Companion of {@link sourceSha}. */
  sourceBranch?: string | null;
  /** @deprecated Legacy confidence-in-outcome from verdicts produced before the
   *  pass-likelihood reframe. Absent on new verdicts; read only as a fallback by
   *  {@link passReadiness}. */
  confidence?: number;
};

/** Live HEAD of one configured repo, for the staleness comparison. */
export type CurrentSource = {
  repoId: string;
  repoName: string;
  sha: string | null;
};

/** One repo's stamp lined up against its own live HEAD. */
export type ComparedSource = {
  repoName: string;
  branch: string | null;
  evaluatedSha: string;
  currentSha: string;
};

/** How a stored verdict relates to the CURRENT source, for the panel's
 *  staleness hint:
 *  - `fresh`   — every repo it was graded against is where it was.
 *  - `stale`   — at least one of them moved (branch switch / new commits); the
 *                verdict may no longer reflect reality, so prompt a re-evaluate.
 *  - `unknown` — nothing to compare (no source stamp, or no live commit for any
 *                stamped repo — non-repo, removed from the workspace, or code
 *                search was off). */
export type VerdictSourceState =
  | { kind: "fresh"; repos: ComparedSource[] }
  | { kind: "stale"; moved: ComparedSource[] }
  | { kind: "unknown" };

/**
 * Stale iff ANY repo the verdict was graded against has moved. Each stamp is
 * compared to its OWN repo's live HEAD — a verdict scored against repo-one and
 * compared to repo-two's HEAD would read as stale forever.
 *
 * Repos that can't be compared (no stamp, or no live sha) drop out rather than
 * counting as moved: an unreadable repo is unknown, not changed.
 */
export function verdictSourceState(
  verdict: {
    sources?: VerdictSource[] | null;
    sourceSha?: string | null;
    sourceBranch?: string | null;
  },
  current: CurrentSource[],
): VerdictSourceState {
  const compared: ComparedSource[] = [];
  for (const rec of recordedSources(verdict, current)) {
    const evaluatedSha = (rec.sha ?? "").trim();
    if (!evaluatedSha) continue;
    const live = current.find((c) => c.repoId === rec.repoId);
    const currentSha = (live?.sha ?? "").trim();
    if (!currentSha) continue;
    compared.push({
      repoName: rec.repoName,
      branch: rec.branch,
      evaluatedSha,
      currentSha,
    });
  }
  if (compared.length === 0) return { kind: "unknown" };
  // Compare on a 7-char prefix — defensive against differing abbreviation
  // lengths, mirroring the commit-review head-moved check.
  const moved = compared.filter(
    (c) => c.evaluatedSha.slice(0, 7) !== c.currentSha.slice(0, 7),
  );
  return moved.length > 0
    ? { kind: "stale", moved }
    : { kind: "fresh", repos: compared };
}

/** What the verdict recorded. A pre-multi-repo verdict has a bare sha and no
 *  repo — it was graded against the one source dir, which is the first repo, so
 *  that's what it's compared against. Not migrated: the scalar stays on disk
 *  exactly as written. */
function recordedSources(
  verdict: {
    sources?: VerdictSource[] | null;
    sourceSha?: string | null;
    sourceBranch?: string | null;
  },
  current: CurrentSource[],
): VerdictSource[] {
  if (verdict.sources && verdict.sources.length > 0) return verdict.sources;
  const legacy = (verdict.sourceSha ?? "").trim();
  if (!legacy || current.length === 0) return [];
  return [
    {
      repoId: current[0].repoId,
      repoName: current[0].repoName,
      branch: verdict.sourceBranch ?? null,
      sha: legacy,
    },
  ];
}

/** Pass-readiness — the single 0–100 "how safe is it to just mark this case
 *  Passed?" score the chip surfaces, so QA reads one axis: high = green = click
 *  Pass, low = red = go test it. For new verdicts this is just the model's
 *  `passLikelihood` (it already reasons in pass terms). Unknown has no honest
 *  score, so it returns null and the chip renders a neutral "?".
 *
 *  Back-compat: a legacy verdict carries `confidence` (confidence in the
 *  outcome) instead — derive the same way the old code did so stored verdicts
 *  still render (94%-confident Fail → 6% pass-ready). */
export function passReadiness(v: {
  predictedOutcome: PredictedOutcome;
  passLikelihood?: number;
  confidence?: number;
}): number | null {
  if (v.predictedOutcome === "Unknown") return null;
  if (typeof v.passLikelihood === "number") return clampPct(v.passLikelihood);
  if (typeof v.confidence === "number") {
    return clampPct(
      v.predictedOutcome === "Pass" ? v.confidence : 100 - v.confidence,
    );
  }
  return null;
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
  if (!v || v.predictedOutcome !== "Pass") return false;
  const r = passReadiness(v);
  return r !== null && r >= AUTO_PASS_THRESHOLD;
}

/** Parse a model response into a verdict (permissive — strips fences/preamble).
 *  Accepts the current pass-likelihood shape and the legacy confidence shape
 *  (deriving passLikelihood from it). Returns null when nothing valid was found
 *  so the caller can surface an honest "couldn't evaluate" instead of a
 *  fabricated score. */
export function parseConfidenceVerdict(text: string): ConfidenceVerdictLLM | null {
  const candidate = extractJsonBlock(text.trim());
  let obj: unknown;
  try {
    obj = JSON.parse(candidate);
  } catch {
    return null;
  }
  const direct = ConfidenceVerdictLLMSchema.safeParse(obj);
  if (direct.success) return direct.data;
  const legacy = LegacyVerdictLLMSchema.safeParse(obj);
  if (legacy.success) {
    const d = legacy.data;
    const pl =
      d.predictedOutcome === "Unknown"
        ? 0
        : d.predictedOutcome === "Pass"
          ? d.confidence
          : 100 - d.confidence;
    return {
      predictedOutcome: d.predictedOutcome,
      passLikelihood: clampPct(pl),
      evidence: d.evidence,
      reasoning: d.reasoning,
      caveats: d.caveats,
    };
  }
  return null;
}

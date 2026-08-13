// Agentic confidence evaluation for ONE test case. The file tools are what
// make the prediction code-grounded rather than a guess.
//
// Reliability lever: `runs` > 1 evaluates N times and only allows a high final
// confidence when the runs agree (self-consistency). It is also a straight cost
// multiplier — see MAX_SELF_CONSISTENCY_RUNS.
//
// This is the surface bulk suite scoring calls once PER CASE, which makes it the
// app's dominant cost path and the one place the prompt-cache split below is
// worth the extra structure.

import {
  SURFACE_STEP_CAPS,
  SURFACE_TOKEN_BUDGETS,
  type ModelId,
} from "@/modules/ai/config";
import { type ProviderKeys } from "@/modules/ai/lib/keyring";
import { runTask } from "@/modules/ai/lib/taskRunner";
import type { LocalProviderConfig } from "@/modules/ai/lib/agent";
import { buildSuiteChatTools } from "./suiteChatTools";
import { renderRepoRoster } from "@/modules/ai/lib/repoPaths";
import type { WorkspaceRepo } from "@/modules/settings/store";
import {
  formatContextBlocks,
  type ContextBlock,
} from "@/modules/ai/lib/contextBlocks";
import { CONFIDENCE_EVAL_SYSTEM_PROMPT } from "./confidenceEvalPrompt";
import {
  AUTO_PASS_THRESHOLD,
  ConfidenceVerdictLLMSchema,
  parseConfidenceVerdict,
  type ConfidenceVerdict,
  type ConfidenceVerdictLLM,
  type PredictedOutcome,
  type VerdictSource,
} from "./confidence";
import {
  renderRequirementBlock,
  type TargetRequirement,
  type TestCase,
} from "@/modules/ado";

/** Just the case fields the evaluator needs — accepts a full ADO TestCase or a
 *  lighter draft shape (the generator review phase). */
export type EvalCase = {
  id?: number | null;
  title: string;
  description?: string;
  steps: { index?: number; action: string; expected: string }[];
};

export type ConfidenceEvalInput = {
  testCase: EvalCase;
  /** Source repos the grader may read. Empty ⇒ nothing to ground against. */
  repos: WorkspaceRepo[];
  /** Branch + HEAD sha of each repo the grader can read, at eval time — stamped
   *  onto the verdict so the UI can flag it stale once any of them moves.
   *  Empty when nothing was readable / code search is off. */
  sources?: VerdictSource[];
  modelId: ModelId;
  keys: ProviderKeys;
  local?: LocalProviderConfig;
  /** Self-consistency runs. DEFAULT 1, and every live call site leaves it there
   *  — see {@link MAX_SELF_CONSISTENCY_RUNS}. Raising it multiplies this case's
   *  entire cost by N, so it is an explicit per-call opt-in rather than a
   *  setting. >1 requires agreement between the runs for a high score. */
  runs?: number;
  /** Best-practices / extra context blocks to apply during evaluation. */
  contextBlocks?: ContextBlock[];
  /** User's freeform "Custom instructions" from Settings — appended to the
   *  system prompt on every surface. Empty/absent ⇒ base prompt unchanged. */
  customInstructions?: string;
  /** The work item this case's suite tracks, when it sits in a
   *  requirement-based suite. A verdict that ignores the acceptance criteria
   *  the case was written against is grading it on the wrong rubric — this is
   *  the same block the generator and Suite Chat render, just capped tighter
   *  because confidence runs once PER CASE and a bulk suite run pays for it
   *  every time. */
  requirement?: TargetRequirement | null;
  /** Tracked work-item id, which survives a failed `requirement` fetch. */
  requirementId?: number | null;
  /** Cooperative cancel. Aborts the model run and makes evaluateConfidence
   *  reject with an AbortError. */
  signal?: AbortSignal;
};

/** Per-field cap for the requirement block on this surface. Deliberately far
 *  below the generator's 4000: one bulk run multiplies it by the case count. */
const CONFIDENCE_REQUIREMENT_CHARS = 1200;

/** Ceiling on self-consistency runs, and the reason `runs` defaults to 1.
 *
 *  `runs` is a straight COST MULTIPLIER on the app's most expensive path: one
 *  case at `runs: 5` is five complete agentic evaluations, each re-reading the
 *  code from scratch, and bulk suite scoring multiplies that by the case count
 *  again — 50 cases × 5 runs × an 18-step ceiling is ~4,500 model calls for one
 *  click. Nothing else in the app is within an order of magnitude.
 *
 *  So it is opt-in per call and no surface opts in: every live call site passes
 *  1 (explicitly in `runSuiteConfidence`, by default everywhere else) and
 *  runConfidenceEval.runs.test.ts pins that. A caller that genuinely wants
 *  self-consistency has to ask for it and, in asking, take responsibility for
 *  multiplying its own spend. */
export const MAX_SELF_CONSISTENCY_RUNS = 5;

export function fromTestCase(tc: TestCase): EvalCase {
  return {
    id: tc.id,
    title: tc.title,
    steps: tc.steps.map((s) => ({
      index: s.index,
      action: s.action,
      expected: s.expected,
    })),
  };
}

/** Evaluate a case; returns a full verdict (with provenance). Runs N times and
 *  aggregates when `runs` > 1. */
export async function evaluateConfidence(
  input: ConfidenceEvalInput,
): Promise<ConfidenceVerdict> {
  const runs = Math.max(1, Math.min(MAX_SELF_CONSISTENCY_RUNS, input.runs ?? 1));
  // Built once, then reused verbatim by every self-consistency run — same
  // reason the split exists at all. Rebuilding per run would be byte-identical
  // today and one careless timestamp away from not being.
  const system = buildEvalSystem(input);
  const prompt = buildEvalPrompt(input);

  const verdicts: ConfidenceVerdictLLM[] = [];
  for (let i = 0; i < runs; i++) {
    if (input.signal?.aborted) throw abortError();
    const v = await runConfidenceOnce(input, system, prompt);
    if (v) verdicts.push(v);
  }
  if (input.signal?.aborted) throw abortError();

  const aggregated = withSafetyCaveats(aggregate(verdicts));
  return {
    ...aggregated,
    evaluatedAt: new Date().toISOString(),
    modelId: input.modelId,
    runs,
    // Provenance: the source state this verdict was graded against, per repo,
    // so the UI can flag it stale once any of them moves past it. The legacy
    // scalar stamp is deliberately NOT written alongside — one verdict, one
    // record of what it read.
    sources: input.sources ?? [],
  };
}

/** Non-blocking safety caveats layered on the final (aggregated) verdict. A
 *  high pass-likelihood that leans on a step the model couldn't ground in code
 *  (a null evidence ref) is exactly the case a tester should still run by hand
 *  — say so explicitly rather than letting the green chip imply "safe to pass".
 *  (Evidence-ref line-bounds verification against the actual files is deferred;
 *  it overlaps the code-review post-hoc citation check.) */
export function withSafetyCaveats(
  v: ConfidenceVerdictLLM,
): ConfidenceVerdictLLM {
  if (
    v.predictedOutcome !== "Pass" ||
    v.passLikelihood < AUTO_PASS_THRESHOLD
  ) {
    return v;
  }
  const hasUngroundedStep = v.evidence.some((e) => e.ref == null);
  if (!hasUngroundedStep) return v;
  const caveat =
    "High confidence, but at least one step isn't grounded in code — manual test recommended.";
  if (v.caveats.includes(caveat)) return v;
  return { ...v, caveats: [caveat, ...v.caveats] };
}

// --- Aggregation ------------------------------------------------------------

const UNEVALUABLE: ConfidenceVerdictLLM = {
  predictedOutcome: "Unknown",
  passLikelihood: 0,
  evidence: [],
  reasoning: "The model did not return a usable verdict.",
  caveats: ["Evaluation failed to produce structured output."],
};

/** Combine N single-run verdicts into one. Single run → passthrough. Multiple
 *  → require agreement before trusting a high pass-likelihood: the final score
 *  is only allowed to stay >= 90 when every run agreed on the outcome. Any
 *  disagreement downgrades the pass-likelihood and records it in caveats —
 *  that's the whole point of self-consistency. */
export function aggregate(verdicts: ConfidenceVerdictLLM[]): ConfidenceVerdictLLM {
  if (verdicts.length === 0) return UNEVALUABLE;
  if (verdicts.length === 1) return verdicts[0];

  // Tally outcomes.
  const counts = new Map<PredictedOutcome, number>();
  for (const v of verdicts) {
    counts.set(v.predictedOutcome, (counts.get(v.predictedOutcome) ?? 0) + 1);
  }
  let majority: PredictedOutcome = "Unknown";
  let majorityCount = 0;
  for (const [outcome, n] of counts) {
    if (n > majorityCount) {
      majority = outcome;
      majorityCount = n;
    }
  }
  const total = verdicts.length;
  const agreeing = verdicts.filter((v) => v.predictedOutcome === majority);
  const unanimous = majorityCount === total;
  const supermajority = majorityCount / total >= 2 / 3;

  // Pick the richest agreeing run as the evidence/reasoning carrier.
  const lead = agreeing.reduce((a, b) =>
    b.evidence.length > a.evidence.length ? b : a,
  );
  const avgPassLikelihood = Math.round(
    agreeing.reduce((s, v) => s + v.passLikelihood, 0) / agreeing.length,
  );

  const caveats = [...new Set(agreeing.flatMap((v) => v.caveats))];

  if (!supermajority) {
    // Genuine disagreement — refuse a confident answer.
    caveats.unshift(
      `Self-consistency: only ${majorityCount}/${total} runs agreed (${[...counts]
        .map(([o, n]) => `${o}×${n}`)
        .join(", ")}). Downgraded — needs manual testing.`,
    );
    return {
      predictedOutcome: majority,
      passLikelihood: Math.min(avgPassLikelihood, 45),
      evidence: lead.evidence,
      reasoning: lead.reasoning,
      caveats,
    };
  }

  if (!unanimous) {
    caveats.unshift(
      `Self-consistency: ${majorityCount}/${total} runs agreed on ${majority}; capped below auto-pass.`,
    );
  }

  return {
    predictedOutcome: majority,
    // Only unanimous agreement may keep a >= 90 score; a split caps at 89.
    passLikelihood: unanimous
      ? avgPassLikelihood
      : Math.min(avgPassLikelihood, 89),
    evidence: lead.evidence,
    reasoning: lead.reasoning,
    caveats,
  };
}

// --- Single run -------------------------------------------------------------

async function runConfidenceOnce(
  input: ConfidenceEvalInput,
  system: string,
  prompt: string,
): Promise<ConfidenceVerdictLLM | null> {
  const tools = buildSuiteChatTools(input.repos);
  // Schema-validated, temperature-0. With code-search tools the runner runs the
  // agentic loop (generateText) then validates the model's final text against
  // the schema; tool-less it uses generateObject. Either way the verdict shape
  // is enforced; on a validation miss we fall back to parseConfidenceVerdict.
  const r = await runTask({
    modelId: input.modelId,
    keys: input.keys,
    local: input.local ?? {},
    systemPrompt: system,
    customInstructions: input.customInstructions,
    prompt,
    temperature: 0,
    maxSteps: SURFACE_STEP_CAPS.confidence,
    tokenBudget: SURFACE_TOKEN_BUDGETS.confidence,
    schema: ConfidenceVerdictLLMSchema,
    tools: tools ?? null,
    signal: input.signal,
  });
  // On a validated object use it directly; otherwise fall back to the lenient
  // text parser (which also understands the legacy confidence shape).
  return r.ok ? r.object : parseConfidenceVerdict(r.text);
}

/** A DOMException the callers recognise as "user cancelled" (name === "AbortError"). */
function abortError(): Error {
  return new DOMException("Confidence evaluation cancelled", "AbortError");
}

// --- Prompt -----------------------------------------------------------------
//
// SPLIT AT THE PROMPT-CACHE BOUNDARY. This is the app's largest cost path by an
// order of magnitude: bulk suite scoring invokes a full agentic run once per
// case, so a 50-case suite pays for whatever sits in front of the case content
// fifty times over. Everything that does NOT vary per case therefore lives in
// the SYSTEM prompt, where the runner's existing cache breakpoint already sits
// (buildRequestPrompt tags the leading system message, and Anthropic orders the
// request tools -> system -> messages, so that one breakpoint covers the tool
// definitions too). The case itself is the entire user turn, strictly after it.
//
// The rule this has to keep: the system string must be BYTE-IDENTICAL across
// every case of a run. Anthropic matches a cached prefix, not a set of pieces —
// one per-case byte anywhere in front of the boundary and the whole prefix is
// re-billed at full price. The requirement, the source line, and the
// best-practice blocks all qualify: a bulk run resolves the requirement once
// before the loop and loads the standards files once, so all three are constant
// for the whole batch. See runConfidenceEval.cachePrefix.test.ts.

/** The shared, per-case-INVARIANT half of a confidence request: the surface's
 *  system prompt plus the grounding every case in a run is graded against.
 *  Exported for the test that pins its byte-stability. */
export function buildEvalSystem(input: ConfidenceEvalInput): string {
  const sourceLine =
    input.repos.length > 0
      ? `Source repos — use the file tools to trace each step:\n${renderRepoRoster(input.repos)}`
      : "No source repos are configured — you cannot ground this; return Unknown with low confidence.";
  const requirementBlock = renderRequirementBlock(input.requirement, {
    maxBodyChars: CONFIDENCE_REQUIREMENT_CHARS,
    unresolvedId: input.requirementId ?? null,
  });
  const ctx = formatContextBlocks(input.contextBlocks ?? []);
  return [
    CONFIDENCE_EVAL_SYSTEM_PROMPT,
    "",
    sourceLine,
    requirementBlock ? `\n${requirementBlock}` : null,
    ctx ? `\n${ctx}` : null,
  ]
    .filter((l): l is string => l !== null)
    .join("\n");
}

/** The per-case half: the thing being graded, and nothing else. Exported for
 *  tests — the requirement grounding is otherwise only observable through a
 *  live model call. */
export function buildEvalPrompt(input: ConfidenceEvalInput): string {
  const tc = input.testCase;
  const idPart = tc.id != null ? `#${tc.id} ` : "";
  const stepLines = tc.steps.map((s, i) => {
    const n = s.index ?? i + 1;
    return `${n}. ACTION: ${oneLine(s.action)}\n   EXPECTED: ${oneLine(s.expected)}`;
  });
  return [
    `TEST CASE ${idPart}— ${tc.title}`,
    tc.description ? `Description: ${oneLine(tc.description)}` : null,
    "",
    "STEPS:",
    ...stepLines,
    "",
    "Trace every step against the code and return ONLY the verdict JSON.",
  ]
    .filter((l): l is string => l !== null)
    .join("\n");
}

function oneLine(s: string, cap = 400): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > cap ? `${flat.slice(0, cap - 1)}…` : flat;
}

// Agentic confidence evaluation for ONE test case. The file tools are what
// make the prediction code-grounded rather than a guess.
//
// Reliability lever: `runs` > 1 evaluates N times and only allows a high final
// confidence when the runs agree (self-consistency).

import { SURFACE_STEP_CAPS, type ModelId } from "@/modules/ai/config";
import { type ProviderKeys } from "@/modules/ai/lib/keyring";
import { runTask } from "@/modules/ai/lib/taskRunner";
import type { LocalProviderConfig } from "@/modules/ai/lib/agent";
import { buildSuiteChatTools } from "./suiteChatTools";
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
} from "./confidence";
import type { TestCase } from "@/modules/ado";

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
  sourceRoot: string | null;
  modelId: ModelId;
  keys: ProviderKeys;
  local?: LocalProviderConfig;
  /** Self-consistency runs (default 1). >1 requires agreement for a high score. */
  runs?: number;
  /** Best-practices / extra context blocks to apply during evaluation. */
  contextBlocks?: ContextBlock[];
  /** Cooperative cancel. Aborts the model run and makes evaluateConfidence
   *  reject with an AbortError. */
  signal?: AbortSignal;
};

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
  const runs = Math.max(1, Math.min(5, input.runs ?? 1));
  const prompt = buildEvalPrompt(input);

  const verdicts: ConfidenceVerdictLLM[] = [];
  for (let i = 0; i < runs; i++) {
    if (input.signal?.aborted) throw abortError();
    const v = await runConfidenceOnce(input, prompt);
    if (v) verdicts.push(v);
  }
  if (input.signal?.aborted) throw abortError();

  const aggregated = withSafetyCaveats(aggregate(verdicts));
  return {
    ...aggregated,
    evaluatedAt: new Date().toISOString(),
    modelId: input.modelId,
    runs,
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
  prompt: string,
): Promise<ConfidenceVerdictLLM | null> {
  const tools = buildSuiteChatTools(input.sourceRoot);
  // Schema-validated, temperature-0. With code-search tools the runner uses
  // experimental_output; tool-less it uses generateObject — either way the
  // verdict shape is enforced.
  const r = await runTask({
    modelId: input.modelId,
    keys: input.keys,
    local: input.local ?? {},
    systemPrompt: CONFIDENCE_EVAL_SYSTEM_PROMPT,
    prompt,
    temperature: 0,
    maxSteps: SURFACE_STEP_CAPS.confidence,
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

function buildEvalPrompt(input: ConfidenceEvalInput): string {
  const tc = input.testCase;
  const idPart = tc.id != null ? `#${tc.id} ` : "";
  const sourceLine = input.sourceRoot
    ? `Source directory: ${input.sourceRoot} — use the file tools to trace each step.`
    : "No source directory is set — you cannot ground this; return Unknown with low confidence.";
  const stepLines = tc.steps.map((s, i) => {
    const n = s.index ?? i + 1;
    return `${n}. ACTION: ${oneLine(s.action)}\n   EXPECTED: ${oneLine(s.expected)}`;
  });
  const ctx = formatContextBlocks(input.contextBlocks ?? []);
  return [
    `TEST CASE ${idPart}— ${tc.title}`,
    tc.description ? `Description: ${oneLine(tc.description)}` : null,
    sourceLine,
    "",
    "STEPS:",
    ...stepLines,
    ctx ? `\n${ctx}` : null,
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

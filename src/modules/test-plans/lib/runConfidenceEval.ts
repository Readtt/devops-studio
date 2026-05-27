// Agentic confidence evaluation for ONE test case. Mirrors runSuiteChat's
// dual-engine shape (Vercel SDK for BYOK, Claude CLI for OAuth) — the file
// tools are what make the prediction code-grounded rather than a guess.
//
// Reliability lever: `runs` > 1 evaluates N times and only allows a high final
// confidence when the runs agree (self-consistency). The caller decides the
// engine (via selectEngine) and passes the resolved model + auth.

import { generateText, stepCountIs } from "ai";
import { getModel, type ModelId } from "@/modules/ai/config";
import { buildLanguageModel } from "@/modules/ai/lib/agent";
import { runClaudeQuery, cancelClaudeRun } from "@/modules/ai/lib/claude";
import type { ClaudeAuthMode } from "@/modules/ai/lib/engine";
import { getKey, type ProviderKeys } from "@/modules/ai/lib/keyring";
import { buildSuiteChatTools } from "./suiteChatTools";
import {
  formatContextBlocks,
  type ContextBlock,
} from "@/modules/ai/lib/contextBlocks";
import { CONFIDENCE_EVAL_SYSTEM_PROMPT } from "./confidenceEvalPrompt";
import {
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
  /** Already engine-resolved model id (resolveClaudeModelId applied for CLI). */
  modelId: ModelId;
  /** True ⇒ Claude CLI path; false ⇒ Vercel SDK path. */
  useClaude: boolean;
  keys: ProviderKeys;
  authMode: ClaudeAuthMode;
  bareMode?: boolean;
  lmstudioBaseURL?: string;
  /** Self-consistency runs (default 1). >1 requires agreement for a high score. */
  runs?: number;
  /** Best-practices / extra context blocks to apply during evaluation. */
  contextBlocks?: ContextBlock[];
  /** Cooperative cancel. Aborts the Vercel stream / cancels the Claude
   *  subprocess and makes evaluateConfidence reject with an AbortError. */
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
    const v = input.useClaude
      ? await runOnceClaude(input, prompt)
      : await runOnceVercel(input, prompt);
    if (v) verdicts.push(v);
  }
  if (input.signal?.aborted) throw abortError();

  const aggregated = aggregate(verdicts);
  return {
    ...aggregated,
    evaluatedAt: new Date().toISOString(),
    modelId: input.modelId,
    runs,
  };
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

// --- Engine paths -----------------------------------------------------------

async function runOnceVercel(
  input: ConfidenceEvalInput,
  prompt: string,
): Promise<ConfidenceVerdictLLM | null> {
  const model = getModel(input.modelId);
  const lm = await buildLanguageModel(model.provider, input.keys, model.id, {
    lmstudioBaseURL: input.lmstudioBaseURL,
  });
  const tools = buildSuiteChatTools(input.sourceRoot);
  const result = await generateText({
    model: lm,
    system: CONFIDENCE_EVAL_SYSTEM_PROMPT,
    prompt,
    abortSignal: input.signal,
    ...(tools ? { tools, stopWhen: stepCountIs(10) } : {}),
  });
  return parseConfidenceVerdict(result.text ?? "");
}

async function runOnceClaude(
  input: ConfidenceEvalInput,
  prompt: string,
): Promise<ConfidenceVerdictLLM | null> {
  const env: Record<string, string> = {};
  if (input.authMode === "api-key") {
    const key = await getKey("anthropic");
    if (key) env.ANTHROPIC_API_KEY = key;
  }
  const runId = `conf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  // Cancel the subprocess when the caller aborts (the chip's cancel button).
  const onAbort = () => void cancelClaudeRun(runId).catch(() => undefined);
  input.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const result = await runClaudeQuery({
      runId,
      prompt,
      systemPrompt: CONFIDENCE_EVAL_SYSTEM_PROMPT,
      cwd: input.sourceRoot ?? undefined,
      model: input.modelId,
      permissionMode: "bypassPermissions",
      allowedTools: ["Read", "Glob", "Grep"],
      bare: input.bareMode,
      env,
    });
    if (input.signal?.aborted) throw abortError();
    return parseConfidenceVerdict(result.text ?? "");
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
  }
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

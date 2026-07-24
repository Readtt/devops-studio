// Model-aware context-size estimation shared by every AI input surface
// (Generator spec, Generator refine, Suite Chat, Commit Review) and the
// Settings baseline readout. It answers one question — "is what we're about to
// send too big for the selected model?" — so the app can warn BEFORE a run
// that would burn credits and then fail partway for want of room to answer.
//
// This is a GUARDRAIL, not a billing meter: we deliberately avoid pulling in a
// provider-specific tokenizer (they disagree across Claude / GPT / Gemini and
// add a WASM dependency) and use a conservative chars-per-token heuristic. Every
// number it produces is surfaced with a "~". The thresholds fire well before the
// real ceiling, so heuristic drift stays on the safe side.

import { estimateCost, getModelContextLimit } from "@/modules/ai/config";

/** Average characters per token. English prose is ~4; code/JSON is denser
 *  (~3.3–3.6), so 4 slightly UNDER-counts dense specs — acceptable because the
 *  budget already carves out an output reserve and the tiers trip early. */
export const CHARS_PER_TOKEN = 4;

/** Flat per-image cost. Vision models bill images as a block of tokens; ~1.3k
 *  is a reasonable mid-point across providers for the medium-res images a QA
 *  drops in. Approximate by design. */
export const TOKENS_PER_IMAGE = 1_300;

/** Room we hold back for the model's own reply. This is the specific defense
 *  against "it ran out midway and never answered": the budget the input is
 *  measured against already excludes the reply, so the meter turns red before
 *  the input starves the output. */
export const DEFAULT_OUTPUT_RESERVE = 8_000;

/** Fixed overhead for the system prompt scaffolding every surface sends
 *  (role framing, tool schemas, formatting rules) before any user content. */
export const SYSTEM_BASE_TOKENS = 1_500;

/** Working-token budget at which integration-heavy work — generating exhaustive
 *  test cases, reviewing a diff against its surrounding code — starts to thin.
 *
 *  This is deliberately NOT a fraction of the context window. Quality degrades
 *  because of the *reasoning regime* (the model has to hold and cross-reference
 *  everything at once), not because it ran out of window, so the green ceiling is
 *  roughly constant across frontier models and does NOT grow with a 1M window.
 *  Needle-in-a-haystack retrieval survives far longer than this; our tasks don't.
 *  The amber tier is defined to begin right here, so the only rule a user needs
 *  is "keep it green." */
export const QUALITY_BUDGET_FRONTIER = 50_000;

/** Multiple of the quality budget past which degradation is severe enough to
 *  paint red rather than amber (still advisory — quality, not a hard failure). */
export const QUALITY_SEVERE_MULTIPLE = 3;

/** Fraction of the usable window at which a run genuinely risks not physically
 *  fitting (a real failure that wastes the call), distinct from quality. Below
 *  1.0 on purpose: the estimate is approximate, so leave headroom. */
export const OVERFLOW_RATIO = 0.92;

/** The green ceiling, in working tokens, for a model with the given window.
 *  Frontier (≥400k) models get the full budget; smaller models degrade earlier,
 *  so it's clamped down. On tiny local windows the fit guard usually binds first. */
export function qualityBudgetFor(windowTokens: number): number {
  if (windowTokens >= 400_000) return QUALITY_BUDGET_FRONTIER;
  if (windowTokens >= 128_000) return 30_000;
  if (windowTokens >= 64_000) return 18_000;
  return Math.max(6_000, Math.round(windowTokens * 0.35));
}

export type ContextTier = "comfortable" | "heavy" | "overflow";

/** One labelled contributor to the payload, already reduced to a token count.
 *  Callers build these from whatever they know (spec text, history, baseline). */
export type ContextSegment = { label: string; tokens: number };

export type ContextUsage = {
  /** Total estimated input tokens across every segment. */
  usedTokens: number;
  /** The selected model's full context window. */
  windowTokens: number;
  /** windowTokens − output reserve − system base. What the input can physically
   *  fill before it risks not fitting. Drives {@link mayNotFit}, not the colour. */
  usableBudget: number;
  /** The green ceiling in working tokens (see {@link qualityBudgetFor}). The chip
   *  shows usedTokens against THIS — it's the line users should stay under. */
  qualityBudget: number;
  /** usedTokens / qualityBudget — progress toward the green ceiling, so the meter
   *  fills and colours by quality, not by window occupancy. Can exceed 1. */
  ratio: number;
  /** The payload may not physically fit and still leave room to reply. Rare on
   *  big-window models; this — not the quality tier — gates the overflow confirm. */
  mayNotFit: boolean;
  tier: ContextTier;
  /** Rough dollar cost of the run (input + reserved output), or null when the
   *  model has no published pricing (local / custom endpoints). */
  estCostUsd: number | null;
  /** Non-zero segments, largest first — drives the breakdown tooltip. */
  segments: ContextSegment[];
  outputReserve: number;
};

/** Estimate tokens for a string via the chars-per-token heuristic. */
export function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Estimate tokens from a byte length (used for files we size via fs_stat
 *  rather than read). Bytes ≈ chars for UTF-8 text, which is what best-practices
 *  / standards files are. */
export function estimateTokensFromBytes(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return Math.ceil(bytes / CHARS_PER_TOKEN);
}

export type ComputeUsageInput = {
  modelId: string | undefined;
  /** Override window for openai-compatible endpoints (user-configured). */
  compatOverride?: number;
  segments: ContextSegment[];
  /** Extra images folded in at a flat per-image rate. */
  imagesCount?: number;
  outputReserve?: number;
};

/** Fold a set of labelled segments into a single usage verdict for a model. */
export function computeContextUsage(input: ComputeUsageInput): ContextUsage {
  const outputReserve = input.outputReserve ?? DEFAULT_OUTPUT_RESERVE;
  const windowTokens = getModelContextLimit(input.modelId, input.compatOverride);

  const segments: ContextSegment[] = [...input.segments];
  const images = input.imagesCount ?? 0;
  if (images > 0) {
    segments.push({
      label: images === 1 ? "1 image" : `${images} images`,
      tokens: images * TOKENS_PER_IMAGE,
    });
  }

  const nonZero = segments
    .filter((s) => s.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens);
  const usedTokens = nonZero.reduce((sum, s) => sum + s.tokens, 0);

  // Never let the budget collapse to <=0 on a tiny local window, which would
  // make every ratio Infinity and paint the meter red for a one-line prompt.
  const usableBudget = Math.max(
    1_000,
    windowTokens - outputReserve - SYSTEM_BASE_TOKENS,
  );
  // Never let the quality ceiling exceed what can physically fit (tiny local
  // windows), so the amber line never sits past the point the run stops fitting.
  const qualityBudget = Math.min(qualityBudgetFor(windowTokens), usableBudget);
  const ratio = usedTokens / qualityBudget;
  const mayNotFit = usedTokens / usableBudget >= OVERFLOW_RATIO;

  // Colour is quality-first: amber once we cross the green ceiling, red once
  // quality is badly degraded OR the run may not physically fit.
  const tier: ContextTier =
    mayNotFit || ratio >= QUALITY_SEVERE_MULTIPLE
      ? "overflow"
      : ratio >= 1
        ? "heavy"
        : "comfortable";

  const estCostUsd = estimateCost(input.modelId, {
    inputTokens: usedTokens,
    outputTokens: outputReserve,
    cachedInputTokens: 0,
  });

  return {
    usedTokens,
    windowTokens,
    usableBudget,
    qualityBudget,
    ratio,
    mayNotFit,
    tier,
    estCostUsd,
    segments: nonZero,
    outputReserve,
  };
}

/** Compact token label: `840`, `12k`, `1.2M`. Pairs with a leading "~". */
export function formatTokens(tokens: number): string {
  if (tokens < 1_000) return String(Math.max(0, Math.round(tokens)));
  // 999_500+ rounds up to "1.0k" → show it as "1M" instead of "1000k".
  if (tokens < 999_500) {
    const k = tokens / 1_000;
    return `${k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, "")}k`;
  }
  const m = tokens / 1_000_000;
  return `${m.toFixed(m >= 10 ? 0 : 1).replace(/\.0$/, "")}M`;
}

/** Compact dollar label for a run estimate: `<$0.01`, `$0.08`, `$1.20`. */
export function formatCostUsd(usd: number): string {
  if (usd <= 0) return "$0.00";
  if (usd < 0.01) return "<$0.01";
  if (usd < 100) return `$${usd.toFixed(2)}`;
  return `$${Math.round(usd)}`;
}

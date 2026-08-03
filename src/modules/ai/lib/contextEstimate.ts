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

/** Share of the context window treated as the green quality ceiling — "keep it
 *  under a third of the window".
 *
 *  Quality degrades from the *reasoning regime* (the model has to hold and
 *  cross-reference everything at once), not from running out of window, so the
 *  ceiling is clamped at both ends rather than tracking the window all the way
 *  up. But it is not constant either, which is what the flat 50,000 this
 *  replaces got wrong: on a 1M-window model that put the advisory at 5% of the
 *  window, so ordinary work tripped a banner that reads like a limit warning. */
export const QUALITY_BUDGET_FRACTION = 0.3;

/** Green zone a tiny local window still gets, so a one-paragraph prompt on a
 *  32k model isn't immediately "heavy". */
export const QUALITY_BUDGET_FLOOR = 6_000;

/** Where the green zone stops growing. Past this the reasoning regime — not the
 *  window — is the binding constraint, so a 2M-window model gets no more room
 *  than a 1M one. */
export const QUALITY_BUDGET_CEILING = 150_000;

/** Multiple of the quality budget past which degradation is severe enough to
 *  paint red rather than amber (still advisory — quality, not a hard failure). */
export const QUALITY_SEVERE_MULTIPLE = 3;

/** Fraction of the usable window at which a run genuinely risks not physically
 *  fitting (a real failure that wastes the call), distinct from quality. Below
 *  1.0 on purpose: the estimate is approximate, so leave headroom. */
export const OVERFLOW_RATIO = 0.92;

/** The green ceiling, in working tokens, for a model with the given window.
 *  A clamped fraction rather than a step ladder: the ladder cliffed (a 399k
 *  model got 30k, a 400k one got 50k) and an unmapped model id, which falls back
 *  to a 128k window, silently landed on a different rung than the model the user
 *  actually picked. On tiny local windows the fit guard usually binds first. */
export function qualityBudgetFor(windowTokens: number): number {
  if (!Number.isFinite(windowTokens) || windowTokens <= 0) {
    return QUALITY_BUDGET_FLOOR;
  }
  return Math.min(
    QUALITY_BUDGET_CEILING,
    Math.max(
      QUALITY_BUDGET_FLOOR,
      Math.round(windowTokens * QUALITY_BUDGET_FRACTION),
    ),
  );
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

/** Whether the inline advisory renders at all. It is ADVISORY — it says results
 *  thin out past here, never that the run will fail — so it is gated on the
 *  quality tier only. The interrupting confirm is gated separately on
 *  {@link ContextUsage.mayNotFit}, which is the physical won't-fit case. */
export function showsContextAdvisory(
  usage: ContextUsage,
  guardEnabled: boolean,
): boolean {
  return guardEnabled && usage.tier !== "comfortable";
}

// --- In-run measurement (true counts, not the char heuristic) ---------------
//
// Everything above is pre-flight: it estimates what we're ABOUT to send. Once a
// run is in flight the provider reports the real prompt size per step, which is
// both exact and inclusive of the tool results the pre-flight estimate can't
// see. That's the number an eviction decision has to be made on.

/** Headroom held back from the window before the transcript should be
 *  compacted — Claude Code's figure. Only {@link RequestContextSignal.shouldCompact}
 *  reads it today; acting on it is Phase 3's job. */
export const COMPACTION_BUFFER_TOKENS = 13_000;

/** What one completed step's provider-reported usage says about how full the
 *  window is. Measured, not estimated. */
export type RequestContextSignal = {
  /** True prompt size of the request that produced the step. Cache reads are
   *  INCLUDED — a cached token is cheaper, not smaller, and still occupies the
   *  window. (The AI SDK's `usage.inputTokens` is already the total: v6 maps it
   *  from `inputTokens.total` = noCache + cacheRead + cacheWrite.) */
  promptTokens: number;
  windowTokens: number;
  /** window − output reserve: what the prompt may occupy and still leave the
   *  model room to answer. */
  usableBudget: number;
  /** promptTokens / usableBudget. Can exceed 1 — the provider accepted this
   *  request, so the reserve, not the window, is what's been eaten into. */
  ratio: number;
  headroomTokens: number;
  /** Within {@link COMPACTION_BUFFER_TOKENS} of the usable budget. The seam
   *  Phase 3's eviction hangs off; nothing consumes it yet. */
  shouldCompact: boolean;
  /** cacheReadTokens / promptTokens, or null when the provider reported no
   *  cache detail. Worth watching alongside the token count: a request that
   *  gets smaller while this falls is a COST regression, not a win. */
  cacheHitRatio: number | null;
};

/** Fold one step's usage into a context-pressure reading. Returns null when the
 *  provider reported no input count (local endpoints often don't), so callers
 *  keep the last real reading rather than treating "unknown" as "empty". */
export function measureRequestContext(input: {
  modelId: string | undefined;
  /** ONE step's usage, never a sum across steps: `inputTokens` is the size of
   *  the request that produced that step, which is the quantity that has to fit
   *  the window. Summed across steps it measures spend, not occupancy. */
  usage: { inputTokens?: number; cacheReadTokens?: number } | undefined;
  compatOverride?: number;
  outputReserve?: number;
}): RequestContextSignal | null {
  const promptTokens = input.usage?.inputTokens;
  if (
    typeof promptTokens !== "number" ||
    !Number.isFinite(promptTokens) ||
    promptTokens <= 0
  ) {
    return null;
  }
  const windowTokens = getModelContextLimit(input.modelId, input.compatOverride);
  const outputReserve = input.outputReserve ?? DEFAULT_OUTPUT_RESERVE;
  const usableBudget = Math.max(1_000, windowTokens - outputReserve);
  const headroomTokens = usableBudget - promptTokens;
  const cacheRead = input.usage?.cacheReadTokens;
  return {
    promptTokens,
    windowTokens,
    usableBudget,
    ratio: promptTokens / usableBudget,
    headroomTokens,
    shouldCompact: headroomTokens <= COMPACTION_BUFFER_TOKENS,
    cacheHitRatio:
      typeof cacheRead === "number" && Number.isFinite(cacheRead)
        ? Math.min(1, Math.max(0, cacheRead) / promptTokens)
        : null,
  };
}

/** Run-level cache hit ratio: cache reads as a share of the tokens the run sent.
 *
 *  Same formula as {@link RequestContextSignal.cacheHitRatio}, over a run's
 *  SUMMED usage rather than one step's. `inputTokens` is already the total —
 *  the AI SDK maps it from `inputTokens.total` = noCache + cacheRead +
 *  cacheWrite — so dividing by `inputTokens + cacheReadTokens` would count the
 *  cache reads twice and cap a perfectly cached run at 50%.
 *
 *  Null means "unknown", never "nothing cached": a provider that reports no
 *  cache detail (every local endpoint, some gateways) is not the same as one
 *  reporting a miss, and rendering that as 0% would read as a cost regression
 *  that never happened. */
export function cacheHitRatioOf(
  usage:
    | { inputTokens?: number | null; cacheReadTokens?: number | null }
    | null
    | undefined,
): number | null {
  const input = usage?.inputTokens;
  const cacheRead = usage?.cacheReadTokens;
  if (typeof input !== "number" || !Number.isFinite(input) || input <= 0) {
    return null;
  }
  if (typeof cacheRead !== "number" || !Number.isFinite(cacheRead)) return null;
  return Math.min(1, Math.max(0, cacheRead) / input);
}

/** `0.873` → `"87%"`. Whole percent: the ratio is a health indicator to compare
 *  between runs, and decimals imply a precision the provider's own rounding
 *  doesn't have. */
export function formatPercent(ratio: number): string {
  return `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%`;
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

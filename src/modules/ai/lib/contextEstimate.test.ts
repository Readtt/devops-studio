import { describe, expect, it } from "vitest";
import {
  CHARS_PER_TOKEN,
  COMPACTION_BUFFER_TOKENS,
  DEFAULT_OUTPUT_RESERVE,
  QUALITY_BUDGET_CEILING,
  QUALITY_BUDGET_FLOOR,
  QUALITY_BUDGET_FRACTION,
  QUALITY_SEVERE_MULTIPLE,
  TOKENS_PER_IMAGE,
  cacheHitRatioOf,
  computeContextUsage,
  estimateTokens,
  estimateTokensFromBytes,
  formatCostUsd,
  formatPercent,
  formatTokens,
  measureRequestContext,
  qualityBudgetFor,
  showsContextAdvisory,
} from "./contextEstimate";

describe("estimateTokens", () => {
  it("returns 0 for empty / nullish input", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens(null)).toBe(0);
    expect(estimateTokens(undefined)).toBe(0);
  });

  it("divides char length by the heuristic, rounding up", () => {
    expect(estimateTokens("a".repeat(CHARS_PER_TOKEN * 10))).toBe(10);
    expect(estimateTokens("abcde")).toBe(2); // 5/4 → 2
  });
});

describe("estimateTokensFromBytes", () => {
  it("guards against non-positive / non-finite sizes", () => {
    expect(estimateTokensFromBytes(0)).toBe(0);
    expect(estimateTokensFromBytes(-5)).toBe(0);
    expect(estimateTokensFromBytes(Number.NaN)).toBe(0);
  });

  it("mirrors the char heuristic on byte counts", () => {
    expect(estimateTokensFromBytes(4_000)).toBe(1_000);
  });
});

describe("computeContextUsage", () => {
  it("stays comfortable for a small spec against a 1M-window model", () => {
    const usage = computeContextUsage({
      modelId: "claude-sonnet-5",
      segments: [{ label: "spec", tokens: 2_000 }],
    });
    expect(usage.windowTokens).toBe(1_000_000);
    expect(usage.usedTokens).toBe(2_000);
    expect(usage.qualityBudget).toBe(QUALITY_BUDGET_CEILING);
    expect(usage.tier).toBe("comfortable");
    expect(usage.mayNotFit).toBe(false);
    expect(usage.outputReserve).toBe(DEFAULT_OUTPUT_RESERVE);
  });

  it("turns amber the moment the payload crosses the quality budget, not the window", () => {
    // Colour tracks quality, not window occupancy — but the budget it tracks
    // scales with the window, so a 1M model's green zone is far past a 128k
    // model's rather than pinned to the same flat number.
    const green = computeContextUsage({
      modelId: "claude-sonnet-5",
      segments: [{ label: "spec", tokens: QUALITY_BUDGET_CEILING - 5_000 }],
    });
    expect(green.tier).toBe("comfortable");

    const amber = computeContextUsage({
      modelId: "claude-sonnet-5",
      segments: [{ label: "spec", tokens: QUALITY_BUDGET_CEILING + 5_000 }],
    });
    expect(amber.tier).toBe("heavy");
    expect(amber.mayNotFit).toBe(false); // nowhere near physically full
  });

  it("escalates to red on severe quality bloat without claiming it won't fit", () => {
    const usage = computeContextUsage({
      modelId: "claude-sonnet-5",
      segments: [
        {
          label: "spec",
          tokens: QUALITY_BUDGET_CEILING * QUALITY_SEVERE_MULTIPLE + 10_000,
        },
      ],
    });
    expect(usage.tier).toBe("overflow");
    expect(usage.mayNotFit).toBe(false); // still tiny against a 1M window
  });

  it("flags mayNotFit when the payload truly can't fit a tiny window", () => {
    // ollama-local resolves to a 32k window; a payload near the usable budget
    // must trip the physical fit guard that gates the overflow confirm.
    const usage = computeContextUsage({
      modelId: "ollama-local",
      segments: [{ label: "spec", tokens: 22_000 }],
    });
    expect(usage.mayNotFit).toBe(true);
    expect(usage.tier).toBe("overflow");
    expect(Number.isFinite(usage.ratio)).toBe(true);
  });

  it("keeps the quality ceiling from exceeding a tiny window's usable budget", () => {
    const usage = computeContextUsage({
      modelId: "ollama-local",
      segments: [{ label: "spec", tokens: 1 }],
    });
    expect(usage.usableBudget).toBeGreaterThanOrEqual(1_000);
    expect(usage.qualityBudget).toBeLessThanOrEqual(usage.usableBudget);
  });

  it("folds images in at the flat per-image rate", () => {
    const usage = computeContextUsage({
      modelId: "claude-sonnet-5",
      segments: [{ label: "spec", tokens: 100 }],
      imagesCount: 2,
    });
    expect(usage.usedTokens).toBe(100 + 2 * TOKENS_PER_IMAGE);
    expect(usage.segments[0].tokens).toBe(2 * TOKENS_PER_IMAGE); // sorted desc
  });

  it("drops zero-token segments and sorts the rest largest-first", () => {
    const usage = computeContextUsage({
      modelId: "claude-sonnet-5",
      segments: [
        { label: "empty", tokens: 0 },
        { label: "small", tokens: 50 },
        { label: "big", tokens: 5_000 },
      ],
    });
    expect(usage.segments.map((s) => s.label)).toEqual(["big", "small"]);
  });

  it("prices runs on models with published rates and returns null otherwise", () => {
    const priced = computeContextUsage({
      modelId: "claude-sonnet-5",
      segments: [{ label: "spec", tokens: 10_000 }],
    });
    expect(priced.estCostUsd).toBeGreaterThan(0);

    const local = computeContextUsage({
      modelId: "ollama-local",
      segments: [{ label: "spec", tokens: 10_000 }],
    });
    expect(local.estCostUsd).toBeNull();
  });
});

// The quality budget used to be a flat 50,000 for any window >= 400k, so on a
// 1M-window model the amber advisory fired at 5% window occupancy — on work
// that was in no trouble at all — and, worded as a limit warning, read as
// "you can't send this". These pin the recalibration.
describe("quality budget · window-aware", () => {
  it("does NOT fire the advisory for a payload that is small for a 1M window", () => {
    // 60k tokens: over the old flat 50,000 ceiling (amber), comfortably inside
    // a 1M model's green zone.
    const usage = computeContextUsage({
      modelId: "claude-sonnet-5",
      segments: [{ label: "spec", tokens: 60_000 }],
    });
    expect(usage.tier).toBe("comfortable");
    expect(showsContextAdvisory(usage, true)).toBe(false);
  });

  it("still fires when the payload is genuinely heavy for that same model", () => {
    const usage = computeContextUsage({
      modelId: "claude-sonnet-5",
      segments: [{ label: "spec", tokens: 200_000 }],
    });
    expect(usage.tier).toBe("heavy");
    expect(showsContextAdvisory(usage, true)).toBe(true);
    // Advisory, not a limit warning: it still physically fits, so the
    // interrupting confirm stays shut.
    expect(usage.mayNotFit).toBe(false);
  });

  it("fires that same payload on a small-window model, where it IS heavy", () => {
    const usage = computeContextUsage({
      modelId: "deepseek-reasoner", // 128k
      segments: [{ label: "spec", tokens: 60_000 }],
    });
    expect(showsContextAdvisory(usage, true)).toBe(true);
  });

  it("scales with the window between the floor and the ceiling", () => {
    expect(qualityBudgetFor(128_000)).toBe(128_000 * QUALITY_BUDGET_FRACTION);
    expect(qualityBudgetFor(200_000)).toBe(200_000 * QUALITY_BUDGET_FRACTION);
    // Ceiling: past here the reasoning regime binds, not the window, so a 2M
    // model gets no more green than a 1M one.
    expect(qualityBudgetFor(1_000_000)).toBe(QUALITY_BUDGET_CEILING);
    expect(qualityBudgetFor(2_000_000)).toBe(QUALITY_BUDGET_CEILING);
    // Floor: a tiny local window still gets a workable green zone.
    expect(qualityBudgetFor(8_000)).toBe(QUALITY_BUDGET_FLOOR);
    expect(qualityBudgetFor(0)).toBe(QUALITY_BUDGET_FLOOR);
  });

  it("has no cliff — a hair more window never means a lot more budget", () => {
    // The step ladder handed 399,999 → 30,000 and 400,000 → 50,000, so an
    // unmapped model id (which falls back to a 128k window) landed on a
    // different rung than the model the user actually picked.
    for (const w of [63_999, 64_000, 127_999, 128_000, 399_999, 400_000]) {
      expect(qualityBudgetFor(w + 1) - qualityBudgetFor(w)).toBeLessThanOrEqual(1);
    }
  });

  it("respects the guard preference — off means no advisory at any tier", () => {
    const usage = computeContextUsage({
      modelId: "claude-sonnet-5",
      segments: [{ label: "spec", tokens: 900_000 }],
    });
    expect(usage.tier).toBe("overflow");
    expect(showsContextAdvisory(usage, false)).toBe(false);
  });
});

// Everything above estimates what we're about to send. This is the real thing:
// the provider's own count for a request it already answered.
describe("measureRequestContext", () => {
  it("returns null when the provider reported no input count", () => {
    expect(
      measureRequestContext({ modelId: "claude-sonnet-5", usage: undefined }),
    ).toBeNull();
    expect(
      measureRequestContext({ modelId: "claude-sonnet-5", usage: {} }),
    ).toBeNull();
    expect(
      measureRequestContext({
        modelId: "claude-sonnet-5",
        usage: { inputTokens: 0 },
      }),
    ).toBeNull();
  });

  it("measures the prompt against the window less the output reserve", () => {
    const s = measureRequestContext({
      modelId: "claude-haiku-4-5", // 200k
      usage: { inputTokens: 50_000 },
    })!;
    expect(s.windowTokens).toBe(200_000);
    expect(s.usableBudget).toBe(200_000 - DEFAULT_OUTPUT_RESERVE);
    expect(s.promptTokens).toBe(50_000);
    expect(s.headroomTokens).toBe(200_000 - DEFAULT_OUTPUT_RESERVE - 50_000);
    expect(s.ratio).toBeCloseTo(50_000 / (200_000 - DEFAULT_OUTPUT_RESERVE));
    expect(s.shouldCompact).toBe(false);
  });

  it("flags shouldCompact only inside the buffer (the Phase 3 seam)", () => {
    const usable = 200_000 - DEFAULT_OUTPUT_RESERVE;
    const outside = measureRequestContext({
      modelId: "claude-haiku-4-5",
      usage: { inputTokens: usable - COMPACTION_BUFFER_TOKENS - 1 },
    })!;
    expect(outside.shouldCompact).toBe(false);

    const inside = measureRequestContext({
      modelId: "claude-haiku-4-5",
      usage: { inputTokens: usable - COMPACTION_BUFFER_TOKENS },
    })!;
    expect(inside.shouldCompact).toBe(true);
  });

  // The AI SDK's `usage.inputTokens` is `inputTokens.total` — noCache +
  // cacheRead + cacheWrite. So a cached token is already IN the prompt size
  // (cheaper, not smaller), and the hit ratio divides by it rather than adding
  // the cache reads on a second time.
  it("reads the cache hit ratio out of a prompt size that already includes it", () => {
    const s = measureRequestContext({
      modelId: "claude-sonnet-5",
      usage: { inputTokens: 100_000, cacheReadTokens: 90_000 },
    })!;
    expect(s.promptTokens).toBe(100_000);
    expect(s.cacheHitRatio).toBeCloseTo(0.9);
  });

  it("leaves the hit ratio null when the provider reported no cache detail", () => {
    const s = measureRequestContext({
      modelId: "claude-sonnet-5",
      usage: { inputTokens: 100_000 },
    })!;
    expect(s.cacheHitRatio).toBeNull();
  });

  it("honours the openai-compatible window override", () => {
    const s = measureRequestContext({
      modelId: "openai-compatible-custom",
      usage: { inputTokens: 10_000 },
      compatOverride: 32_000,
    })!;
    expect(s.windowTokens).toBe(32_000);
  });
});

describe("cacheHitRatioOf (run-level, what the readout shows)", () => {
  it("divides by a total that already includes the cache reads", () => {
    // The double-count trap: `cacheRead / (input + cacheRead)` would report
    // 47% here and could never exceed 50% however well the cache performed.
    expect(cacheHitRatioOf({ inputTokens: 100_000, cacheReadTokens: 90_000 })).toBeCloseTo(
      0.9,
    );
    expect(cacheHitRatioOf({ inputTokens: 1_000, cacheReadTokens: 1_000 })).toBe(1);
  });

  it("says UNKNOWN, not zero, when the provider reported no cache detail", () => {
    // An endpoint that doesn't meter cache reads is not an endpoint whose cache
    // is missing. Rendering it as 0% would report a cost regression that never
    // happened — and this readout exists precisely to be trusted on that.
    expect(cacheHitRatioOf({ inputTokens: 100_000 })).toBeNull();
    expect(cacheHitRatioOf(undefined)).toBeNull();
    expect(cacheHitRatioOf({ cacheReadTokens: 90_000 })).toBeNull();
  });

  it("distinguishes a reported zero from an unreported one", () => {
    expect(cacheHitRatioOf({ inputTokens: 100_000, cacheReadTokens: 0 })).toBe(0);
  });

  it("absorbs provider rounding but refuses a mismatched pair", () => {
    // A percent over is rounding; four times over is a different number in the
    // numerator and the denominator. Since the run budget's own `tokensUsed`
    // is now cost-equivalent — cache reads already discounted tenfold — that
    // mix-up is a live wiring hazard, and clamping it to 1 would report a
    // flawless cache hit exactly when the figure is meaningless.
    expect(cacheHitRatioOf({ inputTokens: 100, cacheReadTokens: 101 })).toBe(1);
    expect(cacheHitRatioOf({ inputTokens: 100, cacheReadTokens: 400 })).toBeNull();
    // A 90%-cached run costs 19% of its raw tokens, so passing the budget
    // figure by mistake looks exactly like this — and now reads "n/a".
    expect(
      cacheHitRatioOf({ inputTokens: 19_000, cacheReadTokens: 90_000 }),
    ).toBeNull();
    expect(cacheHitRatioOf({ inputTokens: 100, cacheReadTokens: -5 })).toBe(0);
  });

  it("agrees with the per-step signal it aggregates", () => {
    const usage = { inputTokens: 80_000, cacheReadTokens: 60_000 };
    expect(cacheHitRatioOf(usage)).toBeCloseTo(
      measureRequestContext({ modelId: "claude-sonnet-5", usage })!.cacheHitRatio!,
    );
  });
});

describe("formatPercent", () => {
  it("renders whole percent", () => {
    expect(formatPercent(0.873)).toBe("87%");
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(1)).toBe("100%");
  });

  it("clamps out-of-range input rather than printing nonsense", () => {
    expect(formatPercent(1.4)).toBe("100%");
    expect(formatPercent(-0.2)).toBe("0%");
  });
});

describe("formatTokens", () => {
  it("formats across magnitudes", () => {
    expect(formatTokens(840)).toBe("840");
    expect(formatTokens(12_000)).toBe("12k");
    expect(formatTokens(1_500)).toBe("1.5k");
    expect(formatTokens(120_000)).toBe("120k");
    expect(formatTokens(1_000_000)).toBe("1M");
    expect(formatTokens(1_200_000)).toBe("1.2M");
  });
});

describe("formatCostUsd", () => {
  it("formats small and large estimates", () => {
    expect(formatCostUsd(0)).toBe("$0.00");
    expect(formatCostUsd(0.004)).toBe("<$0.01");
    expect(formatCostUsd(0.08)).toBe("$0.08");
    expect(formatCostUsd(1.2)).toBe("$1.20");
  });
});

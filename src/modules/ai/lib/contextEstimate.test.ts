import { describe, expect, it } from "vitest";
import {
  CHARS_PER_TOKEN,
  DEFAULT_OUTPUT_RESERVE,
  QUALITY_BUDGET_FRONTIER,
  QUALITY_SEVERE_MULTIPLE,
  TOKENS_PER_IMAGE,
  computeContextUsage,
  estimateTokens,
  estimateTokensFromBytes,
  formatCostUsd,
  formatTokens,
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
    expect(usage.qualityBudget).toBe(QUALITY_BUDGET_FRONTIER);
    expect(usage.tier).toBe("comfortable");
    expect(usage.mayNotFit).toBe(false);
    expect(usage.outputReserve).toBe(DEFAULT_OUTPUT_RESERVE);
  });

  it("turns amber the moment the payload crosses the quality budget, not the window", () => {
    // A frontier 1M model thins at ~50k working tokens — only ~2% of the window,
    // which is the whole point: colour tracks quality, not window occupancy.
    const green = computeContextUsage({
      modelId: "claude-sonnet-5",
      segments: [{ label: "spec", tokens: QUALITY_BUDGET_FRONTIER - 5_000 }],
    });
    expect(green.tier).toBe("comfortable");

    const amber = computeContextUsage({
      modelId: "claude-sonnet-5",
      segments: [{ label: "spec", tokens: QUALITY_BUDGET_FRONTIER + 5_000 }],
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
          tokens: QUALITY_BUDGET_FRONTIER * QUALITY_SEVERE_MULTIPLE + 10_000,
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

import { describe, expect, it } from "vitest";
import {
  budgetSpentPhrase,
  limitReached,
  stepSpend,
  tokenBudgetIs,
  totalSpend,
  type RunBudget,
} from "./runBudget";

const step = (inputTokens?: number, outputTokens?: number, totalTokens?: number) => ({
  usage: { inputTokens, outputTokens, totalTokens },
});

describe("stepSpend", () => {
  it("counts the request AND the answer, the answer at its price", () => {
    // Output bills at 3-5x input everywhere that publishes a price sheet; 5x
    // is Claude 5's ratio at both tiers. It rode at 1x while cache reads were
    // undiscounted, when it was a rounding error next to a re-sent transcript.
    expect(stepSpend({ inputTokens: 1_000, outputTokens: 250 })).toBe(2_250);
  });

  it("charges cache reads at a tenth — the whole point of the metric", () => {
    // `inputTokens` is already the total INCLUDING cache reads (the SDK maps
    // it from inputTokens.total), so the fresh part is the difference. A run
    // that is 90% cached costs roughly a fifth of the same tokens uncached,
    // and a budget that couldn't see that cut off cheap runs to protect money
    // nobody was spending.
    expect(
      stepSpend({ inputTokens: 50_000, outputTokens: 0, cacheReadTokens: 45_000 }),
    ).toBe(5_000 + 4_500);
    // No cache detail reported ⇒ everything is fresh. Conservative, and true
    // of most endpoints that don't report it.
    expect(stepSpend({ inputTokens: 50_000, outputTokens: 0 })).toBe(50_000);
  });

  // The two callers hand this DIFFERENT shapes: the accumulator a flattened
  // TaskUsage, the `stopWhen` condition the SDK's own nested LanguageModelUsage.
  // Reading only the flat field would make the stop condition count every
  // cached token at the fresh rate while the readout discounted it — the run
  // would stop at a number the user never saw it reach.
  it("reads the cache split from the SDK's nested shape too", () => {
    const flat = stepSpend({
      inputTokens: 50_000,
      outputTokens: 0,
      cacheReadTokens: 45_000,
    });
    expect(
      stepSpend({
        inputTokens: 50_000,
        outputTokens: 0,
        inputTokenDetails: { cacheReadTokens: 45_000 },
      }),
    ).toBe(flat);
    expect(
      stepSpend({
        inputTokens: 50_000,
        outputTokens: 0,
        cachedInputTokens: 45_000,
      }),
    ).toBe(flat);
  });

  it("clamps a provider reporting more cache reads than input", () => {
    // Nonsense in, non-negative out: a negative step would let a long run
    // spend forever against a budget that never climbs.
    expect(
      stepSpend({ inputTokens: 100, outputTokens: 0, cacheReadTokens: 900 }),
    ).toBe(10);
  });

  it("falls back to totalTokens when the split is missing", () => {
    // Charged at face value as if all fresh input: no split means no cache
    // detail and no output count, so there is nothing to weight.
    expect(stepSpend({ totalTokens: 900 })).toBe(900);
  });

  it("prefers the split over totalTokens when both are present", () => {
    expect(stepSpend({ inputTokens: 100, outputTokens: 5, totalTokens: 999 })).toBe(
      100 + 25,
    );
  });

  it("treats a garbage count as absent rather than poisoning the sum", () => {
    // A provider reporting null/NaN must not turn the running total into NaN,
    // which compares false against everything and would silently disable the
    // stop condition entirely.
    expect(stepSpend({ inputTokens: NaN, outputTokens: 10 })).toBe(50);
    expect(stepSpend(undefined)).toBe(0);
    expect(totalSpend([step(NaN), step(5, 5)])).toBe(30);
  });

  // The property that makes this the right metric: the most a run can cost is
  // `budget × the model's fresh-input rate`, whatever the cache hit rate and
  // whatever the input/output mix. That is why the budget CONSTANTS didn't
  // move — their dollar ceiling is what stayed fixed, and it is the uncached
  // case that sets it.
  it("is cost-normalised: one unit is one fresh input token, at any mix", () => {
    const rate = { input: 3, output: 15, cacheRead: 0.3 }; // Claude Sonnet 5, $/Mtok
    const dollars = (u: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
    }) => {
      const cached = u.cacheReadTokens ?? 0;
      const fresh = u.inputTokens - cached;
      return (
        (fresh * rate.input +
          cached * rate.cacheRead +
          u.outputTokens * rate.output) /
        1_000_000
      );
    };
    const mixes = [
      { inputTokens: 100_000, outputTokens: 0 },
      { inputTokens: 100_000, outputTokens: 0, cacheReadTokens: 86_000 },
      { inputTokens: 10_000, outputTokens: 5_000 },
      { inputTokens: 500_000, outputTokens: 2_000, cacheReadTokens: 450_000 },
    ];
    for (const m of mixes) {
      // spend units × the fresh-input rate === what it actually costs.
      expect((stepSpend(m) * rate.input) / 1_000_000).toBeCloseTo(dollars(m), 9);
    }
  });
});

describe("tokenBudgetIs", () => {
  const budget = tokenBudgetIs(1_000);

  it("is false while the run is under budget", async () => {
    expect(await budget({ steps: [step(300, 10), step(300, 10)] as never })).toBe(false);
  });

  it("fires once the SUM crosses, not any single step", async () => {
    // The distinction the module exists for: no individual step here is over
    // 1000, but the run has spent 1860. A per-step reading would never fire.
    expect(
      await budget({ steps: [step(600, 30), step(600, 30), step(600, 30)] as never }),
    ).toBe(true);
  });

  it("is stateless — the same condition re-evaluated gives the same answer", async () => {
    // The SDK evaluates every condition after every step and nothing promises
    // it does so exactly once. A closure counter would double-count.
    const steps = [step(600, 30)] as never;
    expect(await budget({ steps })).toBe(false);
    expect(await budget({ steps })).toBe(false);
    expect(await budget({ steps })).toBe(false);
  });

  it("a non-positive budget disables the condition instead of stopping at step 0", async () => {
    const off = tokenBudgetIs(0);
    expect(await off({ steps: [step(10_000_000)] as never })).toBe(false);
  });
});

describe("limitReached", () => {
  const budget: RunBudget = { tokens: 1_000, steps: 10 };

  it("reports nothing while both guards have room", () => {
    expect(limitReached({ tokensUsed: 500, stepsUsed: 4, budget })).toBeNull();
  });

  it("reports the token budget when spend crosses with steps to spare", () => {
    // The case the old `stepsUsed === maxSteps` test could not see at all.
    expect(limitReached({ tokensUsed: 1_000, stepsUsed: 3, budget })).toBe("tokens");
  });

  it("reports the step ceiling when a loop spends nothing and runs away", () => {
    // An endpoint that reports no usage: the token budget is structurally
    // blind, and the ceiling is the only guard there is.
    expect(limitReached({ tokensUsed: 0, stepsUsed: 10, budget })).toBe("steps");
  });

  it("tokens win a tie — it's the budget the user tops up", () => {
    expect(limitReached({ tokensUsed: 1_200, stepsUsed: 10, budget })).toBe("tokens");
  });
});

describe("budgetSpentPhrase", () => {
  const budget: RunBudget = { tokens: 2_500_000, steps: 40 };
  const fmt = (n: number) => `${Math.round(n / 1_000)}k`;

  it("names the token budget for a spend stop", () => {
    expect(budgetSpentPhrase("tokens", budget, fmt)).toBe(
      "its whole ~2500k-token budget",
    );
  });

  it("names the step count for a runaway stop", () => {
    expect(budgetSpentPhrase("steps", budget, fmt)).toBe("all 40 steps it was allowed");
  });

  it("asserts neither guard when the checkpoint predates the field", () => {
    // Backwards compatibility: a checkpoint written before budgets were
    // denominated in tokens has no `limit`. Blaming steps there would be a
    // guess, and on a token stop a wrong one.
    expect(budgetSpentPhrase(undefined, budget, fmt)).toBe("its whole budget");
  });
});

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
  it("counts the request AND the answer", () => {
    expect(stepSpend({ inputTokens: 1_000, outputTokens: 250 })).toBe(1_250);
  });

  it("counts cache reads, because a cached token is cheaper — not absent", () => {
    // inputTokens is already the total including cache reads (the SDK maps it
    // from inputTokens.total). Netting them out would understate a long agentic
    // loop by ~10x, which is the entire shape of the thing being budgeted.
    expect(stepSpend({ inputTokens: 50_000, outputTokens: 0 })).toBe(50_000);
  });

  it("falls back to totalTokens when the split is missing", () => {
    expect(stepSpend({ totalTokens: 900 })).toBe(900);
  });

  it("prefers the split over totalTokens when both are present", () => {
    expect(stepSpend({ inputTokens: 100, outputTokens: 5, totalTokens: 999 })).toBe(105);
  });

  it("treats a garbage count as absent rather than poisoning the sum", () => {
    // A provider reporting null/NaN must not turn the running total into NaN,
    // which compares false against everything and would silently disable the
    // stop condition entirely.
    expect(stepSpend({ inputTokens: NaN, outputTokens: 10 })).toBe(10);
    expect(stepSpend(undefined)).toBe(0);
    expect(totalSpend([step(NaN), step(5, 5)])).toBe(10);
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

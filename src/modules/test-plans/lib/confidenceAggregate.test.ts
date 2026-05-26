import { describe, expect, it } from "vitest";
import { aggregate } from "./runConfidenceEval";
import type { ConfidenceVerdictLLM, PredictedOutcome } from "./confidence";

function v(
  predictedOutcome: PredictedOutcome,
  confidence: number,
  caveats: string[] = [],
): ConfidenceVerdictLLM {
  return { predictedOutcome, confidence, evidence: [], reasoning: "", caveats };
}

describe("aggregate (self-consistency)", () => {
  it("passes a single run through unchanged", () => {
    const out = aggregate([v("Pass", 95)]);
    expect(out.predictedOutcome).toBe("Pass");
    expect(out.confidence).toBe(95);
  });

  it("keeps a high score only when runs are unanimous", () => {
    const out = aggregate([v("Pass", 92), v("Pass", 96), v("Pass", 94)]);
    expect(out.predictedOutcome).toBe("Pass");
    expect(out.confidence).toBe(94); // mean, allowed to stay >= 90
  });

  it("caps below auto-pass when a supermajority agrees but not unanimous", () => {
    // 2/3 agree on Pass at high confidence, one dissents → must drop below 90.
    const out = aggregate([v("Pass", 95), v("Pass", 93), v("Fail", 80)]);
    expect(out.predictedOutcome).toBe("Pass");
    expect(out.confidence).toBeLessThanOrEqual(89);
    expect(out.caveats.join(" ")).toMatch(/agreed/i);
  });

  it("downgrades hard when there is no supermajority", () => {
    // 3-way split → no supermajority → capped low + flagged for manual.
    const out = aggregate([v("Pass", 95), v("Fail", 90), v("Blocked", 88)]);
    expect(out.confidence).toBeLessThanOrEqual(45);
    expect(out.caveats.join(" ")).toMatch(/disagreed|runs agreed|manual/i);
  });

  it("returns Unknown for an empty verdict set", () => {
    const out = aggregate([]);
    expect(out.predictedOutcome).toBe("Unknown");
    expect(out.confidence).toBe(0);
  });
});

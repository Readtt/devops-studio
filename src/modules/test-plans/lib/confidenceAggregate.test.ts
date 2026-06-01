import { describe, expect, it } from "vitest";
import { aggregate, withSafetyCaveats } from "./runConfidenceEval";
import type {
  ConfidenceVerdictLLM,
  EvidenceItem,
  PredictedOutcome,
} from "./confidence";

function v(
  predictedOutcome: PredictedOutcome,
  passLikelihood: number,
  caveats: string[] = [],
  evidence: EvidenceItem[] = [],
): ConfidenceVerdictLLM {
  return { predictedOutcome, passLikelihood, evidence, reasoning: "", caveats };
}

describe("aggregate (self-consistency)", () => {
  it("passes a single run through unchanged", () => {
    const out = aggregate([v("Pass", 95)]);
    expect(out.predictedOutcome).toBe("Pass");
    expect(out.passLikelihood).toBe(95);
  });

  it("keeps a high score only when runs are unanimous", () => {
    const out = aggregate([v("Pass", 92), v("Pass", 96), v("Pass", 94)]);
    expect(out.predictedOutcome).toBe("Pass");
    expect(out.passLikelihood).toBe(94); // mean, allowed to stay >= 90
  });

  it("caps below auto-pass when a supermajority agrees but not unanimous", () => {
    // 2/3 agree on Pass at high pass-likelihood, one dissents → must drop below 90.
    const out = aggregate([v("Pass", 95), v("Pass", 93), v("Fail", 20)]);
    expect(out.predictedOutcome).toBe("Pass");
    expect(out.passLikelihood).toBeLessThanOrEqual(89);
    expect(out.caveats.join(" ")).toMatch(/agreed/i);
  });

  it("downgrades hard when there is no supermajority", () => {
    // 3-way split → no supermajority → capped low + flagged for manual.
    const out = aggregate([v("Pass", 95), v("Fail", 10), v("Blocked", 12)]);
    expect(out.passLikelihood).toBeLessThanOrEqual(45);
    expect(out.caveats.join(" ")).toMatch(/disagreed|runs agreed|manual/i);
  });

  it("returns Unknown for an empty verdict set", () => {
    const out = aggregate([]);
    expect(out.predictedOutcome).toBe("Unknown");
    expect(out.passLikelihood).toBe(0);
  });
});

describe("withSafetyCaveats", () => {
  const grounded: EvidenceItem = { step: 1, finding: "ok", ref: "src/a.ts:10" };
  const ungrounded: EvidenceItem = { step: 2, finding: "guess", ref: null };

  it("adds a manual-test caveat for a high Pass with an ungrounded step", () => {
    const out = withSafetyCaveats(v("Pass", 95, [], [grounded, ungrounded]));
    expect(out.caveats.join(" ")).toMatch(/manual test recommended/i);
  });

  it("leaves a fully-grounded high Pass untouched", () => {
    const out = withSafetyCaveats(v("Pass", 95, [], [grounded]));
    expect(out.caveats).toEqual([]);
  });

  it("does not caveat a sub-threshold score even with a null ref", () => {
    const out = withSafetyCaveats(v("Pass", 70, [], [ungrounded]));
    expect(out.caveats).toEqual([]);
  });

  it("does not caveat a non-Pass outcome", () => {
    const out = withSafetyCaveats(v("Fail", 95, [], [ungrounded]));
    expect(out.caveats).toEqual([]);
  });
});

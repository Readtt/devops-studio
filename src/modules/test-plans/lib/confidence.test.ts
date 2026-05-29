import { describe, expect, it } from "vitest";
import {
  isAutoPassCandidate,
  passReadiness,
  readinessTone,
  type ConfidenceVerdict,
} from "./confidence";

function verdict(p: Partial<ConfidenceVerdict>): ConfidenceVerdict {
  return {
    predictedOutcome: "Pass",
    passLikelihood: 95,
    evidence: [],
    reasoning: "",
    ...p,
  } as ConfidenceVerdict;
}

describe("passReadiness", () => {
  it("uses passLikelihood directly for graded outcomes", () => {
    expect(passReadiness({ predictedOutcome: "Pass", passLikelihood: 92 })).toBe(92);
    expect(passReadiness({ predictedOutcome: "Fail", passLikelihood: 10 })).toBe(10);
  });

  it("returns null for Unknown — the chip's '?' state", () => {
    expect(passReadiness({ predictedOutcome: "Unknown" })).toBeNull();
  });

  it("derives readiness from a legacy confidence value (back-compat)", () => {
    // 94%-confident Fail => 6% pass-ready.
    expect(passReadiness({ predictedOutcome: "Fail", confidence: 94 })).toBe(6);
    expect(passReadiness({ predictedOutcome: "Pass", confidence: 88 })).toBe(88);
  });

  it("clamps out-of-range values", () => {
    expect(passReadiness({ predictedOutcome: "Pass", passLikelihood: 140 })).toBe(100);
    expect(passReadiness({ predictedOutcome: "Pass", passLikelihood: -5 })).toBe(0);
  });
});

describe("isAutoPassCandidate", () => {
  it("is true only for a Pass at/above the 90% bar", () => {
    expect(isAutoPassCandidate(verdict({ passLikelihood: 90 }))).toBe(true);
    expect(isAutoPassCandidate(verdict({ passLikelihood: 89 }))).toBe(false);
  });

  it("is never true for Fail/Blocked/Unknown, even at high readiness", () => {
    expect(isAutoPassCandidate(verdict({ predictedOutcome: "Fail", passLikelihood: 95 }))).toBe(false);
    expect(isAutoPassCandidate(verdict({ predictedOutcome: "Unknown" }))).toBe(false);
    expect(isAutoPassCandidate(null)).toBe(false);
  });
});

describe("readinessTone", () => {
  it("greens only a Pass clearing the bar; Unknown is neutral", () => {
    expect(readinessTone(95, "Pass").className).toContain("emerald");
    expect(readinessTone(95, "Fail").className).not.toContain("emerald");
    expect(readinessTone(null, "Unknown").className).toContain("muted-foreground");
    expect(readinessTone(40, "Fail").className).toContain("rose");
  });
});

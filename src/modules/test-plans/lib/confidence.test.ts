import { describe, expect, it } from "vitest";
import {
  isAutoPassCandidate,
  passReadiness,
  readinessTone,
  verdictSourceState,
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

describe("verdictSourceState", () => {
  it("is fresh when the verdict's source sha matches the current HEAD", () => {
    const s = verdictSourceState({ sourceSha: "abc1234" }, "abc1234");
    expect(s.kind).toBe("fresh");
    expect(s.kind === "fresh" && s.sha).toBe("abc1234");
  });

  it("matches on a 7-char prefix (differing abbreviation lengths)", () => {
    expect(verdictSourceState({ sourceSha: "abc1234" }, "abc1234ff00").kind).toBe(
      "fresh",
    );
  });

  it("is stale when the tree has moved past the evaluated commit", () => {
    const s = verdictSourceState({ sourceSha: "aaaaaaa" }, "bbbbbbb");
    expect(s.kind).toBe("stale");
    if (s.kind === "stale") {
      expect(s.evaluatedSha).toBe("aaaaaaa");
      expect(s.currentSha).toBe("bbbbbbb");
    }
  });

  it("is unknown without a stamp (legacy verdict) or without a current sha (no repo / code search off)", () => {
    expect(verdictSourceState({}, "abc1234").kind).toBe("unknown");
    expect(verdictSourceState({ sourceSha: null }, "abc1234").kind).toBe("unknown");
    expect(verdictSourceState({ sourceSha: "abc1234" }, null).kind).toBe("unknown");
    expect(verdictSourceState({ sourceSha: "abc1234" }, "").kind).toBe("unknown");
  });
});

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

import { describe, expect, it } from "vitest";
import { AUTO_PASS_THRESHOLD, outcomeFromVerdict } from "./confidenceOutcome";
import type { ConfidenceVerdict } from "@/modules/test-plans/lib/confidence";

function verdict(
  predictedOutcome: ConfidenceVerdict["predictedOutcome"],
  passLikelihood: number,
): ConfidenceVerdict {
  return {
    predictedOutcome,
    passLikelihood,
    evidence: [],
    reasoning: "",
    caveats: [],
    evaluatedAt: "2026-06-11T00:00:00.000Z",
    modelId: "test",
  };
}

describe("outcomeFromVerdict", () => {
  it("auto-passes a confident Pass", () => {
    expect(outcomeFromVerdict(verdict("Pass", AUTO_PASS_THRESHOLD))).toBe("Passed");
    expect(outcomeFromVerdict(verdict("Pass", 95))).toBe("Passed");
  });

  it("leaves a low-confidence Pass unset for the human", () => {
    expect(outcomeFromVerdict(verdict("Pass", AUTO_PASS_THRESHOLD - 1))).toBeNull();
    expect(outcomeFromVerdict(verdict("Pass", 0))).toBeNull();
  });

  it("maps Fail and Blocked directly, regardless of likelihood", () => {
    expect(outcomeFromVerdict(verdict("Fail", 10))).toBe("Failed");
    expect(outcomeFromVerdict(verdict("Fail", 90))).toBe("Failed");
    expect(outcomeFromVerdict(verdict("Blocked", 50))).toBe("Blocked");
  });

  it("never auto-sets on Unknown", () => {
    expect(outcomeFromVerdict(verdict("Unknown", 99))).toBeNull();
  });
});

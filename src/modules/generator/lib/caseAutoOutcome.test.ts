import { describe, expect, it } from "vitest";
import { autoOutcomeForCase, reconcileAutoOutcomes } from "./caseAutoOutcome";
import type { ReviewedBug, ReviewedCase } from "./draftBatchSchema";
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

function mkCase(partial: Partial<ReviewedCase> = {}): ReviewedCase {
  return {
    uid: "c1",
    decision: "keep",
    similarMatches: [],
    title: "A case",
    steps: [],
    ...partial,
  } as ReviewedCase;
}

function mkBug(partial: Partial<ReviewedBug> = {}): ReviewedBug {
  return {
    uid: "b1",
    decision: "keep",
    title: "A bug that is long enough",
    reproSteps: "x",
    severity: "2 - High",
    codeRefs: [],
    linkedDraftCaseIndex: 0,
    ...partial,
  } as ReviewedBug;
}

describe("autoOutcomeForCase", () => {
  it("a kept bug outweighs a confident Pass verdict", () => {
    expect(autoOutcomeForCase(true, verdict("Pass", 99))).toBe("Failed");
  });

  it("falls back to the verdict when there is no bug", () => {
    expect(autoOutcomeForCase(false, verdict("Pass", 99))).toBe("Passed");
    expect(autoOutcomeForCase(false, verdict("Fail", 10))).toBe("Failed");
  });

  it("returns null when there is no bug and no verdict (no crash on undefined)", () => {
    expect(autoOutcomeForCase(false, undefined)).toBeNull();
  });

  it("a bug with no verdict still fails", () => {
    expect(autoOutcomeForCase(true, undefined)).toBe("Failed");
  });
});

describe("reconcileAutoOutcomes", () => {
  it("auto-fails a case that has a kept linked bug", () => {
    const cases = [mkCase()];
    const bugs = [mkBug({ linkedDraftCaseIndex: 0 })];
    const next = reconcileAutoOutcomes(cases, bugs);
    expect(next[0].desiredOutcome).toBe("Failed");
    expect(next[0].outcomeAuto).toBe(true);
  });

  it("uses the verdict when a case has no bug", () => {
    const cases = [mkCase({ verdict: verdict("Pass", 95) })];
    const next = reconcileAutoOutcomes(cases, []);
    expect(next[0].desiredOutcome).toBe("Passed");
    expect(next[0].outcomeAuto).toBe(true);
  });

  it("never overwrites a manual pick (outcomeAuto false)", () => {
    const cases = [mkCase({ desiredOutcome: "Passed", outcomeAuto: false })];
    const bugs = [mkBug({ linkedDraftCaseIndex: 0 })];
    const next = reconcileAutoOutcomes(cases, bugs);
    expect(next[0].desiredOutcome).toBe("Passed");
    expect(next[0].outcomeAuto).toBe(false);
  });

  it("reverts an auto case to unset when its last bug is removed", () => {
    // The case was previously auto-failed; reconcile with no kept bug clears it.
    const cases = [mkCase({ desiredOutcome: "Failed", outcomeAuto: true })];
    const next = reconcileAutoOutcomes(cases, []);
    expect(next[0].desiredOutcome).toBeUndefined();
    expect(next[0].outcomeAuto).toBe(false);
  });

  it("ignores a skipped bug", () => {
    const cases = [mkCase()];
    const bugs = [mkBug({ decision: "skip", linkedDraftCaseIndex: 0 })];
    const next = reconcileAutoOutcomes(cases, bugs);
    expect(next[0].desiredOutcome).toBeUndefined();
  });

  it("only fails the case the bug is linked to", () => {
    const cases = [mkCase({ uid: "c0" }), mkCase({ uid: "c1" })];
    const bugs = [mkBug({ linkedDraftCaseIndex: 1 })];
    const next = reconcileAutoOutcomes(cases, bugs);
    expect(next[0].desiredOutcome).toBeUndefined();
    expect(next[1].desiredOutcome).toBe("Failed");
  });

  it("returns the same array reference when nothing changes", () => {
    const cases = [mkCase()];
    const next = reconcileAutoOutcomes(cases, []);
    expect(next).toBe(cases);
  });

  it("does not rewrite a pristine outcome-less case", () => {
    const c = mkCase();
    const next = reconcileAutoOutcomes([c], []);
    expect(next[0]).toBe(c);
  });
});

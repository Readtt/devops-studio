import { describe, expect, it } from "vitest";
import { buildRefineUserPrompt } from "./qaAnalystRefinePrompt";
import type { ReviewedBug, ReviewedCase } from "./draftBatchSchema";
import type { RefineRound } from "./history";

const kase = (title: string, over: Partial<ReviewedCase> = {}): ReviewedCase =>
  ({
    uid: title,
    title,
    description: "",
    rationale: "",
    decision: "keep",
    steps: [{ action: "do", expected: "done" }],
    tags: [],
    sourceLinks: [],
    similarMatches: [],
    ...over,
  }) as never;

const bug = (title: string, over: Partial<ReviewedBug> = {}): ReviewedBug =>
  ({
    uid: title,
    title,
    decision: "keep",
    reproSteps: "PRECONDITION:\nn/a",
    severity: "3 - Medium",
    codeRefs: [],
    ...over,
  }) as never;

const base = {
  requirements: "Users can bulk-archive contacts.",
  attachments: [],
  coverage: "full" as const,
  suggestBugs: true,
  keptCases: [kase("[Archive] kept")],
  skippedCases: [],
  keptBugs: [],
  skippedBugs: [],
  draftCases: [kase("[Archive] kept")],
  draftBugs: [],
  instruction: "tighten the steps",
};

const round = (over: Partial<RefineRound> = {}): RefineRound => ({
  timestamp: "2026-08-10T10:00:00Z",
  instruction: "add edge cases",
  activityLog: [],
  beforeCases: 1,
  afterCases: 1,
  beforeBugs: 0,
  afterBugs: 0,
  outcome: "ok",
  ...over,
});

describe("buildRefineUserPrompt — round memory", () => {
  it("sends nothing extra on the first round", () => {
    expect(buildRefineUserPrompt(base)).not.toContain("REFINE HISTORY");
  });

  it("carries earlier rounds so a follow-up can be relative to them", () => {
    const prompt = buildRefineUserPrompt({
      ...base,
      refineRounds: [round({ instruction: "add a case for the undo path" })],
    });
    expect(prompt).toContain("REFINE HISTORY");
    expect(prompt).toContain('"add a case for the undo path"');
  });

  it("puts the history before the draft it explains", () => {
    const prompt = buildRefineUserPrompt({ ...base, refineRounds: [round()] });
    expect(prompt.indexOf("REFINE HISTORY")).toBeLessThan(
      prompt.indexOf("Current draft (kept by the user"),
    );
  });

  it("diffs the last round against the WHOLE draft, skipped items included", () => {
    // Pairing only the kept half would report every skipped case as something
    // the last round removed — a lie the model would then act on.
    const prompt = buildRefineUserPrompt({
      ...base,
      keptCases: [kase("[Archive] kept")],
      skippedCases: [kase("[Archive] user skipped this")],
      draftCases: [kase("[Archive] kept"), kase("[Archive] user skipped this")],
      refineRounds: [round()],
      lastRefineSnapshot: {
        cases: [kase("[Archive] kept"), kase("[Archive] user skipped this")],
        bugs: [],
      },
    });
    expect(prompt).not.toContain("removed cases");
  });

  it("reports what the last round actually changed", () => {
    const prompt = buildRefineUserPrompt({
      ...base,
      keptCases: [kase("[Archive] kept"), kase("[Archive] brand new")],
      draftCases: [kase("[Archive] kept"), kase("[Archive] brand new")],
      refineRounds: [round()],
      lastRefineSnapshot: { cases: [kase("[Archive] kept")], bugs: [bug("[A] b")] },
    });
    expect(prompt).toContain('added cases "[Archive] brand new"');
    expect(prompt).toContain('removed bugs "[A] b"');
  });

  // The regression the draft-order fields exist for. A bug links to its parent
  // case by INDEX into the draft's own array; the history block used to resolve
  // that index against a kept-then-skipped concatenation, so skipping any case
  // shifted every later index and reported bugs as "reworked" that no round had
  // touched — under an instruction telling the model not to undo earlier rounds.
  it("resolves a bug's parent case in the draft's order, not kept-then-skipped", () => {
    const cases = [
      kase("[Archive] first"),
      kase("[Archive] skipped", { decision: "skip" }),
      kase("[Archive] parent"),
    ];
    const linked = bug("[A] unchanged", { linkedDraftCaseIndex: 2 });
    const prompt = buildRefineUserPrompt({
      ...base,
      keptCases: [cases[0], cases[2]],
      skippedCases: [cases[1]],
      keptBugs: [linked],
      skippedBugs: [],
      draftCases: cases,
      draftBugs: [linked],
      refineRounds: [round()],
      lastRefineSnapshot: { cases, bugs: [linked] },
    });
    expect(prompt).not.toContain("reworked bugs");
  });
});

import { describe, expect, it } from "vitest";
import { pairCases, renderRefineHistory } from "./refineDiff";
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

const round = (over: Partial<RefineRound> = {}): RefineRound => ({
  timestamp: "2026-08-10T10:00:00Z",
  instruction: "add edge cases",
  activityLog: [],
  beforeCases: 3,
  afterCases: 5,
  beforeBugs: 0,
  afterBugs: 1,
  outcome: "ok",
  ...over,
});

describe("renderRefineHistory", () => {
  it("is empty on a first refine, so that prompt is unchanged", () => {
    expect(
      renderRefineHistory({ rounds: [], cases: [], bugs: [] }),
    ).toBe("");
  });

  it("carries each round's instruction verbatim", () => {
    const block = renderRefineHistory({
      rounds: [
        round({ instruction: "add edge cases" }),
        round({ instruction: "step 3 doesn't match auth.ts, fix it" }),
      ],
      cases: [],
      bugs: [],
    });
    expect(block).toContain('Round 1: "add edge cases"');
    expect(block).toContain(`Round 2: "step 3 doesn't match auth.ts, fix it"`);
    expect(block).toContain("3 → 5 cases, 0 → 1 bugs");
  });

  it("says a round changed nothing when it failed or came back empty", () => {
    const block = renderRefineHistory({
      rounds: [
        round({ outcome: "empty" }),
        round({ outcome: "failed", error: "rate limited" }),
      ],
      cases: [],
      bugs: [],
    });
    expect(block).toContain("returned nothing — the draft was left as it was");
    expect(block).toContain("failed — the draft was left as it was (rate limited)");
  });

  it("describes the newest round by what it changed, not just by counts", () => {
    // The case the user cares about: same count before and after, every case
    // reworked. Counts alone report "3 → 3 cases" and hide the whole round.
    const before = {
      cases: [kase("[Auth] old title"), kase("[Auth] kept", { description: "a" })],
      bugs: [bug("[Auth] stale bug")],
    };
    const block = renderRefineHistory({
      rounds: [round({ beforeCases: 2, afterCases: 2 })],
      lastSnapshot: before,
      cases: [kase("[Auth] new title"), kase("[Auth] kept", { description: "b" })],
      bugs: [bug("[Auth] stale bug", { severity: "1 - Critical" })],
    });
    expect(block).toContain('added cases "[Auth] new title"');
    expect(block).toContain('removed cases "[Auth] old title"');
    expect(block).toContain('reworked cases "[Auth] kept"');
    expect(block).toContain('reworked bugs "[Auth] stale bug"');
  });

  it("only diffs the newest round — older ones have no snapshot", () => {
    const block = renderRefineHistory({
      rounds: [round({ instruction: "first" }), round({ instruction: "second" })],
      lastSnapshot: { cases: [kase("[A] gone")], bugs: [] },
      cases: [],
      bugs: [],
    });
    const firstIdx = block.indexOf('"first"');
    const changedIdx = block.indexOf("changed:");
    expect(block).toContain('removed cases "[A] gone"');
    // The diff line belongs to round 2, so it sits after round 1's entry.
    expect(changedIdx).toBeGreaterThan(firstIdx);
  });

  it("keeps only the most recent rounds and says how many it dropped", () => {
    const rounds = Array.from({ length: 11 }, (_, i) =>
      round({ instruction: `ask ${i + 1}` }),
    );
    const block = renderRefineHistory({ rounds, cases: [], bugs: [] });
    expect(block).toContain("(3 earlier rounds omitted)");
    expect(block).not.toContain('"ask 3"');
    // Numbering stays absolute so a round's label matches the pane's.
    expect(block).toContain('Round 4: "ask 4"');
    expect(block).toContain('Round 11: "ask 11"');
  });

  it("clamps a pasted-preset instruction rather than sending the paragraph", () => {
    const block = renderRefineHistory({
      rounds: [round({ instruction: "x".repeat(600) })],
      cases: [],
      bugs: [],
    });
    expect(block).toContain("…");
    expect(block).not.toContain("x".repeat(300));
  });

  it("tells the model the history is decided, not up for revision", () => {
    const block = renderRefineHistory({ rounds: [round()], cases: [], bugs: [] });
    expect(block).toContain("Do not redo what an earlier round");
    expect(block).toContain("do not quietly revert it");
  });
});

describe("pairCases tag comparison", () => {
  it("does not treat a re-ordered tag list as a change", () => {
    const a = kase("[A] t", { tags: ["smoke", "regression"] });
    const b = kase("[A] t", { tags: ["regression", "smoke"] });
    expect(pairCases([a], [b]).modified).toEqual([]);
  });

  it("distinguishes one two-word tag from two one-word tags", () => {
    // The reason the original joined on a sentinel rather than a space.
    const a = kase("[A] t", { tags: ["needs review"] });
    const b = kase("[A] t", { tags: ["needs", "review"] });
    expect(pairCases([a], [b]).modified).toHaveLength(1);
  });
});

import { describe, expect, it } from "vitest";
import {
  selectedDiffs,
  allDiffsLoaded,
  type CommitReviewSlice,
} from "./useCommitReview";
import type { CommitDiff } from "./gitCommitApi";

// These two selectors are pure (they read only selectedShas + diffBySha), so we
// exercise them with a minimal partial slice rather than the full store.
function diff(sha: string): CommitDiff {
  return {
    sha,
    shortSha: sha.slice(0, 7),
    subject: `commit ${sha}`,
    author: "t",
    date: "2026-01-01",
    isRoot: false,
    isMerge: false,
    files: [],
    rawPatch: "",
    truncated: false,
    headSha: "abcdef0",
  };
}

function slice(
  selectedShas: string[],
  diffBySha: Record<string, CommitDiff>,
): CommitReviewSlice {
  return { selectedShas, diffBySha } as unknown as CommitReviewSlice;
}

describe("selectedDiffs", () => {
  it("returns loaded diffs in selection order", () => {
    const s = slice(["b", "a"], { a: diff("a"), b: diff("b") });
    expect(selectedDiffs(s).map((d) => d.sha)).toEqual(["b", "a"]);
  });

  it("skips selected commits whose diff hasn't loaded", () => {
    const s = slice(["a", "b", "c"], { a: diff("a"), c: diff("c") });
    expect(selectedDiffs(s).map((d) => d.sha)).toEqual(["a", "c"]);
  });

  it("is empty when nothing is selected", () => {
    expect(selectedDiffs(slice([], { a: diff("a") }))).toEqual([]);
  });
});

describe("allDiffsLoaded", () => {
  it("is true only when every selected commit has a diff", () => {
    expect(allDiffsLoaded(slice(["a", "b"], { a: diff("a"), b: diff("b") }))).toBe(
      true,
    );
  });

  it("is false when a selected commit is still missing its diff", () => {
    expect(allDiffsLoaded(slice(["a", "b"], { a: diff("a") }))).toBe(false);
  });

  it("is false when nothing is selected (nothing to run)", () => {
    expect(allDiffsLoaded(slice([], { a: diff("a") }))).toBe(false);
  });
});

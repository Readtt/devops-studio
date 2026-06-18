import { describe, expect, it } from "vitest";
import {
  selectedDiffs,
  allDiffsLoaded,
  orderShas,
  type CommitReviewSlice,
} from "./useCommitReview";
import {
  LOCAL_CHANGES_SHA,
  type CommitDiff,
  type CommitMeta,
} from "./gitCommitApi";

function commit(sha: string): CommitMeta {
  return { sha } as unknown as CommitMeta;
}

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
    isLocal: false,
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

describe("orderShas", () => {
  // Commit list as the picker holds it: newest first.
  const commits = [commit("aaa"), commit("bbb"), commit("ccc")];

  it("orders selected commits to match the commit list (newest first)", () => {
    expect(orderShas(["ccc", "aaa"], commits)).toEqual(["aaa", "ccc"]);
  });

  it("pins Local changes ahead of every commit", () => {
    expect(orderShas(["bbb", LOCAL_CHANGES_SHA, "aaa"], commits)).toEqual([
      LOCAL_CHANGES_SHA,
      "aaa",
      "bbb",
    ]);
  });

  it("dedupes repeated shas (incl. the local sentinel)", () => {
    expect(
      orderShas(["aaa", "aaa", LOCAL_CHANGES_SHA, LOCAL_CHANGES_SHA], commits),
    ).toEqual([LOCAL_CHANGES_SHA, "aaa"]);
  });

  it("sorts unknown shas (rebased-away commits) last", () => {
    expect(orderShas(["zzz", "bbb"], commits)).toEqual(["bbb", "zzz"]);
  });
});

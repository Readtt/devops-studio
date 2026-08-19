import { describe, expect, it } from "vitest";
import {
  selectedDiffs,
  allDiffsLoaded,
  orderShas,
  type CommitReviewSlice,
} from "./useCommitReview";
import {
  commitKey,
  isLocalKey,
  splitCommitKey,
  LOCAL_CHANGES_SHA,
  type RepoCommitDiff,
  type RepoCommitMeta,
} from "./gitCommitApi";

function commit(sha: string, repoId = "r1"): RepoCommitMeta {
  return { sha, repoId, repoName: repoId } as unknown as RepoCommitMeta;
}

// These two selectors are pure (they read only selectedShas + diffBySha), so we
// exercise them with a minimal partial slice rather than the full store.
function diff(sha: string, repoId = "r1"): RepoCommitDiff {
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
    repoId,
    repoName: repoId,
  };
}

function slice(
  selectedShas: string[],
  diffBySha: Record<string, RepoCommitDiff>,
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

describe("commit keys", () => {
  it("round-trips a repo + sha", () => {
    expect(splitCommitKey(commitKey("r1", "abc"), "fallback")).toEqual({
      repoId: "r1",
      sha: "abc",
    });
  });

  // Persisted tabs and saved rows from the single-root era hold bare shas.
  it("reads a bare sha as belonging to the fallback repo", () => {
    expect(splitCommitKey("abc", "r1")).toEqual({ repoId: "r1", sha: "abc" });
  });

  it("recognises every repo's local sentinel, and only it", () => {
    expect(isLocalKey(commitKey("r2", LOCAL_CHANGES_SHA))).toBe(true);
    expect(isLocalKey(LOCAL_CHANGES_SHA)).toBe(true);
    expect(isLocalKey(commitKey("r2", "abc"))).toBe(false);
    // A commit whose sha merely CONTAINS the sentinel isn't one.
    expect(isLocalKey(commitKey("r2", "localish"))).toBe(false);
  });
});

describe("orderShas", () => {
  // Merged commit list as the picker holds it: newest first, repos interleaved.
  const commits = [
    commit("aaa", "r1"),
    commit("bbb", "r2"),
    commit("ccc", "r1"),
  ];
  const repoIds = ["r1", "r2"];
  const k = commitKey;

  it("orders selected commits to match the merged list (newest first)", () => {
    expect(orderShas([k("r1", "ccc"), k("r1", "aaa")], commits, repoIds)).toEqual([
      k("r1", "aaa"),
      k("r1", "ccc"),
    ]);
  });

  it("interleaves repos by the merged list's order, not by repo", () => {
    expect(
      orderShas([k("r1", "ccc"), k("r2", "bbb"), k("r1", "aaa")], commits, repoIds),
    ).toEqual([k("r1", "aaa"), k("r2", "bbb"), k("r1", "ccc")]);
  });

  it("pins every repo's Local changes ahead of every commit, in repo order", () => {
    expect(
      orderShas(
        [
          k("r2", "bbb"),
          k("r2", LOCAL_CHANGES_SHA),
          k("r1", LOCAL_CHANGES_SHA),
          k("r1", "aaa"),
        ],
        commits,
        repoIds,
      ),
    ).toEqual([
      k("r1", LOCAL_CHANGES_SHA),
      k("r2", LOCAL_CHANGES_SHA),
      k("r1", "aaa"),
      k("r2", "bbb"),
    ]);
  });

  it("dedupes repeated keys (incl. the local sentinel)", () => {
    expect(
      orderShas(
        [
          k("r1", "aaa"),
          k("r1", "aaa"),
          k("r1", LOCAL_CHANGES_SHA),
          k("r1", LOCAL_CHANGES_SHA),
        ],
        commits,
        repoIds,
      ),
    ).toEqual([k("r1", LOCAL_CHANGES_SHA), k("r1", "aaa")]);
  });

  // The same sha in two repos is two different changes.
  it("keeps one sha's two repos apart", () => {
    const shared = [commit("aaa", "r1"), commit("aaa", "r2")];
    expect(
      orderShas([k("r2", "aaa"), k("r1", "aaa")], shared, repoIds),
    ).toEqual([k("r1", "aaa"), k("r2", "aaa")]);
  });

  it("sorts unknown keys (rebased-away commits) last", () => {
    expect(orderShas([k("r1", "zzz"), k("r2", "bbb")], commits, repoIds)).toEqual([
      k("r2", "bbb"),
      k("r1", "zzz"),
    ]);
  });
});

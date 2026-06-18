import { describe, expect, it } from "vitest";
import {
  buildInvestigatePrompt,
  combinedPatchBytes,
  isOldCommit,
  COMBINED_DIFF_WARN_BYTES,
} from "./runCommitReview";
import type { CommitDiff } from "./gitCommitApi";

function diff(rawPatch: string, over: Partial<CommitDiff> = {}): CommitDiff {
  return {
    sha: "x",
    shortSha: "x",
    subject: "s",
    author: "a",
    date: "d",
    isRoot: false,
    isMerge: false,
    isLocal: false,
    files: [],
    rawPatch,
    truncated: false,
    headSha: "h",
    ...over,
  };
}

function investigate(diffs: CommitDiff[]): string {
  // Only diffs / contextBlocks / sourceRoot are read by the prompt builder.
  return buildInvestigatePrompt({
    diffs,
    contextBlocks: [],
    sourceRoot: "C:/repo",
  } as unknown as Parameters<typeof buildInvestigatePrompt>[0]);
}

describe("combinedPatchBytes", () => {
  it("sums the raw-patch sizes across commits", () => {
    expect(combinedPatchBytes([diff("abc"), diff("de")])).toBe(5);
    expect(combinedPatchBytes([])).toBe(0);
  });

  it("one max-size commit stays under the warn threshold; several exceed it", () => {
    const maxPatch = "x".repeat(30 * 1024); // PATCH_MAX_BYTES (git.rs)
    expect(combinedPatchBytes([diff(maxPatch)])).toBeLessThan(
      COMBINED_DIFF_WARN_BYTES,
    );
    expect(
      combinedPatchBytes([
        diff(maxPatch),
        diff(maxPatch),
        diff(maxPatch),
        diff(maxPatch),
      ]),
    ).toBeGreaterThan(COMBINED_DIFF_WARN_BYTES);
  });

  it("counts UTF-8 bytes, not UTF-16 code units, for multibyte diffs", () => {
    // Each "é" is 1 UTF-16 code unit but 2 UTF-8 bytes; "🚀" is 2 code units
    // but 4 bytes. .length would under-count what the Rust byte cap measures.
    const multibyte = "ééé🚀"; // length 5, bytes 10
    expect(multibyte.length).toBe(5);
    expect(combinedPatchBytes([diff(multibyte)])).toBe(10);
    expect(combinedPatchBytes([diff(multibyte)])).toBeGreaterThan(
      multibyte.length,
    );
  });
});

describe("isOldCommit", () => {
  it("is true when a commit's short sha differs from the current head", () => {
    expect(isOldCommit(diff("", { shortSha: "1111111", headSha: "2222222" }))).toBe(
      true,
    );
  });

  it("is false for the local-changes diff even when headSha differs", () => {
    // The working-tree diff is always against the live HEAD, so it must never
    // be flagged as predating the tree.
    expect(
      isOldCommit(
        diff("", { isLocal: true, shortSha: "local", headSha: "2222222" }),
      ),
    ).toBe(false);
  });

  it("is false when the commit IS the current head (7-char prefix match)", () => {
    expect(isOldCommit(diff("", { shortSha: "abc1234", headSha: "abc1234f" }))).toBe(
      false,
    );
  });
});

describe("buildInvestigatePrompt", () => {
  it("labels a single local-changes diff as the working tree, not a commit", () => {
    const out = investigate([
      diff("@@ -0,0 +1 @@\n+x", {
        isLocal: true,
        shortSha: "local",
        headSha: "abc1234",
      }),
    ]);
    expect(out).toContain("uncommitted local changes");
    expect(out).toContain("RAW PATCH (all uncommitted changes)");
    // A live diff is never "old", so the head-moved warning must not appear.
    expect(out).not.toContain("predate the working tree");
  });

  it("warns when a reviewed commit predates the working tree", () => {
    const out = investigate([
      diff("@@ @@", { shortSha: "1111111", headSha: "2222222" }),
    ]);
    expect(out).toContain("predate the working tree");
    expect(out).toContain("**Commit:**");
  });
});

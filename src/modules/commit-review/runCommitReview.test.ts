import { describe, expect, it } from "vitest";
import { combinedPatchBytes, COMBINED_DIFF_WARN_BYTES } from "./runCommitReview";
import type { CommitDiff } from "./gitCommitApi";

function diff(rawPatch: string): CommitDiff {
  return {
    sha: "x",
    shortSha: "x",
    subject: "s",
    author: "a",
    date: "d",
    isRoot: false,
    isMerge: false,
    files: [],
    rawPatch,
    truncated: false,
    headSha: "h",
  };
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

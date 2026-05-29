import { describe, expect, it } from "vitest";
import { bugParentCaseUid } from "./bugLinking";

const cases = [{ uid: "A" }, { uid: "B" }, { uid: "C" }];

describe("bugParentCaseUid", () => {
  it("resolves the parent by index into the full cases array", () => {
    expect(bugParentCaseUid(0, cases)).toBe("A");
    expect(bugParentCaseUid(2, cases)).toBe("C");
  });

  it("regression: stays correct when an earlier case is skipped", () => {
    // The bug points at case C (index 2 in the full array). Skipping case A
    // shrinks the *kept* array to [B, C]; the old publish code did
    // keptCases[2] === undefined and dropped the link. Resolving through the
    // full array must still yield C.
    expect(bugParentCaseUid(2, cases)).toBe("C");
  });

  it("returns null for unlinked or out-of-range indices", () => {
    expect(bugParentCaseUid(null, cases)).toBeNull();
    expect(bugParentCaseUid(undefined, cases)).toBeNull();
    expect(bugParentCaseUid(-1, cases)).toBeNull();
    expect(bugParentCaseUid(3, cases)).toBeNull();
    expect(bugParentCaseUid(0, [])).toBeNull();
  });
});

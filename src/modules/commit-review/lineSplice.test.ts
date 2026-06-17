import { describe, expect, it } from "vitest";
import { spliceLines, sliceLinesText } from "./lineSplice";

describe("spliceLines", () => {
  it("replaces a line in the middle without touching the rest", () => {
    expect(spliceLines("a\nb\nc", 2, 2, "B")).toBe("a\nB\nc");
  });

  it("preserves the file's terminating newline when the edit reaches EOF", () => {
    // Regression: the old truthiness-gated reconstruction dropped the empty
    // trailing segment, silently stripping the final newline → on-disk churn.
    expect(spliceLines("foo\n", 1, 1, "bar")).toBe("bar\n");
    expect(spliceLines("a\nb\nc\n", 3, 3, "C")).toBe("a\nb\nC\n");
  });

  it("keeps genuine trailing blank lines when the edit reaches EOF", () => {
    expect(spliceLines("a\nb\n\n\n", 2, 2, "B")).toBe("a\nB\n\n\n");
  });

  it("inserts (endLine < startLine) without deleting any line", () => {
    expect(spliceLines("a\nb\nc", 2, 1, "X")).toBe("a\nX\nb\nc");
    // prepend before line 1
    expect(spliceLines("a\nb", 1, 0, "X")).toBe("X\na\nb");
  });

  it("supports multi-line replacement text", () => {
    expect(spliceLines("a\nb\nc", 2, 2, "X\nY")).toBe("a\nX\nY\nc");
  });

  it("clamps an out-of-range endLine to the end of the file", () => {
    expect(spliceLines("a\nb", 1, 99, "Z")).toBe("Z");
  });
});

describe("sliceLinesText", () => {
  it("returns the inclusive line range as text", () => {
    expect(sliceLinesText("a\nb\nc\nd", 2, 3)).toBe("b\nc");
  });

  it("returns empty for an insert range (endLine < startLine)", () => {
    expect(sliceLinesText("a\nb\nc", 2, 1)).toBe("");
  });

  it("round-trips: replacing a slice with itself is a no-op", () => {
    // The previewed 'before' text and the applied 'after' must agree, so
    // replacing sliceLinesText(range) back over the same range must restore the
    // source exactly — including the trailing newline.
    const src = "one\ntwo\nthree\n";
    const before = sliceLinesText(src, 2, 2);
    expect(spliceLines(src, 2, 2, before)).toBe(src);
  });
});

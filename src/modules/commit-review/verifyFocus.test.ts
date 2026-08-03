import { describe, expect, it } from "vitest";
import {
  focusPathsFromCandidates,
  focusPatchOnFiles,
  VERIFY_FOCUS_MIN_BYTES,
} from "./verifyFocus";
import type { CandidateFinding } from "./schema";

function section(path: string, bodyBytes: number): string {
  return [
    `diff --git a/${path} b/${path}`,
    "index 1111111..2222222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1,3 +1,3 @@",
    `+${"x".repeat(bodyBytes)}`,
  ].join("\n");
}

function patch(...sections: string[]): string {
  return sections.join("\n");
}

function cand(over: Partial<CandidateFinding> = {}): CandidateFinding {
  return {
    id: "f1",
    title: "t",
    category: "correctness",
    severity: "high",
    file: "src/a.ts",
    startLine: 1,
    endLine: 2,
    explanation: "e",
    evidence: "",
    confidence: "medium",
    ...over,
  };
}

describe("focusPathsFromCandidates", () => {
  it("collects the cited file AND wherever a suggested fix would land", () => {
    const paths = focusPathsFromCandidates([
      cand({ file: "src/a.ts" }),
      cand({
        id: "f2",
        file: "src/b.ts",
        suggestedFix: {
          path: "src/c.ts",
          startLine: 1,
          endLine: 1,
          replacement: "",
        },
      }),
    ]);
    expect(new Set(paths)).toEqual(new Set(["src/a.ts", "src/b.ts", "src/c.ts"]));
  });

  it("de-duplicates", () => {
    expect(
      focusPathsFromCandidates([cand(), cand({ id: "f2" })]),
    ).toEqual(["src/a.ts"]);
  });
});

describe("focusPatchOnFiles", () => {
  const big = () =>
    patch(
      section("src/a.ts", VERIFY_FOCUS_MIN_BYTES),
      section("src/b.ts", VERIFY_FOCUS_MIN_BYTES),
      section("src/c.ts", VERIFY_FOCUS_MIN_BYTES),
    );

  it("keeps only the cited files' hunks and names what it dropped", () => {
    const raw = big();
    const focused = focusPatchOnFiles(raw, ["src/b.ts"]);

    expect(focused).not.toBeNull();
    expect(focused!.text).toContain("diff --git a/src/b.ts");
    expect(focused!.text).not.toContain("diff --git a/src/a.ts");
    expect(focused!.text).not.toContain("diff --git a/src/c.ts");
    expect(focused!.omitted).toEqual(["src/a.ts", "src/c.ts"]);
    expect(focused!.text.length).toBeLessThan(raw.length);
  });

  it("keeps the FULL hunk for a kept file, not a clip of it", () => {
    const one = section("src/b.ts", VERIFY_FOCUS_MIN_BYTES);
    const focused = focusPatchOnFiles(
      patch(section("src/a.ts", VERIFY_FOCUS_MIN_BYTES), one),
      ["src/b.ts"],
    );
    expect(focused!.text).toContain(one);
  });

  // Every one of these returns null, meaning "send the patch unchanged". The
  // narrowing must never be the reason a verify pass gets worse.
  describe("refuses to narrow", () => {
    it("on a small patch — the omission note would cost more than it frees", () => {
      const small = patch(section("src/a.ts", 100), section("src/b.ts", 100));
      expect(small.length).toBeLessThan(VERIFY_FOCUS_MIN_BYTES);
      expect(focusPatchOnFiles(small, ["src/a.ts"])).toBeNull();
    });

    it("when nothing cited is in the patch — a verifier with an empty diff is blind", () => {
      // A finding about a caller the commit never touched is legitimate.
      expect(focusPatchOnFiles(big(), ["src/somewhere/else.ts"])).toBeNull();
    });

    it("when there is nothing to drop", () => {
      expect(
        focusPatchOnFiles(big(), ["src/a.ts", "src/b.ts", "src/c.ts"]),
      ).toBeNull();
    });

    it("on a single-file patch", () => {
      expect(
        focusPatchOnFiles(section("src/a.ts", VERIFY_FOCUS_MIN_BYTES * 2), [
          "src/a.ts",
        ]),
      ).toBeNull();
    });

    it("with no candidate paths at all", () => {
      expect(focusPatchOnFiles(big(), [])).toBeNull();
    });

    it("on text that isn't a git patch", () => {
      expect(
        focusPatchOnFiles("z".repeat(VERIFY_FOCUS_MIN_BYTES * 2), ["src/a.ts"]),
      ).toBeNull();
    });
  });

  it("distinguishes a file from its same-directory siblings", () => {
    const raw = patch(
      section("src/modules/ai/lib/taskRunner.ts", VERIFY_FOCUS_MIN_BYTES),
      section("src/modules/ai/lib/taskRunner.test.ts", VERIFY_FOCUS_MIN_BYTES),
      section("src/other.ts", VERIFY_FOCUS_MIN_BYTES),
    );
    const focused = focusPatchOnFiles(raw, [
      "src/modules/ai/lib/taskRunner.test.ts",
    ]);
    expect(focused!.omitted).toEqual([
      "src/modules/ai/lib/taskRunner.ts",
      "src/other.ts",
    ]);
  });

  // The substring match is deliberately generous, and this is what that costs:
  // a cited path that happens to be a suffix of another changed path keeps
  // both. That's the safe direction — an extra hunk is a few hundred wasted
  // tokens; a missing one is a verifier judging code it can't see.
  it("errs toward keeping a file when a path is ambiguous", () => {
    const raw = patch(
      section("src/a.ts", VERIFY_FOCUS_MIN_BYTES),
      section("vendor/src/a.ts", VERIFY_FOCUS_MIN_BYTES),
      section("src/other.ts", VERIFY_FOCUS_MIN_BYTES),
    );
    expect(focusPatchOnFiles(raw, ["src/a.ts"])!.omitted).toEqual([
      "src/other.ts",
    ]);
  });

  it("keeps a rename section when either side of the rename is cited", () => {
    const rename = [
      "diff --git a/src/old.ts b/src/new.ts",
      "similarity index 90%",
      "rename from src/old.ts",
      "rename to src/new.ts",
      `+${"x".repeat(VERIFY_FOCUS_MIN_BYTES)}`,
    ].join("\n");
    const raw = patch(rename, section("src/other.ts", VERIFY_FOCUS_MIN_BYTES));
    expect(focusPatchOnFiles(raw, ["src/old.ts"])!.omitted).toEqual([
      "src/other.ts",
    ]);
    expect(focusPatchOnFiles(raw, ["src/new.ts"])!.omitted).toEqual([
      "src/other.ts",
    ]);
  });

  it("preserves any preamble ahead of the first file section", () => {
    const raw = `commit abc123\nAuthor: someone\n\n${big()}`;
    const focused = focusPatchOnFiles(raw, ["src/a.ts"]);
    expect(focused!.text.startsWith("commit abc123")).toBe(true);
  });
});

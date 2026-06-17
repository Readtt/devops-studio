import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "./unifiedDiff";

describe("parseUnifiedDiff", () => {
  it("returns [] for empty input", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });

  it("parses a simple modification with correct line numbers", () => {
    const patch = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "index 1111111..2222222 100644",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,4 +1,4 @@",
      " const a = 1;",
      "-const b = 2;",
      "+const b = 3;",
      " const c = 4;",
      " const d = 5;",
    ].join("\n");

    const files = parseUnifiedDiff(patch);
    expect(files).toHaveLength(1);
    const f = files[0];
    expect(f.path).toBe("src/foo.ts");
    expect(f.status).toBe("modified");
    expect(f.isBinary).toBe(false);
    expect(f.additions).toBe(1);
    expect(f.deletions).toBe(1);
    expect(f.hunks).toHaveLength(1);

    const lines = f.hunks[0].lines;
    expect(lines).toEqual([
      { kind: "context", oldLine: 1, newLine: 1, text: "const a = 1;" },
      { kind: "del", oldLine: 2, newLine: null, text: "const b = 2;" },
      { kind: "add", oldLine: null, newLine: 2, text: "const b = 3;" },
      { kind: "context", oldLine: 3, newLine: 3, text: "const c = 4;" },
      { kind: "context", oldLine: 4, newLine: 4, text: "const d = 5;" },
    ]);
  });

  it("parses an added file (--- /dev/null) with null old line numbers", () => {
    const patch = [
      "diff --git a/new.txt b/new.txt",
      "new file mode 100644",
      "index 0000000..3333333",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1,2 @@",
      "+hello",
      "+world",
    ].join("\n");

    const f = parseUnifiedDiff(patch)[0];
    expect(f.status).toBe("added");
    expect(f.path).toBe("new.txt");
    expect(f.additions).toBe(2);
    expect(f.deletions).toBe(0);
    expect(f.hunks[0].lines.map((l) => l.newLine)).toEqual([1, 2]);
    expect(f.hunks[0].lines.every((l) => l.oldLine === null)).toBe(true);
  });

  it("parses a deleted file (+++ /dev/null)", () => {
    const patch = [
      "diff --git a/gone.txt b/gone.txt",
      "deleted file mode 100644",
      "index 4444444..0000000",
      "--- a/gone.txt",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-bye",
      "-now",
    ].join("\n");

    const f = parseUnifiedDiff(patch)[0];
    expect(f.status).toBe("deleted");
    expect(f.path).toBe("gone.txt");
    expect(f.deletions).toBe(2);
    expect(f.additions).toBe(0);
  });

  it("parses a rename with old → new paths and the hunk heading", () => {
    const patch = [
      "diff --git a/old/name.ts b/new/name.ts",
      "similarity index 92%",
      "rename from old/name.ts",
      "rename to new/name.ts",
      "index 5555555..6666666 100644",
      "--- a/old/name.ts",
      "+++ b/new/name.ts",
      "@@ -10,3 +10,3 @@ export function x() {",
      "   return 1;",
      "-  // old",
      "+  // new",
    ].join("\n");

    const f = parseUnifiedDiff(patch)[0];
    expect(f.status).toBe("renamed");
    expect(f.oldPath).toBe("old/name.ts");
    expect(f.path).toBe("new/name.ts");
    expect(f.hunks[0].oldStart).toBe(10);
    expect(f.hunks[0].newStart).toBe(10);
    expect(f.hunks[0].header).toContain("export function x() {");
    // Context line keeps both numbers; the - / + lines advance independently.
    expect(f.hunks[0].lines[0]).toEqual({
      kind: "context",
      oldLine: 10,
      newLine: 10,
      text: "  return 1;",
    });
  });

  it("captures both sides of a copy (copy from / copy to)", () => {
    const patch = [
      "diff --git a/original.txt b/copy.txt",
      "similarity index 100%",
      "copy from original.txt",
      "copy to copy.txt",
    ].join("\n");

    const f = parseUnifiedDiff(patch)[0];
    expect(f.oldPath).toBe("original.txt");
    expect(f.path).toBe("copy.txt");
    expect(f.status).toBe("renamed");
  });

  it("flags a binary file and produces no hunks", () => {
    const patch = [
      "diff --git a/img.png b/img.png",
      "new file mode 100644",
      "index 0000000..7777777",
      "Binary files /dev/null and b/img.png differ",
    ].join("\n");

    const f = parseUnifiedDiff(patch)[0];
    expect(f.isBinary).toBe(true);
    expect(f.status).toBe("added");
    expect(f.path).toBe("img.png");
    expect(f.hunks).toHaveLength(0);
  });

  it("parses multiple files and multiple hunks in one patch", () => {
    const patch = [
      "diff --git a/one.ts b/one.ts",
      "index aaa..bbb 100644",
      "--- a/one.ts",
      "+++ b/one.ts",
      "@@ -1,2 +1,2 @@",
      " keep",
      "-drop1",
      "+add1",
      "@@ -10,2 +10,3 @@",
      " ctx",
      "+add2",
      " ctx2",
      "diff --git a/two.ts b/two.ts",
      "index ccc..ddd 100644",
      "--- a/two.ts",
      "+++ b/two.ts",
      "@@ -5,1 +5,1 @@",
      "-old",
      "+new",
    ].join("\n");

    const files = parseUnifiedDiff(patch);
    expect(files.map((f) => f.path)).toEqual(["one.ts", "two.ts"]);
    expect(files[0].hunks).toHaveLength(2);
    expect(files[0].hunks[1].lines.find((l) => l.kind === "add")).toMatchObject({
      newLine: 11,
      text: "add2",
    });
    expect(files[0].additions).toBe(2);
    expect(files[0].deletions).toBe(1);
    expect(files[1].hunks[0].lines).toEqual([
      { kind: "del", oldLine: 5, newLine: null, text: "old" },
      { kind: "add", oldLine: null, newLine: 5, text: "new" },
    ]);
  });

  it("tolerates a truncated tail without throwing", () => {
    const patch = [
      "diff --git a/big.ts b/big.ts",
      "index a..b 100644",
      "--- a/big.ts",
      "+++ b/big.ts",
      "@@ -1,3 +1,3 @@",
      " line1",
      "-line2",
      "+line2x",
      "[... truncated for size; full diff available via the Diff tool ...]",
    ].join("\n");

    const files = parseUnifiedDiff(patch);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("big.ts");
    expect(files[0].additions).toBe(1);
    expect(files[0].deletions).toBe(1);
    // The marker line is dropped, not parsed as a diff line.
    expect(files[0].hunks[0].lines).toHaveLength(3);
  });

  it("strips CRLF carriage returns from line content", () => {
    const patch = [
      "diff --git a/win.ts b/win.ts",
      "index a..b 100644",
      "--- a/win.ts",
      "+++ b/win.ts",
      "@@ -1,2 +1,2 @@",
      " kept\r",
      "-old\r",
      "+new\r",
    ].join("\n");

    const f = parseUnifiedDiff(patch)[0];
    expect(f.hunks[0].lines.map((l) => l.text)).toEqual(["kept", "old", "new"]);
  });

  it("preserves a genuinely blank context line", () => {
    const patch = [
      "diff --git a/blank.ts b/blank.ts",
      "index a..b 100644",
      "--- a/blank.ts",
      "+++ b/blank.ts",
      "@@ -1,3 +1,3 @@",
      " a",
      " ", // blank line in the file: a single leading space, empty content
      "-b",
      "+c",
    ].join("\n");

    const f = parseUnifiedDiff(patch)[0];
    expect(f.hunks[0].lines[1]).toEqual({
      kind: "context",
      oldLine: 2,
      newLine: 2,
      text: "",
    });
  });
});

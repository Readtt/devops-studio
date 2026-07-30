import { describe, expect, it } from "vitest";
import { formatToolResult, summarizeToolInput } from "./activityLog";

// `list_files` (suite-chat tools → Rust `fs_list_files`) returns
// `{ files: string[] }`. The formatter used to read `.entries` — the shape of
// the *other* listing tool — so every call rendered "0 entries" no matter what
// came back, which read as "the AI found nothing".
describe("formatToolResult · list_files", () => {
  it("reports the files the tool actually returned", () => {
    const r = formatToolResult("list_files", {
      files: ["src/a.ts", "src/b.ts"],
      truncated: false,
    });
    expect(r.summary).toBe("2 files");
    expect(r.text).toBe("src/a.ts\nsrc/b.ts");
  });

  it("marks a truncated listing", () => {
    const r = formatToolResult("list_files", {
      files: ["src/a.ts", "src/b.ts"],
      truncated: true,
    });
    expect(r.summary).toBe("2+ files");
  });

  it("counts a single file in the singular", () => {
    const r = formatToolResult("list_files", {
      files: ["src/a.ts"],
      truncated: false,
    });
    expect(r.summary).toBe("1 file");
  });

  it("says so when the listing really was empty", () => {
    const r = formatToolResult("list_files", { files: [], truncated: false });
    expect(r.summary).toBe("0 files");
    expect(r.text).toBe("(no files)");
  });

  it("surfaces a tool-level error over the file count", () => {
    const r = formatToolResult("list_files", {
      error: "not a directory: /repo/nope",
    });
    expect(r.summary).toContain("not a directory");
  });
});

// The sibling tool in ai/tools/fs.ts returns `{ entries: [{name, kind}] }`.
// Two similar names, two different shapes — both must keep working.
describe("formatToolResult · list_directory", () => {
  it("still formats the entries shape with a trailing slash on dirs", () => {
    const r = formatToolResult("list_directory", {
      entries: [
        { name: "src", kind: "dir" },
        { name: "a.ts", kind: "file" },
      ],
    });
    expect(r.summary).toBe("2 entries");
    expect(r.text).toBe("src/\na.ts");
  });

  it("uses the singular for one entry", () => {
    const r = formatToolResult("list_directory", {
      entries: [{ name: "a.ts", kind: "file" }],
    });
    expect(r.summary).toBe("1 entry");
  });
});

describe("summarizeToolInput · list_files", () => {
  it("labels the call with its subpath", () => {
    expect(summarizeToolInput("list_files", { subpath: "src/auth" })).toBe(
      "src/auth",
    );
  });

  // Used to fall through to the tool name, rendering "list_files list_files".
  it("says root rather than repeating the tool name", () => {
    expect(summarizeToolInput("list_files", {})).toBe("(root)");
  });

  it("says root for an empty subpath", () => {
    expect(summarizeToolInput("list_files", { subpath: "" })).toBe("(root)");
  });

  // The tool now lists the root for a quoted-empty subpath, so the label has to
  // agree — showing `""` next to a full listing reads as a mismatch.
  it("says root for a quoted-empty subpath, matching what the tool lists", () => {
    expect(summarizeToolInput("list_files", { subpath: '""' })).toBe("(root)");
  });

  it("strips surrounding quotes off a real subpath", () => {
    expect(summarizeToolInput("list_files", { subpath: '"src/auth"' })).toBe(
      "src/auth",
    );
  });
});

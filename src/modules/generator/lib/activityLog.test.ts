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

// `glob` is a string[] in the suite-chat schema, but summarizeToolInput's
// `get()` only returns strings — so the filter was silently dropped and every
// grep row showed a bare pattern. That made "0 files scanned" (which means the
// glob excluded everything) impossible to diagnose from the UI.
describe("summarizeToolInput · grep", () => {
  it("shows an array glob alongside the pattern", () => {
    expect(
      summarizeToolInput("grep", {
        pattern: "class Foo",
        glob: ["**/*.cs", "**/*.razor"],
      }),
    ).toBe("class Foo (**/*.cs, **/*.razor)");
  });

  it("still shows a string glob", () => {
    expect(
      summarizeToolInput("grep", { pattern: "class Foo", glob: "**/*.cs" }),
    ).toBe("class Foo (**/*.cs)");
  });

  it("shows the bare pattern when no glob is set", () => {
    expect(summarizeToolInput("grep", { pattern: "class Foo" })).toBe(
      "class Foo",
    );
  });

  it("ignores an empty glob array", () => {
    expect(summarizeToolInput("grep", { pattern: "class Foo", glob: [] })).toBe(
      "class Foo",
    );
  });
});

describe("summarizeToolInput · run_command", () => {
  it("shows the command", () => {
    expect(
      summarizeToolInput("run_command", { command: "git log --oneline -5" }),
    ).toBe("git log --oneline -5");
  });
});

// Pins each tool's result shape against the Rust struct that produces it, so a
// field rename can't silently blank the strip the way `files`/`entries` did.
describe("formatToolResult · wire shapes", () => {
  it("formats grep's hits and files_scanned", () => {
    const r = formatToolResult("grep", {
      hits: [{ rel: "src/a.cs", line: 12, text: "class Foo {" }],
      files_scanned: 1760,
      truncated: false,
    });
    expect(r.summary).toBe("1 match · 1760 files scanned");
    expect(r.text).toBe("src/a.cs:12: class Foo {");
  });

  // "0 files scanned" already states it precisely; what was missing is *why*.
  // The hint goes in the expandable body, where there's room for the reason.
  it("shows the hint instead of a bare (no matches) when nothing was scanned", () => {
    const r = formatToolResult("grep", {
      hits: [],
      files_scanned: 0,
      truncated: false,
      hint: "Your `glob` matched no files, so nothing was searched.",
    });
    expect(r.summary).toBe("0 matches · 0 files scanned");
    expect(r.text).toBe("Your `glob` matched no files, so nothing was searched.");
  });

  it("still says (no matches) when files were scanned and none matched", () => {
    const r = formatToolResult("grep", {
      hits: [],
      files_scanned: 1760,
      truncated: false,
    });
    expect(r.text).toBe("(no matches)");
  });

  it("formats run_command's returncode and output", () => {
    const r = formatToolResult("run_command", {
      returncode: 0,
      output: "abc123 fix: thing",
      truncated: false,
    });
    expect(r.summary).toBe("exit 0");
    expect(r.text).toBe("abc123 fix: thing");
  });

  it("formats read_file's content and totals", () => {
    const r = formatToolResult("read_file", {
      path: "src/a.ts",
      content: "export {}",
      size: 9,
      total_lines: 1,
    });
    expect(r.summary).toBe("1 line · 9 B");
    expect(r.text).toBe("export {}");
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

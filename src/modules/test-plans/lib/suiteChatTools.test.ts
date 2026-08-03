import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));

import {
  buildSuiteChatTools,
  capToolResult,
  clipAroundMatch,
  TOOL_RESULT_CAP,
} from "./suiteChatTools";

const ROOT = "C:\\Users\\mudas\\source\\repos\\iSyncKit";

/** The AI SDK's `tool()` is an identity helper, so `execute` is directly
 *  callable — but its typed signature wants the SDK's call options, which the
 *  implementations ignore. Cast to the shape we actually exercise. */
function callTool(name: string, args: unknown) {
  const tools = buildSuiteChatTools(ROOT);
  if (!tools) throw new Error("expected tools for a non-null source root");
  const t = (tools as Record<string, unknown>)[name] as {
    execute: (a: unknown) => Promise<unknown>;
  };
  if (!t) throw new Error(`no such tool: ${name}`);
  return t.execute(args);
}

function lastPayload<T>(): T {
  const calls = invoke.mock.calls;
  if (calls.length === 0) throw new Error("invoke was never called");
  return calls[calls.length - 1][1] as T;
}

function rootArg(): string {
  return lastPayload<{ root: string }>().root;
}

function pathArg(): string {
  return lastPayload<{ path: string }>().path;
}

describe("list_files · subpath sanitizing", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue({ files: [], truncated: false });
  });

  // The bug from the field: a model wrote `subpath: "\"\""` to mean "empty",
  // which was truthy, got joined verbatim, and the Rust side answered
  // `not a directory: <root>\""`.
  it("treats a quoted-empty subpath as the root", async () => {
    await callTool("list_files", { subpath: '""' });
    expect(rootArg()).toBe(ROOT);
  });

  it("treats a single-quoted-empty subpath as the root", async () => {
    await callTool("list_files", { subpath: "''" });
    expect(rootArg()).toBe(ROOT);
  });

  it("treats a whitespace-only subpath as the root", async () => {
    await callTool("list_files", { subpath: "   " });
    expect(rootArg()).toBe(ROOT);
  });

  it("treats an omitted subpath as the root", async () => {
    await callTool("list_files", {});
    expect(rootArg()).toBe(ROOT);
  });

  it("strips surrounding quotes off a real subpath", async () => {
    await callTool("list_files", { subpath: '"src/auth"' });
    expect(rootArg()).toBe(`${ROOT}\\src/auth`);
  });

  it("still joins an ordinary subpath", async () => {
    await callTool("list_files", { subpath: "src/auth" });
    expect(rootArg()).toBe(`${ROOT}\\src/auth`);
  });

  it("returns the error to the model instead of throwing", async () => {
    invoke.mockRejectedValue("not a directory: nope");
    const out = await callTool("list_files", { subpath: "nope" });
    expect(out).toEqual({ error: "not a directory: nope", subpath: "nope" });
  });
});

// `files_scanned` counts files AFTER the glob filter, so 0 means the glob
// excluded everything and nothing was ever read — not "this code doesn't
// exist". Without saying so, the model treats it as a negative result.
describe("grep · empty-scan hint", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("explains that the glob matched nothing", async () => {
    invoke.mockResolvedValue({ hits: [], truncated: false, files_scanned: 0 });
    const out = (await callTool("grep", {
      pattern: "comment",
      glob: ["src/**/*.cs"],
    })) as { hint?: string };
    expect(out.hint).toBeTruthy();
    expect(out.hint).toMatch(/glob/i);
    expect(out.hint).toMatch(/case-sensitive/i);
  });

  it("explains an empty source directory when no glob was set", async () => {
    invoke.mockResolvedValue({ hits: [], truncated: false, files_scanned: 0 });
    const out = (await callTool("grep", { pattern: "comment" })) as {
      hint?: string;
    };
    expect(out.hint).toBeTruthy();
    expect(out.hint).not.toMatch(/glob/i);
  });

  it("adds no hint when files really were scanned", async () => {
    invoke.mockResolvedValue({
      hits: [],
      truncated: false,
      files_scanned: 1760,
    });
    const out = (await callTool("grep", {
      pattern: "class SetProfile",
      glob: ["**/*.cs"],
    })) as { hint?: string };
    expect(out.hint).toBeUndefined();
  });

  it("adds no hint when there were hits", async () => {
    invoke.mockResolvedValue({
      hits: [{ rel: "a.cs", line: 1, text: "x" }],
      truncated: false,
      files_scanned: 12,
    });
    const out = (await callTool("grep", { pattern: "x" })) as {
      hint?: string;
    };
    expect(out.hint).toBeUndefined();
  });

  it("passes the search options through to Rust", async () => {
    invoke.mockResolvedValue({ hits: [], truncated: false, files_scanned: 1 });
    await callTool("grep", {
      pattern: "x",
      glob: ["**/*.cs"],
      caseInsensitive: true,
      maxResults: 25,
    });
    expect(lastPayload()).toEqual({
      pattern: "x",
      root: ROOT,
      glob: ["**/*.cs"],
      caseInsensitive: true,
      maxResults: 25,
    });
  });
});

describe("read_file · path sanitizing", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue({ kind: "text", content: "hi", size: 2 });
  });

  // Same model quirk, same tool family: a quoted relative path used to be
  // joined verbatim and came back as "cannot find the path specified".
  it("strips surrounding quotes off a relative path", async () => {
    await callTool("read_file", { path: '"src/app.ts"' });
    expect(pathArg()).toBe(`${ROOT}\\src/app.ts`);
  });

  it("strips surrounding quotes off an absolute path", async () => {
    await callTool("read_file", { path: `"${ROOT}\\src\\app.ts"` });
    expect(pathArg()).toBe(`${ROOT}\\src\\app.ts`);
  });

  it("falls back to the root for a quoted-empty path", async () => {
    await callTool("read_file", { path: '""' });
    expect(pathArg()).toBe(ROOT);
  });

  it("still joins an ordinary relative path", async () => {
    await callTool("read_file", { path: "src/app.ts" });
    expect(pathArg()).toBe(`${ROOT}\\src/app.ts`);
  });
});

// One uncapped tool result can exceed the whole context window. By the time
// `execute` has returned it the SDK has appended it, so the NEXT request 400s
// and nothing downstream can undo it — the cap has to be at this boundary.
describe("capToolResult · the universal ceiling", () => {
  it("returns a normal-sized result untouched", () => {
    const small = { hits: [1, 2, 3] };
    expect(capToolResult(small, "narrow it")).toBe(small);
  });

  it("replaces an oversized result with a ~2 KB preview plus a recovery hint", () => {
    const huge = { output: "x".repeat(TOOL_RESULT_CAP * 2) };
    const out = capToolResult(huge, "Run a narrower command.") as {
      error: string;
      preview: string;
      hint: string;
    };
    expect(out.error).toMatch(/result too large/);
    expect(out.preview.length).toBe(2_000);
    // A stub the model can't act on is lost information.
    expect(out.hint).toContain("Run a narrower command.");
    expect(JSON.stringify(out).length).toBeLessThan(3_000);
  });
});

/** Args that make each tool run. A tool with no entry here fails the test
 *  below on purpose: adding a tool means proving it is capped. */
const TOOL_ARGS: Record<string, unknown> = {
  read_file: { path: "a.ts" },
  list_files: {},
  grep: { pattern: "NEEDLE" },
  run_command: { command: "git log" },
};

describe("every tool is capped", () => {
  const HUGE = `NEEDLE${"x".repeat(400_000)}`;

  beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation(async (cmd: string) => {
      switch (cmd) {
        case "fs_read_file":
          return { kind: "text", content: HUGE, size: HUGE.length };
        case "fs_list_files":
          return {
            files: Array.from({ length: 4000 }, (_, i) => `${"deep/".repeat(20)}f${i}.ts`),
            truncated: true,
          };
        case "fs_grep":
          return {
            hits: Array.from({ length: 200 }, (_, i) => ({
              path: `${ROOT}\\src\\f${i}.ts`,
              rel: `src/f${i}.ts`,
              line: i + 1,
              text: HUGE.slice(0, 2_000),
            })),
            truncated: true,
            files_scanned: 200,
          };
        case "run_readonly_command_cmd":
          return { returncode: 0, output: HUGE, truncated: true };
        default:
          return { blob: HUGE };
      }
    });
  });

  it("routes the whole live tool set through capToolResult", async () => {
    const tools = buildSuiteChatTools(ROOT);
    if (!tools) throw new Error("expected tools for a non-null source root");
    const names = Object.keys(tools);
    expect(names.length).toBeGreaterThan(0);

    for (const name of names) {
      expect(
        Object.prototype.hasOwnProperty.call(TOOL_ARGS, name),
        `tool \`${name}\` has no TOOL_ARGS entry — add one so this test proves it is capped`,
      ).toBe(true);
      const size = JSON.stringify(await callTool(name, TOOL_ARGS[name])).length;
      expect(
        size,
        `tool \`${name}\` returned ${size} chars — it bypasses capToolResult`,
      ).toBeLessThanOrEqual(TOOL_RESULT_CAP);
    }
  });
});

describe("grep · result shaping", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  // The head-clip bug: a 2 KB window taken off the front of a minified line
  // doesn't contain the match, so the model sees a hit it cannot read.
  it("clips a long matched line around the match, not from the head", async () => {
    const filler = "x".repeat(5_000);
    invoke.mockResolvedValue({
      hits: [
        { path: `${ROOT}\\a.ts`, rel: "a.ts", line: 7, text: `${filler}NEEDLE${filler}` },
      ],
      truncated: false,
      files_scanned: 3,
    });
    const out = (await callTool("grep", { pattern: "NEEDLE" })) as {
      hits: Array<{ text: string }>;
    };
    const text = out.hits[0].text;
    expect(text).toContain("NEEDLE");
    expect(text.length).toBeLessThan(220);
    expect(text.startsWith("…[+")).toBe(true);
    expect(text.endsWith("chars]")).toBe(true);
  });

  // `path` duplicates `rel` on every hit; read_file resolves a relative path
  // against the source root, so `rel` alone is actionable.
  it("drops the duplicated absolute path and keeps rel", async () => {
    invoke.mockResolvedValue({
      hits: [{ path: `${ROOT}\\src\\a.ts`, rel: "src/a.ts", line: 7, text: "hit" }],
      truncated: false,
      files_scanned: 1,
    });
    const out = (await callTool("grep", { pattern: "hit" })) as {
      hits: Array<Record<string, unknown>>;
    };
    expect(out.hits[0]).toEqual({ rel: "src/a.ts", line: 7, text: "hit" });
  });

  it("collapses to per-file counts under filesOnly", async () => {
    invoke.mockResolvedValue({
      hits: [
        { path: "x", rel: "src/a.ts", line: 9, text: "hit" },
        { path: "x", rel: "src/a.ts", line: 4, text: "hit" },
        { path: "x", rel: "src/b.ts", line: 2, text: "hit" },
      ],
      truncated: false,
      files_scanned: 2,
    });
    const out = (await callTool("grep", { pattern: "hit", filesOnly: true })) as {
      files: Array<Record<string, unknown>>;
      hits?: unknown;
    };
    expect(out.hits).toBeUndefined();
    expect(out.files).toEqual([
      { rel: "src/a.ts", matches: 2, firstLine: 4 },
      { rel: "src/b.ts", matches: 1, firstLine: 2 },
    ]);
  });

  // filesOnly is an option, not a mode change: what Rust is asked for — and
  // in particular the default maxResults — must be identical either way.
  it("leaves the default search mode and maxResults alone", async () => {
    invoke.mockResolvedValue({ hits: [], truncated: false, files_scanned: 5 });
    await callTool("grep", { pattern: "x", filesOnly: true });
    expect(lastPayload()).toEqual({
      pattern: "x",
      root: ROOT,
      glob: null,
      caseInsensitive: false,
      maxResults: 80,
    });
  });
});

describe("clipAroundMatch", () => {
  it("leaves a line under the cap alone", () => {
    expect(clipAroundMatch("short line", /line/, 160)).toBe("short line");
  });

  it("keeps a match that sits well past the head", () => {
    const line = `${"a".repeat(1_000)}NEEDLE${"b".repeat(1_000)}`;
    const out = clipAroundMatch(line, /NEEDLE/, 160);
    expect(out).toContain("NEEDLE");
    expect(out).toContain("a");
    expect(out).toContain("b");
  });

  // A pattern using Rust-only regex syntax won't compile in JS. Rust has
  // already centred its own 2 KB window on the match, so the head of THAT is
  // a sane fallback — it must not throw or drop the hit.
  it("falls back to the head when there is no usable matcher", () => {
    const out = clipAroundMatch("z".repeat(1_000), null, 160);
    expect(out.startsWith("z")).toBe(true);
    expect(out.endsWith("chars]")).toBe(true);
  });

  it("never splits a surrogate pair", () => {
    const line = `a${"🙂".repeat(500)}NEEDLE`;
    for (const cap of [160, 161]) {
      const out = clipAroundMatch(line, /NEEDLE/, cap);
      expect(hasLoneSurrogate(out), `cap ${cap} produced a lone surrogate`).toBe(false);
      expect(out).toContain("NEEDLE");
    }
  });
});

function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

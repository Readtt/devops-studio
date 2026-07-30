import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));

import { buildSuiteChatTools } from "./suiteChatTools";

const ROOT = "C:\\Users\\mudas\\source\\repos\\iSyncKit";

/** The AI SDK's `tool()` is an identity helper, so `execute` is directly
 *  callable — but its typed signature wants the SDK's call options, which the
 *  implementations ignore. Cast to the shape we actually exercise. */
function callTool(
  name: "list_files" | "read_file" | "grep" | "run_command",
  args: unknown,
) {
  const tools = buildSuiteChatTools(ROOT);
  if (!tools) throw new Error("expected tools for a non-null source root");
  const t = tools[name] as unknown as {
    execute: (a: unknown) => Promise<unknown>;
  };
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

import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));

import type { WorkspaceRepo } from "@/modules/settings/store";
import {
  buildSuiteChatTools,
  capToolResult,
  clipAroundMatch,
  MESSAGE_RESULT_CAP,
  TOOL_RESULT_CAP,
} from "./suiteChatTools";

const ROOT = "C:\\Users\\mudas\\source\\repos\\iSyncKit";
const ROOT_B = "C:\\Users\\mudas\\source\\repos\\iSyncKit.Web";
const ROOT_C = "C:\\Users\\mudas\\source\\repos\\Shared";

const ONE: WorkspaceRepo[] = [{ id: "r1", name: "iSyncKit", root: ROOT, ado: null }];
const THREE: WorkspaceRepo[] = [
  ...ONE,
  { id: "r2", name: "iSyncKit.Web", root: ROOT_B, ado: null },
  { id: "r3", name: "Shared", root: ROOT_C, ado: null },
];

/** The AI SDK's `tool()` is an identity helper, so `execute` is directly
 *  callable — but its typed signature wants the SDK's call options, which the
 *  implementations ignore. Cast to the shape we actually exercise. */
function callTool(name: string, args: unknown, repos: WorkspaceRepo[] = ONE) {
  const tools = buildSuiteChatTools(repos);
  if (!tools) throw new Error("expected tools for a non-empty repo list");
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
    expect(rootArg()).toBe(`${ROOT}\\src\\auth`);
  });

  it("still joins an ordinary subpath", async () => {
    await callTool("list_files", { subpath: "src/auth" });
    expect(rootArg()).toBe(`${ROOT}\\src\\auth`);
  });

  it("returns the error to the model instead of throwing", async () => {
    invoke.mockRejectedValue("not a directory: nope");
    const out = await callTool("list_files", { subpath: "nope" });
    expect(out).toEqual({ error: "not a directory: nope", subpath: "nope" });
  });

  it("addresses every listed file through its repo", async () => {
    invoke.mockResolvedValue({ files: ["src/a.ts"], truncated: false });
    const out = (await callTool("list_files", {})) as { files: string[] };
    expect(out.files).toEqual(["iSyncKit/src/a.ts"]);
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
    expect(pathArg()).toBe(`${ROOT}\\src\\app.ts`);
  });

  it("strips surrounding quotes off an absolute path", async () => {
    await callTool("read_file", { path: `"${ROOT}\\src\\app.ts"` });
    expect(pathArg()).toBe(`${ROOT}\\src\\app.ts`);
  });

  // Reading "the root" was never a real request, and the resolver is where a
  // meaningless path stops now — a refusal the model can read beats an error
  // from Rust about a directory.
  it("refuses a quoted-empty path without calling Rust", async () => {
    const out = (await callTool("read_file", { path: '""' })) as { error: string };
    expect(out.error).toMatch(/empty path/i);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("still joins an ordinary relative path", async () => {
    await callTool("read_file", { path: "src/app.ts" });
    expect(pathArg()).toBe(`${ROOT}\\src\\app.ts`);
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
    const tools = buildSuiteChatTools(ONE);
    if (!tools) throw new Error("expected tools for a non-empty repo list");
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

// Per-result capping is blind to fan-out: a model that fires four parallel
// greps in one turn gets 4 x 50,000 chars back, all appended to a single
// message. This is the second line of defence Claude Code puts behind it.
describe("per-message aggregate cap", () => {
  /** One run's tool map, called the way the SDK calls it: every tool call of a
   *  step receives that step's `messages` array, and a new array next step. */
  function session() {
    const tools = buildSuiteChatTools(ONE);
    if (!tools) throw new Error("expected tools for a non-empty repo list");
    return (name: string, args: unknown, messages: unknown[]) => {
      const t = (tools as Record<string, unknown>)[name] as {
        execute: (a: unknown, o: unknown) => Promise<unknown>;
      };
      return t.execute(args, { toolCallId: "t", messages });
    };
  }

  /** Just under the per-result cap, so nothing trips it on its own — the
   *  aggregate is the only thing that can bound this. */
  const CHUNK = "y".repeat(40_000);

  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue({ returncode: 0, output: CHUNK, truncated: false });
  });

  it("bounds the combined size of one turn's results", async () => {
    const call = session();
    const step1: unknown[] = [];
    let total = 0;
    for (let i = 0; i < 10; i++) {
      const out = await call("run_command", { command: `git log -${i}` }, step1);
      total += JSON.stringify(out).length;
    }
    // 10 x ~40k would be ~400k without the aggregate cap.
    expect(total).toBeLessThanOrEqual(MESSAGE_RESULT_CAP + 10 * 2_500);
    expect(total).toBeGreaterThan(MESSAGE_RESULT_CAP / 2);
  });

  it("gives the next turn a fresh budget", async () => {
    const call = session();
    const step1: unknown[] = [];
    for (let i = 0; i < 10; i++) {
      await call("run_command", { command: `git log -${i}` }, step1);
    }
    // A new step = a new messages array, so the budget resets and the first
    // result of the turn comes back whole.
    const step2: unknown[] = [{ role: "assistant" }];
    const out = (await call("run_command", { command: "git diff" }, step2)) as {
      output?: string;
    };
    expect(out.output).toBe(CHUNK);
  });

  it("still hands the model something it can act on once the budget is gone", async () => {
    const call = session();
    const step: unknown[] = [];
    let last: { hint?: string; preview?: string } = {};
    for (let i = 0; i < 10; i++) {
      last = (await call("run_command", { command: `git log -${i}` }, step)) as {
        hint?: string;
      };
    }
    expect(last.hint).toContain("narrower command");
  });

  it("leaves each result alone when the turn is nowhere near the budget", async () => {
    invoke.mockResolvedValue({ returncode: 0, output: "ok", truncated: false });
    const call = session();
    const step: unknown[] = [];
    for (let i = 0; i < 5; i++) {
      const out = await call("run_command", { command: "git status" }, step);
      expect(out).toEqual({
        returncode: 0,
        output: "ok",
        truncated: false,
        repo: "iSyncKit",
      });
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
    expect(out.hits[0]).toEqual({
      rel: "iSyncKit/src/a.ts",
      line: 7,
      text: "hit",
    });
  });

  // `read_file` clears every path through `resolveRepoPath`, which runs the
  // read gate; grep is handed the repo ROOT and `fs_grep` walks the tree
  // itself. Ungated, `.env` was unreadable by name and readable by pattern —
  // a search for `_KEY=` returned its matching lines verbatim.
  it("drops hits in files read_file would refuse", async () => {
    invoke.mockResolvedValue({
      hits: [
        { path: "x", rel: ".env", line: 1, text: "API_KEY=sk-live-1234" },
        { path: "x", rel: "certs/server.pem", line: 3, text: "PRIVATE_KEY=..." },
        { path: "x", rel: "src/config.ts", line: 9, text: "const API_KEY = env" },
      ],
      truncated: false,
      files_scanned: 3,
    });
    const out = (await callTool("grep", { pattern: "KEY" })) as {
      hits: Array<{ rel: string; text: string }>;
    };
    expect(out.hits.map((h) => h.rel)).toEqual(["iSyncKit/src/config.ts"]);
    expect(JSON.stringify(out)).not.toContain("sk-live-1234");
  });

  it("drops refused files from the filesOnly scan too", async () => {
    invoke.mockResolvedValue({
      hits: [
        { path: "x", rel: ".env.production", line: 1, text: "SECRET=1" },
        { path: "x", rel: "src/a.ts", line: 2, text: "SECRET" },
      ],
      truncated: false,
      files_scanned: 2,
    });
    const out = (await callTool("grep", {
      pattern: "SECRET",
      filesOnly: true,
    })) as { files: Array<{ rel: string }> };
    expect(out.files.map((f) => f.rel)).toEqual(["iSyncKit/src/a.ts"]);
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
      { rel: "iSyncKit/src/a.ts", matches: 2, firstLine: 4 },
      { rel: "iSyncKit/src/b.ts", matches: 1, firstLine: 2 },
    ]);
  });

  // `maxResults` bounds matching LINES on the Rust side, and filesOnly then
  // collapses those lines to one row per file — so the file list was bounded by
  // line hits, not by files. A symbol with 80 references inside one hot file
  // filled the default cap inside that file and came back as "1 file matched"
  // for something used across twenty. The broad scan runs at the Rust hard
  // ceiling instead; its answer is small however many lines it walked.
  it("scans wide for filesOnly, where the cap counts lines but the answer counts files", async () => {
    invoke.mockResolvedValue({ hits: [], truncated: false, files_scanned: 5 });
    await callTool("grep", { pattern: "x", filesOnly: true });
    expect(lastPayload()).toEqual({
      pattern: "x",
      root: ROOT,
      glob: null,
      caseInsensitive: false,
      maxResults: 2000,
    });
  });

  // The line-returning mode is unchanged: there the cap really is the size of
  // what comes back, so the caller's number (and the default) still rule.
  it("leaves the line-returning search on the caller's maxResults", async () => {
    invoke.mockResolvedValue({ hits: [], truncated: false, files_scanned: 5 });
    await callTool("grep", { pattern: "x" });
    expect((lastPayload() as { maxResults: number }).maxResults).toBe(80);
    await callTool("grep", { pattern: "x", maxResults: 30 });
    expect((lastPayload() as { maxResults: number }).maxResults).toBe(30);
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

// The reported problem: work spans repos, and pointing the app at one of them
// truncates coverage silently. These pin that every configured repo is read.
describe("fan-out across repos", () => {
  /** `fs_grep` answering with `count` hits per repo, labelled by root. */
  function grepPerRepo(count: Record<string, number>) {
    invoke.mockImplementation(async (cmd: string, args: { root: string }) => {
      if (cmd !== "fs_grep") throw new Error(`unexpected command ${cmd}`);
      const n = count[args.root] ?? 0;
      const tag = args.root.slice(args.root.lastIndexOf("\\") + 1);
      return {
        hits: Array.from({ length: n }, (_, i) => ({
          path: `${args.root}\\f${i}.ts`,
          rel: `${tag}-f${i}.ts`,
          line: i + 1,
          text: "NEEDLE",
        })),
        truncated: false,
        files_scanned: n,
      };
    });
  }

  beforeEach(() => {
    invoke.mockReset();
  });

  it("greps every repo, not just the first", async () => {
    grepPerRepo({ [ROOT]: 1, [ROOT_B]: 1, [ROOT_C]: 1 });
    await callTool("grep", { pattern: "NEEDLE" }, THREE);
    expect(invoke.mock.calls.map((c) => c[1].root).sort()).toEqual(
      [ROOT, ROOT_B, ROOT_C].sort(),
    );
  });

  // Straight concatenation lets one repo's 80 hits fill the cap and hide the
  // others entirely — the same silent coverage loss, one layer down.
  it("interleaves so a hit-heavy repo can't crowd the others out of the cap", async () => {
    grepPerRepo({ [ROOT]: 80, [ROOT_B]: 3, [ROOT_C]: 3 });
    const out = (await callTool(
      "grep",
      { pattern: "NEEDLE", maxResults: 10 },
      THREE,
    )) as { hits: Array<{ rel: string }> };
    expect(out.hits).toHaveLength(10);
    const repos = new Set(out.hits.map((h) => h.rel.split("/")[0]));
    expect(repos).toEqual(new Set(["iSyncKit", "iSyncKit.Web", "Shared"]));
  });

  it("reports truncated when the MERGE drops hits, not just the repos", async () => {
    // Each repo fits comfortably under its own Rust cap and answers
    // `truncated: false`; only the interleave overflows. Reporting the repos'
    // flag verbatim tells the model it has seen every reference to the symbol
    // when it has seen a third of them.
    grepPerRepo({ [ROOT]: 80, [ROOT_B]: 3, [ROOT_C]: 3 });
    const out = (await callTool(
      "grep",
      { pattern: "NEEDLE", maxResults: 10 },
      THREE,
    )) as { truncated: boolean };
    expect(out.truncated).toBe(true);
  });

  it("caps the filesOnly list instead of letting the result be discarded", async () => {
    // filesOnly scans at the Rust ceiling by design, but the ANSWER still has
    // to fit: past TOOL_RESULT_CAP the whole result is replaced by a
    // mid-structure preview, so the model loses the scan entirely.
    grepPerRepo({ [ROOT]: 80, [ROOT_B]: 80, [ROOT_C]: 80 });
    const out = (await callTool(
      "grep",
      { pattern: "NEEDLE", filesOnly: true, maxResults: 5 },
      THREE,
    )) as { files: unknown[]; truncated: boolean };
    expect(out.files).toHaveLength(5);
    expect(out.truncated).toBe(true);
  });

  it("sums files_scanned across repos", async () => {
    grepPerRepo({ [ROOT]: 2, [ROOT_B]: 3, [ROOT_C]: 4 });
    const out = (await callTool("grep", { pattern: "NEEDLE" }, THREE)) as {
      files_scanned: number;
    };
    expect(out.files_scanned).toBe(9);
  });

  // A root the user moved or unmounted must not take the readable repos with
  // it — otherwise one stale registry entry breaks code search entirely.
  it("reports a failing repo alongside the repos that answered", async () => {
    invoke.mockImplementation(async (_cmd: string, args: { root: string }) => {
      if (args.root === ROOT_B) throw "no such directory";
      return {
        hits: [{ path: "p", rel: "a.ts", line: 1, text: "NEEDLE" }],
        truncated: false,
        files_scanned: 1,
      };
    });
    const out = (await callTool("grep", { pattern: "NEEDLE" }, THREE)) as {
      hits: Array<{ rel: string }>;
      errors: Array<{ repo: string; error: string }>;
    };
    expect(out.hits.map((h) => h.rel)).toEqual(["iSyncKit/a.ts", "Shared/a.ts"]);
    expect(out.errors).toEqual([
      { repo: "iSyncKit.Web", error: "no such directory" },
    ]);
  });

  it("lists every repo, each with an equal share of the cap", async () => {
    invoke.mockImplementation(async (_cmd: string, args: { root: string }) => ({
      files: [args.root === ROOT_B ? "web.ts" : "a.ts"],
      truncated: false,
    }));
    const out = (await callTool("list_files", { limit: 30 }, THREE)) as {
      files: string[];
    };
    expect(out.files).toEqual([
      "iSyncKit/a.ts",
      "iSyncKit.Web/web.ts",
      "Shared/a.ts",
    ]);
    expect(invoke.mock.calls.map((c) => c[1].limit)).toEqual([10, 10, 10]);
  });

  it("names the repo whose listing failed", async () => {
    invoke.mockImplementation(async (_cmd: string, args: { root: string }) => {
      if (args.root === ROOT_B) throw "not a directory";
      return { files: ["src/a.ts"], truncated: false };
    });
    const out = (await callTool("list_files", {}, THREE)) as {
      files: string[];
      errors: Array<{ repo: string; error: string }>;
    };
    expect(out.files).toEqual(["iSyncKit/src/a.ts", "Shared/src/a.ts"]);
    expect(out.errors).toEqual([
      { repo: "iSyncKit.Web", error: "not a directory" },
    ]);
  });

  it("drills into one repo when the subpath names it", async () => {
    invoke.mockResolvedValue({ files: ["login.ts"], truncated: false });
    const out = (await callTool(
      "list_files",
      { subpath: "Shared/src/auth" },
      THREE,
    )) as { files: string[] };
    expect(rootArg()).toBe(`${ROOT_C}\\src\\auth`);
    expect(out.files).toEqual(["Shared/src/auth/login.ts"]);
  });
});

// A cwd can only ever be one place, so `run_command` is the one tool that has
// to be told which repo it means.
describe("run_command · choosing a repo", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue({ returncode: 0, output: "ok", truncated: false });
  });

  it("needs no repo when only one is configured", async () => {
    await callTool("run_command", { command: "git log" }, ONE);
    expect(lastPayload<{ root: string }>().root).toBe(ROOT);
  });

  it("refuses without one at several repos, naming them", async () => {
    const out = (await callTool("run_command", { command: "git log" }, THREE)) as {
      error: string;
    };
    expect(out.error).toContain("iSyncKit, iSyncKit.Web, Shared");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("runs in the named repo", async () => {
    const out = (await callTool(
      "run_command",
      { command: "git log", repo: "Shared" },
      THREE,
    )) as { repo: string };
    expect(lastPayload<{ root: string }>().root).toBe(ROOT_C);
    expect(out.repo).toBe("Shared");
  });

  it("refuses a repo name that isn't configured", async () => {
    const out = (await callTool(
      "run_command",
      { command: "git log", repo: "nope" },
      THREE,
    )) as { error: string };
    expect(out.error).toMatch(/No repo named "nope"/);
    expect(invoke).not.toHaveBeenCalled();
  });

  // Rust rejects ABSOLUTE paths and nothing else, so `..` is how a command
  // reads a sibling repo the user deselected — or anything else next to the
  // root. This is the only tool whose paths never reach `resolveRepoPath`.
  it.each([
    "cat ../Shared/appsettings.Production.json",
    "cat ..\\Shared\\secrets.json",
    'cat "../Shared/x"',
    "ls ..",
    // Not a path argument but a flag VALUE, which repoints the whole command
    // at another repo — `git --git-dir=..` reads a sibling's history without
    // any argument that looks like a path.
    "git --git-dir=../Shared/.git log --oneline",
  ])("refuses a command that climbs out of the repo: %s", async (command) => {
    const out = (await callTool(
      "run_command",
      { command, repo: "iSyncKit" },
      THREE,
    )) as { error: string };
    expect(out.error).toMatch(/climbs out of the repo/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("still allows a path that merely contains dots", async () => {
    await callTool(
      "run_command",
      { command: "cat src/app..config", repo: "iSyncKit" },
      THREE,
    );
    expect(invoke).toHaveBeenCalled();
  });
});

// Bug #5: the tool layer had no path containment at all. `workspace.rs`'s
// resolve_path is identity, so this resolver is the only thing between the
// model and the user's home directory.
describe("containment at the tool boundary", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue({ kind: "text", content: "hi", size: 2 });
  });

  it("refuses a read outside every configured repo", async () => {
    const out = (await callTool(
      "read_file",
      { path: "C:/Users/mudas/.ssh/id_rsa" },
      THREE,
    )) as { error: string };
    expect(out.error).toBeTruthy();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("refuses a secret file that does sit inside a repo", async () => {
    const out = (await callTool(
      "read_file",
      { path: "iSyncKit/.env.production" },
      THREE,
    )) as { error: string };
    expect(out.error).toMatch(/sensitive-file pattern/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("gives up its tools entirely when no repo is configured", () => {
    expect(buildSuiteChatTools([])).toBeUndefined();
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

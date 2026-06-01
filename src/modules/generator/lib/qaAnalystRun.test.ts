import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the shared runner so we assert how runQaAnalyst drives it, without any
// model call.
const runTask = vi.fn();
vi.mock("@/modules/ai/lib/taskRunner", () => ({
  runTask: (...a: unknown[]) => runTask(...a),
}));

// buildSuiteChatTools returns a sentinel tool set when (and only when) a source
// root is supplied.
const TOOLS = { read_file: {}, list_files: {}, grep: {} };
vi.mock("@/modules/test-plans/lib/suiteChatTools", () => ({
  buildSuiteChatTools: (root: string | null) => (root ? TOOLS : undefined),
}));

import { runQaAnalyst, type RunInput } from "./qaAnalystRun";

const base: RunInput = {
  requirements: "Feature spec",
  attachments: [],
  existingCaseTitles: [],
  mode: "thorough",
  keys: {} as never,
  modelId: "gpt-5.4-mini" as never,
};

beforeEach(() => {
  runTask.mockReset();
  runTask.mockResolvedValue({
    ok: true,
    object: { cases: [], bugs: [] },
    text: "{}",
    durationMs: 1,
  });
});

describe("runQaAnalyst tool wiring", () => {
  it("passes read-only tools to the runner when a source root is set", async () => {
    await runQaAnalyst({ ...base, sourceRoot: "C:/repo" });
    const arg = runTask.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.tools).toBe(TOOLS);
    expect(arg.schema).toBeDefined();
    expect(arg.temperature).toBe(0);
  });

  it("runs tool-less (tools: null) when no source root", async () => {
    await runQaAnalyst({ ...base, sourceRoot: null });
    const arg = runTask.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.tools).toBeNull();
  });

  it("returns the validated batch from the runner", async () => {
    runTask.mockResolvedValue({
      ok: true,
      object: {
        cases: [
          {
            title: "A valid generated case title",
            description: "",
            steps: [{ action: "a", expected: "b" }],
            tags: [],
            rationale: "",
            sourceLinks: [],
          },
        ],
        bugs: [],
      },
      text: "{}",
      durationMs: 1,
    });
    const out = await runQaAnalyst({ ...base, sourceRoot: "C:/repo" });
    expect(out.batch.cases).toHaveLength(1);
  });

  it("salvages a partial batch when the runner reports schema_violation", async () => {
    runTask.mockResolvedValue({
      ok: false,
      reason: "schema_violation",
      text: JSON.stringify({
        cases: [
          {
            title: "A salvageable valid title",
            steps: [{ action: "a", expected: "b" }],
          },
          { title: "x", steps: [] }, // invalid → dropped
        ],
        bugs: [],
      }),
      durationMs: 1,
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const out = await runQaAnalyst({ ...base, sourceRoot: null });
    expect(out.batch.cases).toHaveLength(1);
    err.mockRestore();
  });
});

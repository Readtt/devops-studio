// A cut-off analyze that still parsed into something reviewable used to be
// indistinguishable, in the review pane, from a model that answered completely
// and just didn't find any bugs.
//
// DraftBatch serialises `cases` then `bugs`, so the tail an output-cap cut
// takes is always the bug suggestions: the salvager keeps the cases that closed
// before the cut and reports zero bugs, with nothing anywhere saying why. These
// pin that the store records the truncation so the pane can say it.

import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));

const executeQaAnalystRun = vi.fn();
vi.mock("../lib/qaAnalystRun", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/qaAnalystRun")>();
  return {
    ...actual,
    executeQaAnalystRun: (...a: unknown[]) =>
      (executeQaAnalystRun as (...x: unknown[]) => unknown)(...a),
  };
});

import { createGenerationSessionStore } from "./useGenerationSession";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { usePreferencesStore } from "@/modules/settings/preferences";

const CASE = {
  title: "Reset password happy path",
  description: "",
  steps: [{ action: "a", expected: "b" }],
  tags: [],
  rationale: "",
  sourceLinks: [],
};

/** A run result shaped like the salvager's output for a cut-off answer: the
 *  cases that closed before the cut, and no bugs at all. */
function partialResult(over: Record<string, unknown> = {}) {
  return {
    batch: { cases: [CASE], bugs: [] },
    rawText: '{"cases":[{"title":"Reset password',
    durationMs: 1,
    ok: false,
    reason: "schema_violation",
    stepsUsed: 3,
    usage: {},
    finishReason: "length",
    ...over,
  };
}

async function runWith(result: Record<string, unknown>) {
  const store = createGenerationSessionStore();
  executeQaAnalystRun.mockResolvedValue(result);
  store.setState({ requirements: "Users can reset a forgotten password." });
  await store.getState().analyze();
  return store;
}

beforeEach(() => {
  invoke.mockClear();
  invoke.mockResolvedValue(undefined);
  executeQaAnalystRun.mockReset();
  useChatStore.setState({ keysLoaded: true, apiKeys: {} as never });
  usePreferencesStore.setState({
    bestPracticeFiles: [],
    codeSearchEnabled: false,
  });
});

describe("useGenerationSession — a partially-truncated batch", () => {
  it("still reaches review with the cases that survived", async () => {
    const store = await runWith(partialResult());
    expect(store.getState().phase).toBe("review");
    expect(store.getState().cases).toHaveLength(1);
    expect(store.getState().bugs).toHaveLength(0);
  });

  it("records the truncation so the pane can say the bugs were never written", async () => {
    const store = await runWith(partialResult());
    expect(store.getState().truncation).not.toBeNull();
  });

  it("carries the output cap the cut-off request asked for", async () => {
    const store = await runWith(partialResult({ outputCap: 8_192 }));
    expect(store.getState().truncation?.outputCap).toBe(8_192);
  });

  it("leaves the cap undefined when the request asked for none — the case the banner can actually fix", async () => {
    const store = await runWith(partialResult());
    expect(store.getState().truncation).toEqual({});
    expect(store.getState().truncation?.outputCap).toBeUndefined();
  });

  it("records nothing for a run that finished normally", async () => {
    const store = await runWith({
      batch: { cases: [CASE], bugs: [] },
      rawText: "{}",
      durationMs: 1,
      ok: true,
      stepsUsed: 1,
      usage: {},
      finishReason: "stop",
    });
    expect(store.getState().phase).toBe("review");
    expect(store.getState().truncation).toBeNull();
  });

  it("clears a previous run's truncation when a new session starts", async () => {
    const store = await runWith(partialResult());
    expect(store.getState().truncation).not.toBeNull();
    store.getState().startNew();
    expect(store.getState().truncation).toBeNull();
  });
});

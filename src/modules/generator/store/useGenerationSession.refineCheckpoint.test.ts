import { beforeEach, describe, expect, it, vi } from "vitest";

// Every backend call the store makes goes through Tauri IPC; capturing it here
// is what lets us assert which commands a follow-up did (and did NOT) issue.
const invoke = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));

// Only the engine is mocked — prompt assembly (prepareQaAnalystRun) stays real,
// so these tests exercise the same prompt the checkpoint persists.
const executeQaAnalystRun = vi.fn();
vi.mock("../lib/qaAnalystRun", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/qaAnalystRun")>();
  return {
    ...actual,
    executeQaAnalystRun: (...a: unknown[]) =>
      (executeQaAnalystRun as (...x: unknown[]) => unknown)(...a),
  };
});

import {
  createGenerationSessionStore,
  type GenerationSessionStore,
} from "./useGenerationSession";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  FINISH_NOW_NUDGE,
  type GeneratorRefineCheckpointV1,
} from "@/modules/ai/lib/checkpointApi";
import { RESUME_TOPUP_STEPS, type ModelId } from "@/modules/ai/config";
import type {
  ExecuteAnalystOptions,
  PreparedAnalystRun,
} from "../lib/qaAnalystRun";
import type { ReviewedCase } from "../lib/draftBatchSchema";

const SESSION_RUN_ID = "run-draft-1";

/** Array.prototype.at isn't in this project's TS lib target. */
function last<T>(xs: T[]): T | undefined {
  return xs.length > 0 ? xs[xs.length - 1] : undefined;
}

function invokedCommands(): string[] {
  return invoke.mock.calls.map((c) => c[0] as string);
}

/** Every ai_checkpoint_save payload, parsed, in write order. */
function savedPayloads(): GeneratorRefineCheckpointV1[] {
  return invoke.mock.calls
    .filter((c) => c[0] === "ai_checkpoint_save")
    .map(
      (c) =>
        JSON.parse(
          (c[1] as { input: { payload: string } }).input.payload,
        ) as GeneratorRefineCheckpointV1,
    );
}

function draftCase(title: string): ReviewedCase {
  return {
    title,
    description: "",
    steps: [{ action: "a", expected: "b" }],
    tags: [],
    rationale: "",
    sourceLinks: [],
    uid: `u-${title}`,
    decision: "keep",
    similarMatches: [],
  };
}

/** A store parked in review with a one-case draft — the state a follow-up
 *  actually runs from. */
function reviewStore(): GenerationSessionStore {
  const store = createGenerationSessionStore();
  store.setState({
    phase: "review",
    runId: SESSION_RUN_ID,
    requirements: "Users can reset a forgotten password.",
    // No plan/suite ⇒ refine skips the ADO context prefetch entirely, so any
    // ado_* command showing up in a test is a genuine regression.
    planId: null,
    suiteId: null,
    cases: [draftCase("Reset password happy path")],
    bugs: [],
    rawText: "{}",
  });
  return store;
}

function okBatch(title = "Refined case") {
  return {
    batch: { cases: [draftCase(title)], bugs: [] },
    rawText: "{}",
    durationMs: 1,
    ok: true,
    stepsUsed: 2,
    usage: {},
  };
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

describe("refine — checkpointing a follow-up", () => {
  it("writes a resume point before the provider is touched, and deletes it once the round lands", async () => {
    const store = reviewStore();
    let sawCheckpointBeforeCall = false;
    executeQaAnalystRun.mockImplementation(async () => {
      // The row has to exist by the time the model is called — that's the whole
      // guarantee: a crash one step in is recoverable.
      sawCheckpointBeforeCall = invokedCommands().includes("ai_checkpoint_save");
      return okBatch();
    });

    await store.getState().refine("tighten step 2");

    expect(sawCheckpointBeforeCall).toBe(true);
    const first = savedPayloads()[0];
    expect(first.surface).toBe("generator-refine");
    expect(first.sessionRunId).toBe(SESSION_RUN_ID);
    expect(first.round.instruction).toBe("tighten step 2");
    // The draft is rendered INTO the prompt, so a resume needs nothing else.
    expect(first.prepared.userPrompt).toContain("tighten step 2");
    // Landed ⇒ nothing left to buy back.
    expect(invokedCommands()).toContain("ai_checkpoint_delete");
    expect(store.getState().refineResumable).toBeNull();
    expect(store.getState().cases[0].title).toBe("Refined case");
  });

  it("keeps the draft and offers a resume when the round dies mid-flight", async () => {
    const store = reviewStore();
    executeQaAnalystRun.mockRejectedValue(new Error("fetch failed"));

    await store.getState().refine("add edge cases");

    const s = store.getState();
    expect(s.isRefining).toBe(false);
    // The draft the user was refining is untouched — that's the point of
    // surfacing the failure inline instead of wiping back to input.
    expect(s.cases[0].title).toBe("Reset password happy path");
    expect(s.refineError).toContain("fetch failed");
    expect(s.refineResumable?.instruction).toBe("add edge cases");
    const flushed = last(savedPayloads());
    expect(flushed?.lastOutcome).toMatchObject({
      kind: "error",
      errorKind: "network",
    });
    // The row survives the failure — it IS the resume point.
    expect(invokedCommands()).not.toContain("ai_checkpoint_delete");
  });

  it("offers a resume after the user cancels a round that had already started", async () => {
    const store = reviewStore();
    executeQaAnalystRun.mockImplementation(
      (_p: unknown, opts: ExecuteAnalystOptions) =>
        new Promise((_resolve, reject) => {
          opts.signal?.addEventListener("abort", () =>
            reject(
              Object.assign(new Error("aborted"), { name: "AbortError" }),
            ),
          );
        }),
    );

    const running = store.getState().refine("re-ground every case");
    // Let the prep awaits settle so the round is genuinely in the provider call.
    await vi.waitFor(() => expect(executeQaAnalystRun).toHaveBeenCalled());
    store.getState().cancelRefine();
    await running;

    const s = store.getState();
    // A cancel is the user's own choice — no error banner, just the offer.
    expect(s.refineError).toBeNull();
    expect(s.refineResumable?.outcome?.kind).toBe("cancelled");
    expect(last(s.refineRounds)?.error).toBe("Cancelled before completion.");
  });

  it("writes nothing when the user cancels before the round reaches the provider", async () => {
    const store = reviewStore();
    executeQaAnalystRun.mockResolvedValue(okBatch());

    const running = store.getState().refine("never sent");
    // Same tick as the prep awaits — the abort lands before the writer exists.
    store.getState().cancelRefine();
    await running;

    expect(executeQaAnalystRun).not.toHaveBeenCalled();
    // Nothing was spent, so nothing may be left behind that reads as resumable.
    expect(invokedCommands()).not.toContain("ai_checkpoint_save");
    expect(store.getState().refineResumable).toBeNull();
  });

  it("drops the row when the model answers with an empty batch", async () => {
    const store = reviewStore();
    executeQaAnalystRun.mockResolvedValue({
      batch: { cases: [], bugs: [] },
      rawText: "",
      durationMs: 1,
      ok: false,
      reason: "empty",
    });

    await store.getState().refine("do something impossible");

    const s = store.getState();
    expect(s.cases[0].title).toBe("Reset password happy path");
    expect(s.refineError).toContain("empty refine result");
    // The model ANSWERED — resuming that transcript would just re-fail, so the
    // row goes rather than lingering as a resume that can't work.
    expect(s.refineResumable).toBeNull();
    expect(invokedCommands()).toContain("ai_checkpoint_delete");
  });

  it("classifies an exhausted step budget as resumable instead of 'empty result'", async () => {
    const store = reviewStore();
    executeQaAnalystRun.mockResolvedValue({
      batch: { cases: [], bugs: [] },
      rawText: "",
      durationMs: 1,
      ok: false,
      reason: "step_cap",
      stepsUsed: 24,
    });

    await store.getState().refine("read every caller");

    const s = store.getState();
    expect(s.refineError).toContain("step budget");
    expect(s.refineResumable).not.toBeNull();
    expect(last(savedPayloads())?.lastOutcome?.kind).toBe("step_cap");
  });
});

/** Disk simulation: ai_checkpoint_get serves whatever the last save wrote, so a
 *  resume reads the real round-trip (JSON parse and all) rather than a fixture. */
function withCheckpointDisk(): { get: () => string | null } {
  let disk: string | null = null;
  let runId = "";
  invoke.mockImplementation(async (cmd: unknown, args?: unknown) => {
    if (cmd === "ai_checkpoint_save") {
      const input = (args as { input: { payload: string; runId: string } })
        .input;
      disk = input.payload;
      runId = input.runId;
      return undefined;
    }
    if (cmd === "ai_checkpoint_delete") {
      disk = null;
      return undefined;
    }
    if (cmd === "ai_checkpoint_get") {
      if (!disk) return null;
      return {
        runId,
        surface: "generator-refine",
        cwd: null,
        payload: disk,
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:05:00.000Z",
      };
    }
    if (cmd === "ai_checkpoint_list") {
      return disk ? [{ runId, cwd: null, createdAt: "t0", updatedAt: "t1" }] : [];
    }
    return undefined;
  });
  return { get: () => disk };
}

describe("resumeRefine — replaying the paid-for round", () => {
  it("hands the engine the persisted transcript + prompt, rebuilding nothing", async () => {
    withCheckpointDisk();
    const store = reviewStore();
    const messages = [
      { role: "assistant" as const, content: "I already read auth.ts." },
    ];

    // Round 1: two steps land, then the connection drops.
    executeQaAnalystRun.mockImplementationOnce(
      async (_p: unknown, opts: ExecuteAnalystOptions) => {
        opts.onCheckpoint?.({
          messages,
          stepsUsed: 2,
          usage: { totalTokens: 900 },
        });
        throw new Error("fetch failed");
      },
    );
    await store.getState().refine("check step 3 against auth.ts");
    // The throttled writer coalesces per-step saves; the terminal flush is what
    // guarantees the transcript is on disk before we resume.
    expect(store.getState().refineResumable?.stepsUsed).toBe(2);

    // Round 2: the same round continues.
    executeQaAnalystRun.mockResolvedValueOnce(okBatch("Corrected case"));
    const promptBefore = savedPayloads()[0].prepared.userPrompt;
    invoke.mockClear();
    await store.getState().resumeRefine();

    expect(executeQaAnalystRun).toHaveBeenCalledTimes(2);
    const [prepared, opts] = executeQaAnalystRun.mock.calls[1] as [
      PreparedAnalystRun,
      ExecuteAnalystOptions,
    ];
    // The checkpointed prompt is reused verbatim — no re-assembly, so the model
    // sees the draft as it was when the user asked, not as it is now.
    expect(prepared.userPrompt).toBe(promptBefore);
    expect(opts.resumeMessages).toEqual(messages);
    // And a resume never re-reads the suite.
    expect(invokedCommands().some((c) => c.startsWith("ado_"))).toBe(false);

    const s = store.getState();
    expect(s.cases[0].title).toBe("Corrected case");
    expect(s.refineResumable).toBeNull();
    expect(invokedCommands()).toContain("ai_checkpoint_delete");
    // The completed round reads as ONE round in history, dated when the user
    // sent it — not as a second round dated at resume time.
    expect(s.refineRounds).toHaveLength(1);
    expect(s.refineRounds[0].instruction).toBe(
      "check step 3 against auth.ts",
    );
    expect(s.refineRounds[0].outcome).toBe("ok");
    // Undo still points at the draft the user saw before resuming.
    expect(s.refineUndoSnapshot?.cases[0].title).toBe(
      "Reset password happy path",
    );
  });

  it("gives a step-capped round the top-up budget and an explicit finish-now turn", async () => {
    withCheckpointDisk();
    const store = reviewStore();
    executeQaAnalystRun.mockImplementationOnce(
      async (_p: unknown, opts: ExecuteAnalystOptions) => {
        opts.onCheckpoint?.({
          messages: [{ role: "assistant", content: "still reading" }],
          stepsUsed: 24,
          usage: {},
        });
        return {
          batch: { cases: [], bugs: [] },
          rawText: "",
          durationMs: 1,
          ok: false,
          reason: "step_cap",
        };
      },
    );
    await store.getState().refine("trace every caller");

    executeQaAnalystRun.mockResolvedValueOnce(okBatch());
    await store.getState().resumeRefine();

    const [, opts] = executeQaAnalystRun.mock.calls[1] as [
      PreparedAnalystRun,
      ExecuteAnalystOptions,
    ];
    expect(opts.maxSteps).toBe(RESUME_TOPUP_STEPS);
    expect(last(opts.resumeMessages ?? [])).toEqual({
      role: "user",
      content: FINISH_NOW_NUDGE,
    });
  });

  it("refuses to resume onto a retired model instead of looping the button", async () => {
    withCheckpointDisk();
    const store = reviewStore();
    executeQaAnalystRun.mockRejectedValueOnce(new Error("fetch failed"));
    await store.getState().refine("anything");

    // The model this round ran on has since been dropped from the catalogue.
    store.setState({ refineResumable: store.getState().refineResumable });
    const saved = last(savedPayloads()) as GeneratorRefineCheckpointV1;
    const retired = JSON.stringify({
      ...saved,
      modelId: "retired-model-x" as ModelId,
    });
    invoke.mockImplementation(async (cmd: unknown) =>
      cmd === "ai_checkpoint_get"
        ? {
            runId: saved.runId,
            surface: "generator-refine",
            cwd: null,
            payload: retired,
            createdAt: saved.createdAt,
            updatedAt: "2026-08-01T00:05:00.000Z",
          }
        : undefined,
    );
    executeQaAnalystRun.mockClear();

    await store.getState().resumeRefine();

    const s = store.getState();
    expect(executeQaAnalystRun).not.toHaveBeenCalled();
    expect(s.isRefining).toBe(false);
    expect(s.refineResumable).toBeNull();
    expect(s.refineError).toContain("no longer available");
  });
});

describe("probeRefineCheckpoint — resurfacing a round after a restart", () => {
  it("adopts an interrupted follow-up belonging to this draft", async () => {
    const payload: GeneratorRefineCheckpointV1 = {
      v: 1,
      surface: "generator-refine",
      runId: "rfn-abc",
      sessionRunId: SESSION_RUN_ID,
      createdAt: "2026-08-01T00:00:00.000Z",
      modelId: "claude-sonnet-5",
      sourceRoot: null,
      round: {
        instruction: "add negative paths",
        startedAt: "2026-08-01T00:00:00.000Z",
        beforeCases: 1,
        beforeBugs: 0,
      },
      prepared: { userPrompt: "prompt", attachments: [] },
      activity: [],
      transcript: { messages: [], stepsUsed: 4, usage: { totalTokens: 10 } },
      lastOutcome: { at: "2026-08-01T00:05:00.000Z", kind: "cancelled" },
    };
    invoke.mockImplementation(async (cmd: unknown) => {
      if (cmd === "ai_checkpoint_list") {
        return [
          { runId: "rfn-abc", cwd: null, createdAt: "t0", updatedAt: "t1" },
        ];
      }
      if (cmd === "ai_checkpoint_get") {
        return {
          runId: "rfn-abc",
          surface: "generator-refine",
          cwd: null,
          payload: JSON.stringify(payload),
          createdAt: payload.createdAt,
          updatedAt: "2026-08-01T00:05:00.000Z",
        };
      }
      return undefined;
    });

    const store = reviewStore();
    await store.getState().probeRefineCheckpoint();

    expect(store.getState().refineResumable).toMatchObject({
      runId: "rfn-abc",
      instruction: "add negative paths",
      stepsUsed: 4,
    });
  });

  it("ignores a row that belongs to a different draft", async () => {
    invoke.mockImplementation(async (cmd: unknown) => {
      if (cmd === "ai_checkpoint_list") {
        return [
          { runId: "rfn-other", cwd: null, createdAt: "t0", updatedAt: "t1" },
        ];
      }
      if (cmd === "ai_checkpoint_get") {
        return {
          runId: "rfn-other",
          surface: "generator-refine",
          cwd: null,
          payload: JSON.stringify({
            v: 1,
            surface: "generator-refine",
            runId: "rfn-other",
            sessionRunId: "some-other-draft",
            createdAt: "2026-08-01T00:00:00.000Z",
            modelId: "claude-sonnet-5",
            sourceRoot: null,
            round: {
              instruction: "someone else's follow-up",
              startedAt: "2026-08-01T00:00:00.000Z",
              beforeCases: 0,
              beforeBugs: 0,
            },
            prepared: { userPrompt: "p", attachments: [] },
            activity: [],
            transcript: null,
            lastOutcome: { at: "2026-08-01T00:05:00.000Z", kind: "cancelled" },
          }),
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:05:00.000Z",
        };
      }
      return undefined;
    });

    const store = reviewStore();
    await store.getState().probeRefineCheckpoint();

    expect(store.getState().refineResumable).toBeNull();
  });
});

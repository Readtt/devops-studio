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
    // A real plan/suite, so refine DOES run the ADO context prefetch. That's
    // what gives "a resume re-reads nothing" something to actually prove.
    planId: 11,
    suiteId: 22,
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

type DiskRow = {
  runId: string;
  surface: string;
  cwd: string | null;
  payload: string;
  createdAt: string;
  updatedAt: string;
};

/** Multi-row disk simulation over the four ai_checkpoint_* commands, so tests
 *  see the real round-trip (JSON parse, surface/cwd filtering, newest-first
 *  ordering) instead of a fixture — and so a test can assert which rows were
 *  actually left behind. Returns the live row map. */
function checkpointDisk(): Map<string, DiskRow> {
  const rows = new Map<string, DiskRow>();
  invoke.mockImplementation(async (cmd: unknown, args?: unknown) => {
    if (cmd === "ai_checkpoint_save") {
      const input = (args as { input: DiskRow }).input;
      rows.set(input.runId, { ...input });
      return undefined;
    }
    if (cmd === "ai_checkpoint_delete") {
      rows.delete((args as { input: { runId: string } }).input.runId);
      return undefined;
    }
    if (cmd === "ai_checkpoint_get") {
      return rows.get((args as { input: { runId: string } }).input.runId) ?? null;
    }
    if (cmd === "ai_checkpoint_list") {
      const { surface, cwd } = (
        args as { input: { surface: string; cwd: string | null } }
      ).input;
      return Array.from(rows.values())
        .filter((r) => r.surface === surface && (cwd == null || r.cwd === cwd))
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
        .map((r) => ({
          runId: r.runId,
          cwd: r.cwd,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        }));
    }
    return undefined;
  });
  return rows;
}

/** A round that reports one completed step, then hangs until aborted. */
function hangingRound(): (p: unknown, o: ExecuteAnalystOptions) => Promise<never> {
  return (_p, opts) =>
    new Promise((_resolve, reject) => {
      opts.onCheckpoint?.({
        messages: [{ role: "assistant", content: "read auth.ts" }],
        stepsUsed: 1,
        usage: {},
      });
      opts.signal?.addEventListener("abort", () =>
        reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
      );
    });
}

describe("resumeRefine — replaying the paid-for round", () => {
  it("hands the engine the persisted transcript + prompt, rebuilding nothing", async () => {
    checkpointDisk();
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
    // A FRESH round does rebuild the plan/suite context from ADO — which is
    // what makes the "resume re-reads nothing" assertion below meaningful.
    expect(invokedCommands().some((c) => c.startsWith("ado_"))).toBe(true);

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
    checkpointDisk();
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
    checkpointDisk();
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

// A round that loses its slot — the user superseded it, or walked away from the
// draft entirely — must take its row with it. Left behind, the row has no
// terminal outcome, which reads to the probe exactly like an app-quit
// interruption: it would resurface later offering to overwrite a newer draft
// with a two-generations-old one.
describe("refine — a round that can't apply its result leaves nothing behind", () => {
  it("cleans up after itself when the user cancels and immediately re-sends", async () => {
    const rows = checkpointDisk();
    const store = reviewStore();

    executeQaAnalystRun.mockImplementationOnce(hangingRound());
    const roundA = store.getState().refine("round A");
    await vi.waitFor(() => expect(executeQaAnalystRun).toHaveBeenCalledTimes(1));
    // ESC frees the composer immediately — A's rejection is still unwinding.
    store.getState().cancelRefine();
    // ...and the user retypes straight away, before A has settled.
    executeQaAnalystRun.mockResolvedValueOnce(okBatch("Refined by B"));
    const roundB = store.getState().refine("round B");
    await Promise.all([roundA, roundB]);

    expect(store.getState().cases[0].title).toBe("Refined by B");
    // B deleted its own row on success; A must not have orphaned one.
    expect(Array.from(rows.keys())).toEqual([]);
    await store.getState().probeRefineCheckpoint();
    expect(store.getState().refineResumable).toBeNull();
  });

  it("refuses to write into a session the user has already replaced", async () => {
    const rows = checkpointDisk();
    const store = reviewStore();
    let release!: (v: unknown) => void;
    executeQaAnalystRun.mockImplementationOnce(
      () => new Promise((resolve) => (release = resolve)),
    );

    const running = store.getState().refine("slow follow-up");
    await vi.waitFor(() => expect(executeQaAnalystRun).toHaveBeenCalled());
    // The user gives up on this draft and starts a brand-new generation.
    store.getState().startNew();
    release(okBatch("Ghost case"));
    await running;

    const s = store.getState();
    expect(s.phase).toBe("input");
    // None of the old draft's round may land in the fresh session — cases,
    // thinking history and the undo snapshot all belong to a draft that's gone.
    expect(s.cases).toEqual([]);
    expect(s.refineRounds).toEqual([]);
    expect(s.refineUndoSnapshot).toBeNull();
    expect(s.refineResumable).toBeNull();
    expect(Array.from(rows.keys())).toEqual([]);
  });

  it("stops the provider request when the session is replaced, rather than letting it bill out", async () => {
    checkpointDisk();
    const store = reviewStore();
    let sawAbort = false;
    executeQaAnalystRun.mockImplementationOnce(
      (_p: unknown, opts: ExecuteAnalystOptions) =>
        new Promise((resolve) => {
          opts.signal?.addEventListener("abort", () => {
            sawAbort = true;
            resolve(okBatch());
          });
        }),
    );

    const running = store.getState().refine("slow follow-up");
    await vi.waitFor(() => expect(executeQaAnalystRun).toHaveBeenCalled());
    store.getState().startNew();
    await running;

    expect(sawAbort).toBe(true);
  });

  it("drops a pending follow-up when the draft is published", async () => {
    const rows = checkpointDisk();
    const store = reviewStore();
    executeQaAnalystRun.mockRejectedValueOnce(new Error("fetch failed"));
    await store.getState().refine("add negative paths");
    expect(store.getState().refineResumable).not.toBeNull();
    expect(rows.size).toBe(1);

    // Resuming after publish re-mints every case uid, which breaks publish's
    // okByUid idempotency map — the NEXT publish would duplicate every work
    // item in ADO. The offer has to go before the review breadcrumb can reach
    // it, and before a restart's probe can resurrect it.
    void store.getState().publish().catch(() => {});

    expect(store.getState().refineResumable).toBeNull();
    await vi.waitFor(() => expect(rows.size).toBe(0));
  });

  it("stacks two failed attempts at the same instruction instead of collapsing them", async () => {
    // Freeze the clock (Date only — the checkpoint writer's throttle still
    // needs a real setTimeout) so both rounds get a byte-identical
    // newTimestamp(). That's the collision case: the round-history match key
    // is second-granular, so only a RESUME may replace an earlier entry —
    // re-sending the same preset twice must not swallow the first attempt.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-01T00:00:00.000Z"));
    try {
      checkpointDisk();
      const store = reviewStore();
      executeQaAnalystRun.mockRejectedValue(new Error("fetch failed"));

      await store.getState().refine("/find-bugs");
      await store.getState().refine("/find-bugs");

      const rounds = store.getState().refineRounds;
      expect(rounds).toHaveLength(2);
      // Pin that the collision condition was genuinely exercised.
      expect(rounds[0].timestamp).toBe(rounds[1].timestamp);
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers instead of hanging when the saved row has no prompt to replay", async () => {
    const rows = checkpointDisk();
    const at = "2026-08-01T00:05:00.000Z";
    // Envelope is valid, so parseCheckpointRow accepts it; `prepared` is not.
    rows.set("rfn-broken", {
      runId: "rfn-broken",
      surface: "generator-refine",
      cwd: SESSION_RUN_ID,
      payload: JSON.stringify({
        v: 1,
        surface: "generator-refine",
        runId: "rfn-broken",
        sessionRunId: SESSION_RUN_ID,
        createdAt: "2026-08-01T00:00:00.000Z",
        modelId: "claude-sonnet-5",
        sourceRoot: null,
        round: {
          instruction: "x",
          startedAt: "2026-08-01T00:00:00.000Z",
          beforeCases: 1,
          beforeBugs: 0,
        },
        activity: [],
        transcript: null,
        lastOutcome: { at, kind: "cancelled" },
      }),
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: at,
    });

    const store = reviewStore();
    await store.getState().probeRefineCheckpoint();
    expect(store.getState().refineResumable?.runId).toBe("rfn-broken");

    await store.getState().resumeRefine();

    const s = store.getState();
    // The composer must not be pinned to its running strip with no way out.
    expect(s.isRefining).toBe(false);
    expect(s.refineResumable).toBeNull();
    expect(s.refineError).toContain("incomplete");
    expect(executeQaAnalystRun).not.toHaveBeenCalled();
    expect(rows.has("rfn-broken")).toBe(false);
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

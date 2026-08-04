import { beforeEach, describe, expect, it, vi } from "vitest";

// Every backend call the store makes goes through Tauri IPC; capturing it here
// is what lets us assert which commands a run did (and did NOT) issue.
const invoke = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));

// The engine is mocked ONLY for the resume-replay test below — everything else
// in the module (prepare, describeGeneration, …) stays real.
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
import {
  FINISH_NOW_NUDGE,
  type GeneratorCheckpointV1,
} from "@/modules/ai/lib/checkpointApi";
import { canOfferResume } from "@/modules/ai/lib/errorClass";
import {
  RESUME_TOPUP_TOKENS,
  SURFACE_STEP_CAPS,
  type ModelId,
} from "@/modules/ai/config";
import type {
  ExecuteAnalystOptions,
  PreparedAnalystRun,
} from "../lib/qaAnalystRun";

/** Commands the run actually issued, in order. */
function invokedCommands(): string[] {
  return invoke.mock.calls.map((c) => c[0] as string);
}

beforeEach(() => {
  invoke.mockClear();
  invoke.mockResolvedValue(undefined);
  executeQaAnalystRun.mockReset();
  // Pre-hydrated keys so ensureApiKeys resolves without touching the keychain,
  // and no best-practice files so that loader short-circuits too — leaving the
  // prefetch as pure awaits with no IPC of their own.
  useChatStore.setState({ keysLoaded: true, apiKeys: {} as never });
  usePreferencesStore.setState({ bestPracticeFiles: [], codeSearchEnabled: false });
});

describe("useGenerationSession — checkpointing a cancelled analyze", () => {
  it("writes no checkpoint when the user cancels during the ADO prefetch", async () => {
    const store = createGenerationSessionStore();
    // No plan/suite ⇒ the ADO block is skipped; the first await is the key
    // hydration, which is where cancel() lands.
    store.setState({ requirements: "Users can reset a forgotten password." });

    const run = store.getState().analyze();
    store.getState().cancel();
    await run;

    expect(store.getState().phase).toBe("input");
    // Nothing was spent, so nothing may be left behind to resume from.
    expect(invokedCommands()).not.toContain("ai_checkpoint_save");
    expect(store.getState().resumable).toBeNull();
  });

  it("releases the analyze claim on that early return, so resume still runs", async () => {
    const store = createGenerationSessionStore();
    store.setState({ requirements: "Users can reset a forgotten password." });

    const run = store.getState().analyze();
    store.getState().cancel();
    await run;

    // A leaked abort handle would make resumeAnalyze a silent no-op; reaching
    // the checkpoint read proves the claim was released.
    await store.getState().resumeAnalyze();
    expect(invokedCommands()).toContain("ai_checkpoint_get");
  });
});

function mkCheckpointPayload(
  partial: Partial<GeneratorCheckpointV1> = {},
): GeneratorCheckpointV1 {
  return {
    v: 1,
    surface: "generator",
    runId: "run-cp-1",
    createdAt: "2026-06-11T00:00:00.000Z",
    modelId: "claude-sonnet-5",
    sourceRoot: null,
    form: {
      requirements: "Users can reset a forgotten password.",
      changesets: "",
      attachments: [],
      attachedWorkItems: [],
      planId: 1,
      planName: "Plan A",
      suiteId: 2,
      suiteName: "Suite B",
      coverage: "full",
      suggestBugs: true,
      tagSourceBranch: true,
      overrideModelId: null,
    },
    prepared: { userPrompt: "prompt", attachments: [] },
    activity: [],
    transcript: { messages: [], stepsUsed: 5, usage: {} },
    lastOutcome: { at: "2026-06-11T00:05:00.000Z", kind: "step_cap" },
    ...partial,
  };
}

// The point of resume: the prior attempt's transcript rides along so its steps
// are never re-run (and never re-billed as fresh tool-loop work). This pins the
// store→engine handoff; taskRunner.test.ts pins engine→request.
describe("useGenerationSession — resumeAnalyze replays the paid-for transcript", () => {
  it("hands the engine the persisted transcript + top-up budget, with no ADO re-prefetch", async () => {
    const store = createGenerationSessionStore();
    const messages = [
      { role: "assistant" as const, content: "I already read the relevant files." },
    ];
    const payload = mkCheckpointPayload({
      transcript: { messages, stepsUsed: 5, usage: { totalTokens: 1234 } },
    });
    invoke.mockImplementation(async (cmd: unknown) =>
      cmd === "ai_checkpoint_get"
        ? {
            runId: payload.runId,
            surface: "generator",
            cwd: null,
            payload: JSON.stringify(payload),
            createdAt: payload.createdAt,
            updatedAt: "2026-06-11T00:05:00.000Z",
          }
        : undefined,
    );
    executeQaAnalystRun.mockResolvedValue({
      batch: {
        cases: [
          {
            title: "Reset password happy path",
            description: "",
            steps: [{ action: "a", expected: "b" }],
            tags: [],
            rationale: "",
            sourceLinks: [],
          },
        ],
        bugs: [],
      },
      rawText: "{}",
      durationMs: 1,
      ok: true,
      stepsUsed: 1,
      usage: {},
    });
    store.setState({
      phase: "input",
      runId: payload.runId,
      resumable: {
        stepsUsed: 5,
        hasTranscript: true,
        totalTokens: 1234,
        updatedAt: "2026-06-11T00:05:00.000Z",
        outcome: { at: "2026-06-11T00:05:00.000Z", kind: "step_cap" },
      },
    });

    await store.getState().resumeAnalyze();

    expect(executeQaAnalystRun).toHaveBeenCalledTimes(1);
    const [prepared, opts] = executeQaAnalystRun.mock.calls[0] as [
      PreparedAnalystRun,
      ExecuteAnalystOptions,
    ];
    // The checkpointed prompt is reused verbatim — no re-assembly.
    expect(prepared.userPrompt).toBe("prompt");
    // The transcript IS the savings: prior steps ride along instead of
    // being re-run. A budget-stopped resume also gets the smaller TOKEN top-up
    // and the explicit "finish now" user turn appended after the transcript.
    const resume = opts.resumeMessages ?? [];
    expect(resume[0]).toEqual(messages[0]);
    expect(resume[resume.length - 1]).toEqual({
      role: "user",
      content: FINISH_NOW_NUDGE,
    });
    expect(opts.tokenBudget).toBe(RESUME_TOPUP_TOKENS);
    expect(opts.maxSteps).toBe(SURFACE_STEP_CAPS.generator);
    // Resume never re-reads the suite — the paid-for prompt already has it.
    expect(invokedCommands()).not.toContain("ado_list_suite_cases");
    expect(store.getState().phase).toBe("review");
  });

  // The "step 27/8" class of bug, in the unit that now rations the run. Both
  // counters keep climbing cumulatively across resumes, so the readout's ceiling
  // has to be the prior total plus this call's grant — hand it the raw grant and
  // a run with plenty of room left renders as 240% of budget.
  it("a resumed run's budget readout stays coherent (prior spend + top-up)", async () => {
    const store = createGenerationSessionStore();
    const spentBefore = 1_200_000; // more than this call's whole top-up
    const payload = mkCheckpointPayload({
      transcript: {
        messages: [{ role: "assistant" as const, content: "read a lot" }],
        stepsUsed: 26,
        usage: { inputTokens: spentBefore, outputTokens: 0 },
      },
    });
    invoke.mockImplementation(async (cmd: unknown) =>
      cmd === "ai_checkpoint_get"
        ? {
            runId: payload.runId,
            surface: "generator",
            cwd: null,
            payload: JSON.stringify(payload),
            createdAt: payload.createdAt,
            updatedAt: "2026-06-11T00:05:00.000Z",
          }
        : undefined,
    );

    const seen: { used: number | null; budget: number | null }[] = [];
    executeQaAnalystRun.mockImplementation(
      async (_p: unknown, opts: ExecuteAnalystOptions) => {
        seen.push({
          used: store.getState().tokensUsed,
          budget: store.getState().tokenBudget,
        });
        opts.onCheckpoint?.({
          messages: [],
          stepsUsed: 1,
          usage: { inputTokens: 90_000, outputTokens: 1_000 },
        });
        seen.push({
          used: store.getState().tokensUsed,
          budget: store.getState().tokenBudget,
        });
        return {
          batch: { cases: [], bugs: [] },
          rawText: "{}",
          durationMs: 1,
          ok: false,
          reason: "empty" as const,
          stepsUsed: 1,
          usage: {},
        };
      },
    );
    store.setState({
      phase: "input",
      runId: payload.runId,
      resumable: {
        stepsUsed: 26,
        hasTranscript: true,
        totalTokens: spentBefore,
        updatedAt: "2026-06-11T00:05:00.000Z",
        outcome: { at: "2026-06-11T00:05:00.000Z", kind: "step_cap" },
      },
    });

    await store.getState().resumeAnalyze();

    // At the moment the resumed call starts: everything the earlier attempts
    // spent, against that plus the top-up.
    expect(seen[0]).toEqual({
      used: spentBefore,
      budget: spentBefore + RESUME_TOPUP_TOKENS,
    });
    // And after a step of the resumed call, still under its own ceiling.
    expect(seen[1]).toEqual({
      used: spentBefore + 91_000,
      budget: spentBefore + RESUME_TOPUP_TOKENS,
    });
    for (const s of seen) expect(s.used!).toBeLessThan(s.budget!);
  });
});

// The exact sequence from the field: reopen an interrupted run, press Resume,
// the connection dies before the model answers, press Resume again from the
// error screen. The second resume must continue from the SAME transcript —
// a failed resume attempt must never write an inputs-only checkpoint over
// the paid-for one.
describe("useGenerationSession — a failed resume keeps the transcript for the next attempt", () => {
  it("network-fail on resume → flushed checkpoint retains transcript → next resume replays it", async () => {
    const store = createGenerationSessionStore();
    const messages = [
      { role: "assistant" as const, content: "prior investigation turn" },
    ];
    const payload = mkCheckpointPayload({
      transcript: { messages, stepsUsed: 5, usage: { totalTokens: 999 } },
      lastOutcome: { at: "2026-06-11T00:05:00.000Z", kind: "cancelled" },
    });

    // Disk simulation: get() serves whatever the last ai_checkpoint_save
    // wrote (starting from the original row), so the second resume reads the
    // failed attempt's flush — the true round-trip, parse and all.
    let diskPayload = JSON.stringify(payload);
    invoke.mockImplementation(async (cmd: unknown, args?: unknown) => {
      if (cmd === "ai_checkpoint_save") {
        diskPayload = (args as { input: { payload: string } }).input.payload;
        return undefined;
      }
      if (cmd === "ai_checkpoint_get") {
        return {
          runId: payload.runId,
          surface: "generator",
          cwd: null,
          payload: diskPayload,
          createdAt: payload.createdAt,
          updatedAt: "2026-06-11T00:06:00.000Z",
        };
      }
      return undefined;
    });

    const seedResumable = () =>
      store.setState({
        phase: store.getState().phase === "error" ? "error" : "input",
        runId: payload.runId,
        resumable: {
          stepsUsed: 5,
          hasTranscript: true,
          totalTokens: 999,
          updatedAt: "2026-06-11T00:05:00.000Z",
          outcome: { at: "2026-06-11T00:05:00.000Z", kind: "cancelled" },
        },
      });
    seedResumable();

    // Attempt 1: the proxy is off — the request dies before any step lands.
    executeQaAnalystRun.mockRejectedValueOnce(new Error("fetch failed"));
    await store.getState().resumeAnalyze();

    const failed = store.getState();
    expect(failed.phase).toBe("error");
    // The affordance still reflects the PRIOR spend, not a reset run.
    expect(failed.resumable?.stepsUsed).toBe(5);
    // And the on-disk copy still carries the transcript.
    const flushed = JSON.parse(diskPayload) as {
      transcript: { messages: unknown[]; stepsUsed: number } | null;
      lastOutcome: { kind: string; errorKind?: string } | null;
    };
    expect(flushed.transcript?.messages).toHaveLength(1);
    expect(flushed.transcript?.stepsUsed).toBe(5);
    expect(flushed.lastOutcome).toMatchObject({
      kind: "error",
      errorKind: "network",
    });

    // Attempt 2: connection is back — the engine must receive the SAME
    // transcript as its continuation, not start the loop fresh.
    executeQaAnalystRun.mockResolvedValueOnce({
      batch: {
        cases: [
          {
            title: "Reset password happy path",
            description: "",
            steps: [{ action: "a", expected: "b" }],
            tags: [],
            rationale: "",
            sourceLinks: [],
          },
        ],
        bugs: [],
      },
      rawText: "{}",
      durationMs: 1,
      ok: true,
      stepsUsed: 1,
      usage: {},
    });
    await store.getState().resumeAnalyze();

    expect(executeQaAnalystRun).toHaveBeenCalledTimes(2);
    const [, opts2] = executeQaAnalystRun.mock.calls[1] as [
      PreparedAnalystRun,
      ExecuteAnalystOptions,
    ];
    expect(opts2.resumeMessages).toBeDefined();
    expect(opts2.resumeMessages?.[0]).toEqual(messages[0]);
    expect(store.getState().phase).toBe("review");
  });
});

// The reported failure, end to end: 22 steps and ~1.7M tokens of codebase
// reading, then a final message that carried no batch. The run "COMPLETED", so
// the store offered Discard and nothing else — and 22 steps of paid research
// went in the bin. The research is in the transcript; only the last hop failed.
describe("useGenerationSession — an empty answer AFTER real work is resumable", () => {
  /** Drive analyze() to a terminal `reason`, having banked `stepsUsed` steps
   *  and (optionally) a transcript, exactly as the engine would. */
  async function analyzeEndingWith(
    reason: "empty" | "schema_violation",
    opts: { stepsUsed: number; withTranscript: boolean; finishReason?: string },
  ) {
    const store = createGenerationSessionStore();
    executeQaAnalystRun.mockImplementation(
      async (_p: unknown, o: ExecuteAnalystOptions) => {
        o.onCheckpoint?.({
          messages: opts.withTranscript
            ? [{ role: "assistant", content: "I read 40 files." }]
            : [],
          stepsUsed: opts.stepsUsed,
          usage: { inputTokens: 1_700_000, outputTokens: 500 },
        });
        return {
          batch: { cases: [], bugs: [] },
          rawText: "",
          durationMs: 1,
          ok: false,
          reason,
          stepsUsed: opts.stepsUsed,
          usage: {},
          ...(opts.finishReason ? { finishReason: opts.finishReason } : {}),
        };
      },
    );
    store.setState({ requirements: "Users can reset a forgotten password." });
    await store.getState().analyze();
    return store;
  }

  it.each(["empty", "schema_violation"] as const)(
    "offers a resume after a %s answer that followed 22 steps",
    async (reason) => {
      const store = await analyzeEndingWith(reason, {
        stepsUsed: 22,
        withTranscript: true,
      });
      const s = store.getState();
      expect(s.phase).toBe("error");
      expect(s.resumable).not.toBeNull();
      expect(
        canOfferResume(s.resumable?.outcome, null, s.resumable),
      ).toBe(true);
      // …and the checkpoint that resume needs is on disk, not deleted.
      expect(invokedCommands()).toContain("ai_checkpoint_save");
      expect(invokedCommands()).not.toContain("ai_checkpoint_delete");
    },
  );

  // The instrument P0-B is really about: the run already knew why it ended and
  // nothing carried it. It goes into the outcome (so a reopened checkpoint
  // still knows) and into the leading sentence (so the user isn't sent to a
  // JSON-mode setting for a run that hit its output ceiling).
  it("persists the provider's finish reason and leads with the matching cause", async () => {
    const store = await analyzeEndingWith("empty", {
      stepsUsed: 22,
      withTranscript: true,
      finishReason: "length",
    });
    const s = store.getState();
    expect(s.resumable?.outcome?.finishReason).toBe("length");
    expect(String(s.error)).toMatch(/output-token ceiling/);
    expect(String(s.error)).not.toMatch(/JSON mode/);
  });

  it("keeps the connector wording when no finish reason was reported", async () => {
    const store = await analyzeEndingWith("empty", {
      stepsUsed: 0,
      withTranscript: false,
    });
    expect(String(store.getState().error)).toMatch(/JSON mode/);
  });

  it("records the real reason rather than flattening both to 'empty'", async () => {
    const store = await analyzeEndingWith("schema_violation", {
      stepsUsed: 22,
      withTranscript: true,
    });
    expect(store.getState().resumable?.outcome?.kind).toBe("schema_violation");
  });

  it("still refuses a run that answered nothing having read nothing", async () => {
    const store = await analyzeEndingWith("empty", {
      stepsUsed: 0,
      withTranscript: false,
    });
    const s = store.getState();
    // The checkpoint is still surfaced — it's the handle Discard hangs off —
    // but the gate says no, which is the pre-existing behaviour for this case.
    expect(s.resumable).not.toBeNull();
    expect(canOfferResume(s.resumable?.outcome, null, s.resumable)).toBe(false);
  });
});

describe("useGenerationSession — resumeAnalyze against a retired model", () => {
  it("errors and clears resumable instead of leaving the Resume button looping, and keeps the checkpoint row", async () => {
    const store = createGenerationSessionStore();
    const payload = mkCheckpointPayload({ modelId: "retired-model-x" as ModelId });

    invoke.mockResolvedValueOnce({
      runId: payload.runId,
      surface: "generator",
      cwd: null,
      payload: JSON.stringify(payload),
      createdAt: payload.createdAt,
      updatedAt: "2026-06-11T00:05:00.000Z",
    });

    // Mirrors the state loadCheckpoint leaves behind (a populated resumable
    // driving the resume banner) — the exact stale value that made the
    // "Resume run" button loop forever pre-fix.
    store.setState({
      phase: "input",
      runId: payload.runId,
      resumable: {
        stepsUsed: 5,
        hasTranscript: true,
        totalTokens: null,
        updatedAt: "2026-06-11T00:05:00.000Z",
        outcome: { at: "2026-06-11T00:05:00.000Z", kind: "step_cap" },
      },
    });

    await store.getState().resumeAnalyze();

    const s = store.getState();
    expect(s.phase).toBe("error");
    expect(s.resumable).toBeNull();
    expect(invokedCommands()).not.toContain("ai_checkpoint_delete");
  });
});

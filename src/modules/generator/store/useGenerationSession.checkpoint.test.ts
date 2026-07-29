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
import { RESUME_TOPUP_STEPS, type ModelId } from "@/modules/ai/config";
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
    // being re-run. A step-cap resume also gets the smaller top-up budget
    // and the explicit "finish now" user turn appended after the transcript.
    const resume = opts.resumeMessages ?? [];
    expect(resume[0]).toEqual(messages[0]);
    expect(resume[resume.length - 1]).toEqual({
      role: "user",
      content: FINISH_NOW_NUDGE,
    });
    expect(opts.maxSteps).toBe(RESUME_TOPUP_STEPS);
    // Resume never re-reads the suite — the paid-for prompt already has it.
    expect(invokedCommands()).not.toContain("ado_list_suite_cases");
    expect(store.getState().phase).toBe("review");
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

import { beforeEach, describe, expect, it, vi } from "vitest";

// Every backend call the store makes goes through Tauri IPC; capturing it here
// is what lets us assert which commands a run did (and did NOT) issue.
const invoke = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));

import { createGenerationSessionStore } from "./useGenerationSession";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { GeneratorCheckpointV1 } from "@/modules/ai/lib/checkpointApi";
import type { ModelId } from "@/modules/ai/config";

/** Commands the run actually issued, in order. */
function invokedCommands(): string[] {
  return invoke.mock.calls.map((c) => c[0] as string);
}

beforeEach(() => {
  invoke.mockClear();
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

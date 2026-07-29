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

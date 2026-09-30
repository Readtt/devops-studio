import { beforeEach, describe, expect, it, vi } from "vitest";

// A draft or checkpoint outlives the model it was run on. Restoring one that
// names a retired model used to put that id straight into state the generator
// renders through the throwing `getModel` — with no error boundary, the whole
// main window blanked, on every launch that rehydrated the tab.

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

import { createGenerationSessionStore } from "./useGenerationSession";
import type { GeneratorCheckpointV2 } from "@/modules/ai/lib/checkpointApi";
import type { GenerationRun } from "../lib/history";
import { canOfferResume, resumeUnavailableReason } from "@/modules/ai/lib/errorClass";

const draft = (overrideModelId: string | null): GenerationRun =>
  ({
    id: "run-1",
    timestamp: "2026-09-01T00:00:00Z",
    planId: null,
    planName: null,
    suiteId: null,
    suiteName: null,
    mode: "standard",
    cases: [],
    bugs: [],
    publishLog: [],
    status: "draft",
    draftPayload: { cases: [], bugs: [], overrideModelId },
  }) as unknown as GenerationRun;

const checkpoint = (modelId: string): GeneratorCheckpointV2 =>
  ({
    v: 2,
    surface: "generator",
    runId: "run-2",
    createdAt: "2026-09-01T00:00:00Z",
    modelId,
    repos: [],
    form: {
      requirements: "spec",
      changesets: "",
      attachments: [],
      attachedWorkItems: [],
      planId: null,
      planName: null,
      suiteId: null,
      suiteName: null,
      coverage: "standard",
      suggestBugs: true,
      tagSourceBranch: true,
      overrideModelId: modelId,
    },
    prepared: null,
    activity: [],
    transcript: null,
    lastOutcome: null,
  }) as unknown as GeneratorCheckpointV2;

let store: ReturnType<typeof createGenerationSessionStore>;
beforeEach(() => {
  store = createGenerationSessionStore();
});

describe("restoring a run whose model was retired", () => {
  it("a draft's run-only model moves to the provider's successor", () => {
    expect(store.getState().loadDraft(draft("deepseek-reasoner"))).toBe(true);
    expect(store.getState().overrideModelId).toBe("deepseek-v4-pro");
  });

  it("a model with no successor becomes 'use the default', never a ghost id", () => {
    store.getState().loadDraft(draft("a-model-nobody-serves"));
    expect(store.getState().overrideModelId).toBeNull();
  });

  // The transcript is pinned to the model that produced it. The card stays —
  // Discard is the way out of a checkpoint — but Resume isn't offered, and
  // the reason says why.
  it("a checkpoint restores its form, keeps Discard, and offers no Resume", () => {
    store.getState().loadCheckpoint(checkpoint("llama-3.3-70b-versatile"), "2026-09-01T00:00:00Z");
    expect(store.getState().overrideModelId).toBe("openai/gpt-oss-120b");
    const resumable = store.getState().resumable;
    expect(resumable).not.toBeNull();
    expect(canOfferResume(resumable!.outcome, null, resumable)).toBe(false);
    expect(resumeUnavailableReason(resumable!.outcome, resumable)).toMatch(/retired/);
  });

  it("a live model's checkpoint still offers Resume", () => {
    store.getState().loadCheckpoint(checkpoint("claude-sonnet-5"), "2026-09-01T00:00:00Z");
    expect(store.getState().overrideModelId).toBe("claude-sonnet-5");
    const resumable = store.getState().resumable;
    expect(canOfferResume(resumable!.outcome, null, resumable)).toBe(true);
  });
});

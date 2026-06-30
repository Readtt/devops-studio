import { describe, expect, it, vi } from "vitest";
import { createGenerationSessionStore } from "./useGenerationSession";
import type { ReviewedBug, ReviewedCase } from "../lib/draftBatchSchema";
import type { GenerationRun } from "../lib/history";

// Neutralize the debounced draft autosave (and any other Tauri IPC) so calling
// real store actions in node doesn't reach for a backend that isn't there.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

function mkCase(uid: string, partial: Partial<ReviewedCase> = {}): ReviewedCase {
  return {
    uid,
    decision: "keep",
    similarMatches: [],
    title: `Case ${uid}`,
    steps: [],
    ...partial,
  } as ReviewedCase;
}

function mkBug(
  uid: string,
  linkedDraftCaseIndex: number | null,
  partial: Partial<ReviewedBug> = {},
): ReviewedBug {
  return {
    uid,
    decision: "keep",
    title: "A bug with a sufficiently long title",
    reproSteps: "x",
    severity: "2 - High",
    codeRefs: [],
    linkedDraftCaseIndex,
    ...partial,
  } as ReviewedBug;
}

describe("useGenerationSession — auto-fail when a bug is attached", () => {
  it("attaching a bug to a case (setBugParent) auto-fails it", () => {
    const store = createGenerationSessionStore();
    store.setState({ cases: [mkCase("c0")], bugs: [mkBug("b0", null)] });

    store.getState().setBugParent("b0", "c0");

    const c = store.getState().cases[0];
    expect(c.desiredOutcome).toBe("Failed");
    expect(c.outcomeAuto).toBe(true);
  });

  it("unlinking the bug reverts the auto outcome", () => {
    const store = createGenerationSessionStore();
    store.setState({
      cases: [mkCase("c0", { desiredOutcome: "Failed", outcomeAuto: true })],
      bugs: [mkBug("b0", 0)],
    });

    store.getState().setBugParent("b0", null);

    expect(store.getState().cases[0].desiredOutcome).toBeUndefined();
  });

  it("skipping the only attached bug reverts the auto outcome", () => {
    const store = createGenerationSessionStore();
    store.setState({
      cases: [mkCase("c0", { desiredOutcome: "Failed", outcomeAuto: true })],
      bugs: [mkBug("b0", 0)],
    });

    store.getState().setBugDecision("b0", "skip");

    expect(store.getState().cases[0].desiredOutcome).toBeUndefined();
  });

  it("never overrides a manual outcome when a bug is attached", () => {
    const store = createGenerationSessionStore();
    store.setState({
      cases: [mkCase("c0", { desiredOutcome: "Passed", outcomeAuto: false })],
      bugs: [mkBug("b0", null)],
    });

    store.getState().setBugParent("b0", "c0");

    const c = store.getState().cases[0];
    expect(c.desiredOutcome).toBe("Passed");
    expect(c.outcomeAuto).toBe(false);
  });

  it("reopening a draft (loadDraft) auto-fails bug-linked cases — the same seed path analyze/refine use", () => {
    const store = createGenerationSessionStore();
    const run = {
      id: "run1",
      timestamp: "2026-06-11T00:00:00.000Z",
      planId: null,
      planName: null,
      suiteId: null,
      suiteName: null,
      mode: "",
      cases: [],
      bugs: [],
      publishLog: [],
      draftPayload: {
        cases: [mkCase("c0"), mkCase("c1")],
        bugs: [mkBug("b0", 1)], // linked to the second case
      },
    } satisfies GenerationRun;

    const ok = store.getState().loadDraft(run);

    expect(ok).toBe(true);
    expect(store.getState().cases[0].desiredOutcome).toBeUndefined();
    expect(store.getState().cases[1].desiredOutcome).toBe("Failed");
  });
});

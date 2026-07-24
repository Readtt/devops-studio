import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const listSuiteCases = vi.fn();
const hasKeyForModel = vi.fn();
const getConfidenceMany = vi.fn();
const scoreCases = vi.fn();
const invoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));
vi.mock("@/modules/ado", () => ({
  listSuiteCases: (...a: unknown[]) => listSuiteCases(...a),
}));
vi.mock("@/modules/ai", () => ({
  hasKeyForModel: (...a: unknown[]) => hasKeyForModel(...a),
}));
vi.mock("@/modules/ai/store/chatStore", () => ({
  useChatStore: {
    getState: () => ({
      selectedModelId: "claude-opus-5",
      ensureApiKeys: async () => ({}),
    }),
  },
}));
vi.mock("../lib/confidenceApi", () => ({
  getConfidenceMany: (...a: unknown[]) => getConfidenceMany(...a),
}));
vi.mock("../lib/runSuiteConfidence", () => ({
  scoreCases: (...a: unknown[]) => scoreCases(...a),
}));

import { useSuiteConfidence, LARGE_SUITE_THRESHOLD } from "./useSuiteConfidence";
import { usePreferencesStore } from "@/modules/settings/preferences";

const ref = (id: number) => ({ id, title: `case ${id}`, state: "Design" });

beforeEach(() => {
  listSuiteCases.mockReset();
  hasKeyForModel.mockReset();
  getConfidenceMany.mockReset();
  scoreCases.mockReset();
  invoke.mockReset();
  hasKeyForModel.mockReturnValue(true);
  getConfidenceMany.mockResolvedValue(new Map());
  scoreCases.mockResolvedValue(undefined);
  invoke.mockResolvedValue({ branch: "main", commit: "curr123", isRepo: true });
  // Default: no source dir, so staleness can't be determined and the discovery
  // skip behaves exactly as before (already-scored cases are skipped).
  usePreferencesStore.setState({ sourceRoot: null, codeSearchEnabled: true });
});

afterEach(() => {
  // Clear the module-level abort + auto-dismiss timer between tests.
  useSuiteConfidence.getState().cancel();
  useSuiteConfidence.getState().cancelPending();
  useSuiteConfidence.getState().dismiss();
  useSuiteConfidence.setState({ inFlight: new Set() });
});

describe("useSuiteConfidence.start discovery", () => {
  it("does not run when no key is configured", async () => {
    hasKeyForModel.mockReturnValue(false);
    await useSuiteConfidence.getState().start(1, 2, "Suite");
    const s = useSuiteConfidence.getState();
    expect(scoreCases).not.toHaveBeenCalled();
    expect(s.phase).toBe("done");
    expect(s.notice).toMatch(/API key/i);
  });

  it("skips already-scored cases and only scores the rest", async () => {
    listSuiteCases.mockResolvedValue([ref(1), ref(2), ref(3)]);
    getConfidenceMany.mockResolvedValue(new Map([[1, {} as never]])); // case 1 done
    await useSuiteConfidence.getState().start(1, 2, "Suite");
    expect(scoreCases).toHaveBeenCalledTimes(1);
    const passed = scoreCases.mock.calls[0][0] as Array<{ id: number }>;
    expect(passed.map((t) => t.id)).toEqual([2, 3]);
    expect(useSuiteConfidence.getState().phase).toBe("done");
  });

  it("re-scores cases whose verdict was graded against a different source state", async () => {
    // Source dir set + current HEAD = curr123; verdicts stamped with a
    // different sha are stale and must be re-scored, fresh ones skipped.
    usePreferencesStore.setState({ sourceRoot: "C:/repo", codeSearchEnabled: true });
    invoke.mockResolvedValue({ branch: "main", commit: "curr123", isRepo: true });
    listSuiteCases.mockResolvedValue([ref(1), ref(2), ref(3)]);
    getConfidenceMany.mockResolvedValue(
      new Map<number, unknown>([
        [1, { sourceSha: "curr123" }], // fresh → skip
        [2, { sourceSha: "old9999" }], // stale → re-score
        // case 3 has no verdict → score
      ]) as never,
    );
    await useSuiteConfidence.getState().start(1, 2, "Suite");
    expect(scoreCases).toHaveBeenCalledTimes(1);
    const passed = scoreCases.mock.calls[0][0] as Array<{ id: number }>;
    expect(passed.map((t) => t.id)).toEqual([2, 3]);
  });

  it("keeps skipping already-scored cases when source staleness can't be determined (no repo)", async () => {
    // sourceRoot null (beforeEach) → currentSha null → every stamped verdict is
    // 'unknown', so the legacy skip-already-scored behavior is preserved.
    listSuiteCases.mockResolvedValue([ref(1), ref(2), ref(3)]);
    getConfidenceMany.mockResolvedValue(
      new Map<number, unknown>([[1, { sourceSha: "old9999" }]]) as never,
    );
    await useSuiteConfidence.getState().start(1, 2, "Suite");
    const passed = scoreCases.mock.calls[0][0] as Array<{ id: number }>;
    expect(passed.map((t) => t.id)).toEqual([2, 3]); // case 1 still skipped
  });

  it("shows a notice and runs nothing when every case is already scored", async () => {
    listSuiteCases.mockResolvedValue([ref(1), ref(2)]);
    getConfidenceMany.mockResolvedValue(
      new Map([
        [1, {} as never],
        [2, {} as never],
      ]),
    );
    await useSuiteConfidence.getState().start(1, 2, "Suite");
    expect(scoreCases).not.toHaveBeenCalled();
    expect(useSuiteConfidence.getState().notice).toMatch(/already scored/i);
  });

  it("pushes each scored verdict into the store for live tab updates", async () => {
    listSuiteCases.mockResolvedValue([ref(1), ref(2)]);
    const verdict = { predictedOutcome: "Pass" } as never;
    scoreCases.mockImplementation(
      async (
        items: Array<{ id: number }>,
        cb: { onCaseDone: (id: number, v: unknown) => void },
      ) => {
        for (const t of items) cb.onCaseDone(t.id, verdict);
      },
    );
    await useSuiteConfidence.getState().start(1, 2, "Suite");
    const s = useSuiteConfidence.getState();
    expect(s.scored.get(1)).toBe(verdict);
    expect(s.scored.get(2)).toBe(verdict);
    expect(s.done).toBe(2);
  });

  it("beginCaseEval locks a case until endCaseEval releases it", () => {
    expect(useSuiteConfidence.getState().beginCaseEval(42)).toBe(true);
    expect(useSuiteConfidence.getState().inFlight.has(42)).toBe(true);
    // A second claim on the same case is refused — the lock that prevents a
    // bulk run and a manual re-analyze scoring it at once.
    expect(useSuiteConfidence.getState().beginCaseEval(42)).toBe(false);
    useSuiteConfidence.getState().endCaseEval(42);
    expect(useSuiteConfidence.getState().inFlight.has(42)).toBe(false);
    expect(useSuiteConfidence.getState().beginCaseEval(42)).toBe(true); // free again
  });

  it("parks a large batch behind a confirm gate, then runs it on confirm", async () => {
    const many = Array.from({ length: LARGE_SUITE_THRESHOLD + 1 }, (_, i) =>
      ref(i + 1),
    );
    listSuiteCases.mockResolvedValue(many);
    await useSuiteConfidence.getState().start(1, 2, "Big suite");

    // Gated: nothing runs yet, the batch is parked for confirmation.
    expect(scoreCases).not.toHaveBeenCalled();
    const pending = useSuiteConfidence.getState().pendingConfirm;
    expect(pending?.targets).toHaveLength(LARGE_SUITE_THRESHOLD + 1);
    expect(useSuiteConfidence.getState().phase).toBe("idle");

    // Confirm → the parked batch runs.
    useSuiteConfidence.getState().confirmPending();
    await vi.waitFor(() => expect(scoreCases).toHaveBeenCalledTimes(1));
    expect(useSuiteConfidence.getState().pendingConfirm).toBeNull();
  });
});

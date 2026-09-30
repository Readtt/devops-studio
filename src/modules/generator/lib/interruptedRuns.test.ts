import { beforeEach, describe, expect, it, vi } from "vitest";

// History's "interrupted" rows: orphaned generator checkpoints worth resuming.
// The listing uses the same gate as every Resume button, so a row it shows is
// a row whose Resume can work.

vi.mock("@/modules/ai/lib/checkpointApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/ai/lib/checkpointApi")>()),
  listCheckpoints: vi.fn(),
  getCheckpoint: vi.fn(),
}));

import { getCheckpoint, listCheckpoints } from "@/modules/ai/lib/checkpointApi";
import type { GeneratorCheckpointV2 } from "@/modules/ai/lib/checkpointApi";
import { loadInterruptedRuns } from "./interruptedRuns";

const list = vi.mocked(listCheckpoints);
const get = vi.mocked(getCheckpoint);

const checkpoint = (runId: string, modelId: string): GeneratorCheckpointV2 =>
  ({
    v: 2,
    surface: "generator",
    runId,
    createdAt: "2026-09-01T00:00:00Z",
    modelId,
    repos: [],
    form: {},
    prepared: null,
    activity: [],
    transcript: { messages: [{ role: "user", content: "spec" }], stepsUsed: 3 },
    lastOutcome: { at: "2026-09-01T00:05:00Z", kind: "cancelled" },
  }) as unknown as GeneratorCheckpointV2;

const serve = (...cps: GeneratorCheckpointV2[]) => {
  list.mockResolvedValue(
    cps.map((cp) => ({ runId: cp.runId, cwd: null, createdAt: "t0", updatedAt: "t1" })),
  );
  get.mockImplementation(async (runId) => {
    const payload = cps.find((cp) => cp.runId === runId);
    return payload ? { payload, createdAt: "t0", updatedAt: "t1" } : null;
  });
};

beforeEach(() => {
  list.mockReset();
  get.mockReset();
});

describe("loadInterruptedRuns", () => {
  it("lists a cancelled run on a live model", async () => {
    serve(checkpoint("run-live", "claude-sonnet-5"));
    expect((await loadInterruptedRuns()).map((r) => r.runId)).toEqual(["run-live"]);
  });

  // Its transcript is pinned to a model nobody serves any more; listing it
  // would offer a Resume that can only fail.
  it("leaves out a run pinned to a retired model", async () => {
    serve(checkpoint("run-live", "claude-sonnet-5"), checkpoint("run-gone", "gone-model"));
    expect((await loadInterruptedRuns()).map((r) => r.runId)).toEqual(["run-live"]);
  });

  // A discovered model's id is live by its shape, before any provider list
  // has loaded — so a restart doesn't hide a run until the catalogue arrives.
  it("keeps a run on a discovered model", async () => {
    serve(checkpoint("run-disc", "anthropic:claude-opus-5-6"));
    expect((await loadInterruptedRuns()).map((r) => r.runId)).toEqual(["run-disc"]);
  });

  it("degrades to nothing when the checkpoint list can't be read", async () => {
    list.mockRejectedValue(new Error("db locked"));
    expect(await loadInterruptedRuns()).toEqual([]);
  });
});

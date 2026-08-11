// The cost telemetry a run leaves on screen: how much it spent, how much of
// that the prompt cache absorbed, and how big its largest single request got.
// Phase 2 measured all three and nothing read them; this pins the wiring that
// carries them to the readout.

import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));

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
import type { ExecuteAnalystOptions } from "../lib/qaAnalystRun";
import type { RequestContextSignal } from "@/modules/ai/lib/contextEstimate";

const OK_BATCH = {
  batch: {
    cases: [
      {
        title: "Reset password happy path",
        description: "",
        steps: [{ action: "a", expected: "b" }],
        tags: [],
      },
    ],
    bugs: [],
  },
  rawText: "{}",
  durationMs: 1,
  ok: true as const,
  stepsUsed: 2,
  usage: {},
};

function signal(promptTokens: number): RequestContextSignal {
  return {
    promptTokens,
    windowTokens: 200_000,
    usableBudget: 192_000,
    ratio: promptTokens / 192_000,
    headroomTokens: 192_000 - promptTokens,
    shouldCompact: false,
    cacheHitRatio: null,
  };
}

beforeEach(() => {
  invoke.mockClear();
  invoke.mockResolvedValue(undefined);
  executeQaAnalystRun.mockReset();
  useChatStore.setState({ keysLoaded: true, apiKeys: {} as never });
  usePreferencesStore.setState({ bestPracticeFiles: [], codeSearchEnabled: false });
});

/** Drive one analyze with a scripted engine, and hand back the finished store. */
async function analyzeWith(
  script: (opts: ExecuteAnalystOptions) => void,
): ReturnType<typeof createGenerationSessionStore> extends infer S
  ? Promise<S>
  : never {
  const store = createGenerationSessionStore();
  store.setState({ requirements: "Users can reset a forgotten password." });
  executeQaAnalystRun.mockImplementation(
    async (_p: unknown, opts: ExecuteAnalystOptions) => {
      script(opts);
      return OK_BATCH;
    },
  );
  await store.getState().analyze();
  return store as never;
}

describe("useGenerationSession — run cost telemetry", () => {
  it("keeps the LARGEST request the run made, not the last one", async () => {
    // Spend is the sum of every request; occupancy is one request's own size.
    // The number worth comparing between runs is the peak — a run whose peak
    // fell while its total rose has been made cheaper per step, not cheaper.
    const store = await analyzeWith((opts) => {
      opts.onContextSignal?.(signal(40_000));
      opts.onContextSignal?.(signal(120_000));
      opts.onContextSignal?.(signal(90_000));
    });
    expect(store.getState().peakPromptTokens).toBe(120_000);
  });

  // Two DIFFERENT numbers, and keeping them apart is the point. `tokensUsed`
  // rations the run and is cost-equivalent (cache reads at a tenth, output at
  // 5x); `tokensInput` is the provider's raw count and is what the cache ratio
  // divides by. Collapse them and the ratio is computed against a denominator
  // that already discounted the very reads it's measuring — every run would
  // read as far better cached than it was.
  it("carries the cache split the readout divides by, undiscounted", async () => {
    const store = await analyzeWith((opts) => {
      opts.onCheckpoint?.({
        messages: [],
        stepsUsed: 1,
        usage: { inputTokens: 100_000, cacheReadTokens: 90_000 },
      });
    });
    const s = store.getState();
    expect(s.tokensInput).toBe(100_000);
    expect(s.tokensCached).toBe(90_000);
    // 10k fresh + 90k cached at 0.1 = 19k of budget, for 100k of tokens.
    expect(s.tokensUsed).toBe(19_000);
    // The ratio the release gate reads, off the raw pair.
    expect((s.tokensCached ?? 0) / (s.tokensInput ?? 1)).toBeCloseTo(0.9, 6);
  });

  it("leaves the cache count ABSENT when no step reported one", async () => {
    // Seeding it to 0 would render as "cache 0%" on every local endpoint —
    // reporting a cost regression on a run whose cost we simply can't see.
    const store = await analyzeWith((opts) => {
      opts.onCheckpoint?.({
        messages: [],
        stepsUsed: 1,
        usage: { inputTokens: 100_000 },
      });
    });
    expect(store.getState().tokensInput).toBe(100_000);
    expect(store.getState().tokensCached).toBeNull();
    // No cache detail ⇒ charged as all fresh, which is the conservative read.
    expect(store.getState().tokensUsed).toBe(100_000);
  });

  it("survives into the review phase, so two runs can be compared", async () => {
    const store = await analyzeWith((opts) => {
      opts.onContextSignal?.(signal(75_000));
      opts.onCheckpoint?.({
        messages: [],
        stepsUsed: 1,
        usage: { inputTokens: 100_000, cacheReadTokens: 80_000 },
      });
    });
    expect(store.getState().phase).toBe("review");
    expect(store.getState().tokensInput).toBe(100_000);
    expect(store.getState().tokensCached).toBe(80_000);
    expect(store.getState().peakPromptTokens).toBe(75_000);
  });

  it("starts each run from a clean slate", async () => {
    const store = await analyzeWith((opts) => {
      opts.onContextSignal?.(signal(500_000));
    });
    expect(store.getState().peakPromptTokens).toBe(500_000);
    store.getState().startNew();
    expect(store.getState().peakPromptTokens).toBeNull();
    expect(store.getState().tokensCached).toBeNull();
  });
});

// Reported: "in the refine input area in review tab, i dont see any cache stuff
// there or token stuff or anything." There was nothing to see — refine() ran
// the same engine on the same budget and wrote none of its usage anywhere, so
// the dock could show a live tool-call log with no cost beside it.
describe("useGenerationSession — follow-up cost telemetry", () => {
  /** Analyze once (to reach review), then run one follow-up with a scripted
   *  engine. Returns the store after the round settles. */
  async function refineWith(
    script: (opts: ExecuteAnalystOptions) => void,
  ): Promise<ReturnType<typeof createGenerationSessionStore>> {
    const store = (await analyzeWith(() => {})) as ReturnType<
      typeof createGenerationSessionStore
    >;
    executeQaAnalystRun.mockImplementation(
      async (_p: unknown, opts: ExecuteAnalystOptions) => {
        script(opts);
        return OK_BATCH;
      },
    );
    await store.getState().refine("tighten the steps");
    return store;
  }

  it("records what the round spent, in the same units analyze uses", async () => {
    const store = await refineWith((opts) => {
      opts.onCheckpoint?.({
        messages: [],
        stepsUsed: 3,
        usage: { inputTokens: 100_000, cacheReadTokens: 90_000 },
      });
    });
    const spend = store.getState().refineSpend;
    expect(spend?.stepsUsed).toBe(3);
    expect(spend?.tokensInput).toBe(100_000);
    expect(spend?.tokensCached).toBe(90_000);
    // Same cost-equivalent arithmetic as the analyze path: 10k fresh + 90k
    // cached at a tenth.
    expect(spend?.tokensUsed).toBe(19_000);
  });

  it("keeps the follow-up's spend OUT of the analyze readout", async () => {
    // The review header shows the analyze run's tokens beside that run's
    // duration and case count. A refine writing into those would silently
    // redefine what the header means, and blend two cache ratios into one that
    // describes neither.
    const store = await refineWith((opts) => {
      opts.onCheckpoint?.({
        messages: [],
        stepsUsed: 1,
        usage: { inputTokens: 400_000, cacheReadTokens: 10_000 },
      });
    });
    expect(store.getState().refineSpend?.tokensInput).toBe(400_000);
    expect(store.getState().tokensInput).not.toBe(400_000);
  });

  it("keeps the round's largest request, not its last", async () => {
    const store = await refineWith((opts) => {
      opts.onContextSignal?.(signal(40_000));
      opts.onContextSignal?.(signal(120_000));
      opts.onContextSignal?.(signal(90_000));
    });
    expect(store.getState().refineSpend?.peakPromptTokens).toBe(120_000);
    // And it did not leak into the analyze peak.
    expect(store.getState().peakPromptTokens).toBeNull();
  });

  it("leaves the cache count absent when the endpoint reports none", async () => {
    const store = await refineWith((opts) => {
      opts.onCheckpoint?.({
        messages: [],
        stepsUsed: 1,
        usage: { inputTokens: 50_000 },
      });
    });
    expect(store.getState().refineSpend?.tokensCached).toBeNull();
    expect(store.getState().refineSpend?.tokensUsed).toBe(50_000);
  });

  it("stamps the spend onto the round so the thinking history can price it", async () => {
    const store = await refineWith((opts) => {
      opts.onCheckpoint?.({
        messages: [],
        stepsUsed: 2,
        usage: { inputTokens: 80_000, cacheReadTokens: 60_000 },
      });
    });
    const rounds = store.getState().refineRounds;
    const round = rounds[rounds.length - 1];
    expect(round?.spend).toMatchObject({
      stepsUsed: 2,
      tokensInput: 80_000,
      tokensCached: 60_000,
    });
  });

  it("zeroes the meter at the start of the next round", async () => {
    const store = await refineWith((opts) => {
      opts.onCheckpoint?.({
        messages: [],
        stepsUsed: 5,
        usage: { inputTokens: 300_000 },
      });
    });
    expect(store.getState().refineSpend?.tokensInput).toBe(300_000);
    // A round that opens on the previous one's total reads as having spent it
    // before making a single request.
    executeQaAnalystRun.mockImplementation(async () => OK_BATCH);
    await store.getState().refine("and again");
    expect(store.getState().refineSpend?.tokensInput).toBeNull();
    expect(store.getState().refineSpend?.tokensUsed).toBe(0);
  });
});

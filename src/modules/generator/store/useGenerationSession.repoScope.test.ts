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
import { createRepo, type WorkspaceRepo } from "@/modules/settings/store";
import type { GeneratorCheckpointV2 } from "@/modules/ai/lib/checkpointApi";
import type { PreparedAnalystRun } from "../lib/qaAnalystRun";

const ONE = createRepo("C:/src/repo-one");
const TWO = createRepo("C:/src/repo-two");
const THREE = createRepo("C:/src/repo-three");

/** The repo list the engine was actually handed. */
function reposSentToEngine(): WorkspaceRepo[] {
  const prepared = executeQaAnalystRun.mock.calls[0]?.[0] as PreparedAnalystRun;
  return prepared?.repos ?? [];
}

/** The last checkpoint payload written to disk. */
function lastCheckpoint(): GeneratorCheckpointV2 | null {
  const calls = invoke.mock.calls.filter((c) => c[0] === "ai_checkpoint_save");
  const last = calls[calls.length - 1]?.[1] as
    | { input: { payload: string } }
    | undefined;
  return last ? (JSON.parse(last.input.payload) as GeneratorCheckpointV2) : null;
}

beforeEach(() => {
  invoke.mockClear();
  invoke.mockResolvedValue(undefined);
  executeQaAnalystRun.mockReset();
  executeQaAnalystRun.mockResolvedValue({
    batch: { cases: [], bugs: [] },
    rawText: "{}",
    durationMs: 1,
    ok: true,
    stepsUsed: 1,
    usage: {},
  });
  useChatStore.setState({ keysLoaded: true, apiKeys: {} as never });
  usePreferencesStore.setState({
    bestPracticeFiles: [],
    codeSearchEnabled: true,
    repos: [ONE, TWO, THREE],
  });
});

/** Run an analyze with no ADO target, so the prefetch is skipped and the only
 *  thing under test is what reaches the engine. */
async function analyzeWithScope(repoScope: string[] | null) {
  const store = createGenerationSessionStore();
  store.setState({
    requirements: "Users can reset a forgotten password.",
    repoScope,
  });
  await store.getState().analyze();
  return store;
}

describe("analyze narrows its reads to the run's repo scope", () => {
  it("reads every configured repo when the user narrowed nothing", async () => {
    await analyzeWithScope(null);
    expect(reposSentToEngine().map((r) => r.name)).toEqual([
      "repo-one",
      "repo-two",
      "repo-three",
    ]);
  });

  it("leaves out a deselected repo entirely", async () => {
    await analyzeWithScope([ONE.id, THREE.id]);
    expect(reposSentToEngine().map((r) => r.name)).toEqual([
      "repo-one",
      "repo-three",
    ]);
  });

  it("sends no repos at all when every chip is off", async () => {
    // Tool-less by design: buildSuiteChatTools([]) gives the run no read tools,
    // which is the per-run equivalent of turning code search off.
    await analyzeWithScope([]);
    expect(reposSentToEngine()).toEqual([]);
  });

  it("still sends nothing when code search is off globally", async () => {
    usePreferencesStore.setState({ codeSearchEnabled: false });
    await analyzeWithScope([ONE.id]);
    expect(reposSentToEngine()).toEqual([]);
  });
});

describe("the checkpoint carries the scope through a resume", () => {
  it("records the resolved repos AND the scope that produced them", async () => {
    await analyzeWithScope([TWO.id]);
    const cp = lastCheckpoint();
    // The resolved list is what a resume replays against…
    expect(cp?.repos.map((r) => r.name)).toEqual(["repo-two"]);
    // …and the scope is what re-renders the form's chips.
    expect(cp?.form.repoScope).toEqual([TWO.id]);
  });

  it("records a null scope as null, not as today's repo ids", async () => {
    // Freezing the ids would silently exclude a repo added before the resume.
    await analyzeWithScope(null);
    expect(lastCheckpoint()?.form.repoScope).toBeNull();
  });

  it("restores the narrowed scope when the checkpoint is loaded back", async () => {
    const store = await analyzeWithScope([TWO.id]);
    const cp = lastCheckpoint()!;
    store.getState().startNew();
    expect(store.getState().repoScope).toBeNull();

    store.getState().loadCheckpoint(cp, "2026-08-12T00:00:00.000Z");
    expect(store.getState().repoScope).toEqual([TWO.id]);
  });

  it("reads a checkpoint written before scopes existed as all repos", async () => {
    const store = await analyzeWithScope([TWO.id]);
    const legacy = lastCheckpoint()!;
    delete legacy.form.repoScope;
    store.getState().startNew();

    store.getState().loadCheckpoint(legacy, "2026-08-12T00:00:00.000Z");
    expect(store.getState().repoScope).toBeNull();
  });
});

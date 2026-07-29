import { beforeEach, describe, expect, it, vi } from "vitest";

// The store actions hit Tauri-backed git APIs; mock just those so we can drive
// the real zustand store in node. Everything else (LOCAL_CHANGES_SHA, types) is
// kept real via importOriginal.
vi.mock("./gitCommitApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./gitCommitApi")>();
  return {
    ...actual,
    listCommits: vi.fn(),
    commitDiff: vi.fn(),
    workingTreeDiff: vi.fn(),
  };
});
vi.mock("@/modules/git", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/git")>();
  return { ...actual, gitStatusSummary: vi.fn() };
});
// The run/resume paths: the engine, the row store, and the checkpoint store.
vi.mock("./runCommitReview", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./runCommitReview")>();
  return { ...actual, runCommitReview: vi.fn() };
});
vi.mock("./commitReviewApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./commitReviewApi")>();
  return { ...actual, saveCommitReview: vi.fn(), getCommitReview: vi.fn() };
});
vi.mock("@/modules/ai/lib/checkpointApi", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/modules/ai/lib/checkpointApi")>();
  return {
    ...actual,
    createCheckpointWriter: vi.fn(),
    getCheckpoint: vi.fn(),
    deleteCheckpoint: vi.fn(),
  };
});

import { useCommitReview, type CommitReviewSlice } from "./useCommitReview";
import {
  LOCAL_CHANGES_SHA,
  listCommits,
  commitDiff,
  workingTreeDiff,
  type CommitDiff,
  type CommitMeta,
} from "./gitCommitApi";
import { gitStatusSummary } from "@/modules/git";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { DEFAULT_MODEL_ID } from "@/modules/ai/config";
import { runCommitReview } from "./runCommitReview";
import {
  getCommitReview,
  saveCommitReview,
  type CommitReviewRow,
} from "./commitReviewApi";
import {
  createCheckpointWriter,
  deleteCheckpoint,
  getCheckpoint,
  type CommitReviewCheckpointV1,
} from "@/modules/ai/lib/checkpointApi";
import type { CandidateFinding } from "./schema";

const mockListCommits = vi.mocked(listCommits);
const mockCommitDiff = vi.mocked(commitDiff);
const mockWorkingTreeDiff = vi.mocked(workingTreeDiff);
const mockStatus = vi.mocked(gitStatusSummary);
const mockRun = vi.mocked(runCommitReview);
const mockSaveRow = vi.mocked(saveCommitReview);
const mockGetRow = vi.mocked(getCommitReview);
const mockCreateWriter = vi.mocked(createCheckpointWriter);
const mockGetCheckpoint = vi.mocked(getCheckpoint);
const mockDeleteCheckpoint = vi.mocked(deleteCheckpoint);

/** Every write the run made to its checkpoint, in order. */
type WriterCall = { kind: "save" | "flush" | "delete"; payload?: unknown };
let writerLog: WriterCall[] = [];

function lastFlushed(): CommitReviewCheckpointV1 | undefined {
  const flushes = writerLog.filter((w) => w.kind === "flush");
  return flushes[flushes.length - 1]?.payload as
    | CommitReviewCheckpointV1
    | undefined;
}

function meta(sha: string): CommitMeta {
  return {
    sha,
    shortSha: sha.slice(0, 7),
    subject: `c ${sha}`,
    author: "a",
    date: "d",
    isRoot: false,
  } as unknown as CommitMeta;
}

function localDiff(over: Partial<CommitDiff> = {}): CommitDiff {
  return {
    sha: LOCAL_CHANGES_SHA,
    shortSha: LOCAL_CHANGES_SHA,
    subject: "Uncommitted changes",
    author: "",
    date: "",
    isRoot: false,
    isMerge: false,
    isLocal: true,
    files: [{ path: "a.txt", additions: 1, deletions: 0, status: "modified" }],
    rawPatch: "patch",
    truncated: false,
    headSha: "abc1234",
    ...over,
  };
}

function commitDiffOf(sha: string): CommitDiff {
  return {
    ...localDiff(),
    sha,
    shortSha: sha.slice(0, 7),
    subject: `commit ${sha}`,
    isLocal: false,
  };
}

function cand(id: string): CandidateFinding {
  return {
    id,
    title: `finding ${id}`,
    category: "correctness",
    severity: "high",
    file: "a.ts",
    startLine: 1,
    endLine: 2,
    explanation: "because",
    evidence: "",
    confidence: "medium",
  };
}

function checkpoint(
  over: Partial<CommitReviewCheckpointV1> = {},
): CommitReviewCheckpointV1 {
  return {
    v: 1,
    surface: "commit-review",
    runId: "crun-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    modelId: DEFAULT_MODEL_ID,
    cwd: "C:/repo",
    sourceRoot: "C:/repo",
    inputs: {
      selectedShas: ["aaa"],
      diffs: [commitDiffOf("aaa")],
      context: "the ticket",
      attachments: [],
      workItems: [],
      contextBlocks: [],
    },
    stage: "verify",
    stage1Candidates: [cand("f1")],
    activity: [{ id: "a1", ts: 1, kind: "tool", toolName: "read_file" }],
    transcript: { messages: [], stepsUsed: 5, usage: { totalTokens: 100 } },
    lastOutcome: { at: "2026-01-01T00:01:00.000Z", kind: "cancelled" },
    ...over,
  };
}

function checkpointRow(payload = checkpoint()) {
  return {
    payload,
    createdAt: payload.createdAt,
    updatedAt: "2026-01-01T00:02:00.000Z",
  };
}

function savedRow(status: CommitReviewRow["status"] = "cancelled"): CommitReviewRow {
  return {
    runId: "crun-1",
    cwd: "C:/repo",
    commitSha: "aaa",
    commitShort: "aaa",
    commitSubject: "commit aaa",
    commits: JSON.stringify([{ sha: "aaa", short: "aaa", subject: "commit aaa" }]),
    status,
    modelId: DEFAULT_MODEL_ID,
    context: null,
    findings: "[]",
    appliedPatches: "{}",
    error: null,
    findingCount: 0,
    durationMs: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:02:00.000Z",
  };
}

function abortError(): Error {
  const e = new Error("Request aborted");
  e.name = "AbortError";
  return e;
}

function mkSlice(over: Partial<CommitReviewSlice>): CommitReviewSlice {
  return {
    cwd: "C:/repo",
    commits: [],
    commitsLoading: false,
    commitsError: null,
    hasLocalChanges: false,
    selectedShas: [],
    diffBySha: {},
    diffLoading: false,
    diffError: null,
    diffLoadSeq: 0,
    context: "",
    attachments: [],
    workItems: [],
    status: "idle",
    stage: null,
    activity: [],
    findings: [],
    appliedPatches: {},
    busy: false,
    abort: null,
    error: null,
    schemaViolationRaw: null,
    runId: null,
    createdAt: null,
    durationMs: null,
    modelId: null,
    resumable: null,
    ...over,
  } as unknown as CommitReviewSlice;
}

function seed(tabId: number, over: Partial<CommitReviewSlice>) {
  useCommitReview.setState((s) => {
    const next = new Map(s.byTab);
    next.set(tabId, mkSlice(over));
    return { byTab: next } as Partial<ReturnType<typeof useCommitReview.getState>>;
  });
}

const slice = (tabId: number) => useCommitReview.getState().byTab.get(tabId)!;

// The store dispatches a window event on every terminal; vitest runs in node.
vi.stubGlobal("window", { dispatchEvent: vi.fn() });

beforeEach(() => {
  vi.clearAllMocks();
  useCommitReview.setState({ byTab: new Map() } as Partial<
    ReturnType<typeof useCommitReview.getState>
  >);
  usePreferencesStore.setState({ sourceRoot: "C:/repo" } as Partial<
    ReturnType<typeof usePreferencesStore.getState>
  >);
  // Pre-hydrated keys so ensureApiKeys resolves without touching the keychain.
  useChatStore.setState({ keysLoaded: true, apiKeys: {} as never });
  mockStatus.mockResolvedValue({ dirty: false } as Awaited<
    ReturnType<typeof gitStatusSummary>
  >);
  mockListCommits.mockResolvedValue([]);
  mockWorkingTreeDiff.mockResolvedValue(localDiff());
  mockCommitDiff.mockImplementation(async (_cwd, sha) => commitDiffOf(sha));
  mockSaveRow.mockResolvedValue(undefined);
  mockDeleteCheckpoint.mockResolvedValue(undefined);
  writerLog = [];
  mockCreateWriter.mockImplementation(() => ({
    save: (payload) => {
      writerLog.push({ kind: "save", payload });
    },
    flush: async (payload) => {
      writerLog.push({ kind: "flush", payload });
    },
    delete: async () => {
      writerLog.push({ kind: "delete" });
    },
  }));
});

describe("toggleLocalChanges", () => {
  it("adds Local changes and loads its live working-tree diff", async () => {
    seed(1, { selectedShas: [] });
    await useCommitReview.getState().toggleLocalChanges(1);
    const s = slice(1);
    expect(s.selectedShas).toContain(LOCAL_CHANGES_SHA);
    expect(s.diffBySha[LOCAL_CHANGES_SHA]?.isLocal).toBe(true);
    expect(mockWorkingTreeDiff).toHaveBeenCalledWith("C:/repo");
  });

  it("removing Local changes drops its cached diff and invalidates findings", async () => {
    seed(1, {
      selectedShas: [LOCAL_CHANGES_SHA],
      diffBySha: { [LOCAL_CHANGES_SHA]: localDiff() },
      status: "done",
      findings: [{ id: "x" } as never],
    });
    await useCommitReview.getState().toggleLocalChanges(1);
    const s = slice(1);
    expect(s.selectedShas).not.toContain(LOCAL_CHANGES_SHA);
    expect(s.diffBySha[LOCAL_CHANGES_SHA]).toBeUndefined();
    expect(s.findings).toEqual([]);
    expect(s.status).toBe("idle");
  });
});

describe("refreshSource", () => {
  it("no-ops for a tab pinned to a different cwd than the source dir", async () => {
    seed(1, {
      cwd: "C:/other",
      selectedShas: [LOCAL_CHANGES_SHA],
      diffBySha: { [LOCAL_CHANGES_SHA]: localDiff() },
    });
    await useCommitReview.getState().refreshSource(1);
    expect(mockListCommits).not.toHaveBeenCalled();
    // The pinned tab's cached diff is left untouched.
    expect(slice(1).diffBySha[LOCAL_CHANGES_SHA]).toBeDefined();
  });

  it("no-ops while a review is running", async () => {
    seed(1, { busy: true });
    await useCommitReview.getState().refreshSource(1);
    expect(mockListCommits).not.toHaveBeenCalled();
  });

  it("reloads commits + dirty-state and re-reads the cached local diff after a switch", async () => {
    seed(1, {
      commits: [meta("old")],
      selectedShas: [LOCAL_CHANGES_SHA],
      diffBySha: { [LOCAL_CHANGES_SHA]: localDiff({ rawPatch: "stale" }) },
    });
    mockListCommits.mockResolvedValue([meta("new")]);
    mockStatus.mockResolvedValue({ dirty: true } as Awaited<
      ReturnType<typeof gitStatusSummary>
    >);
    mockWorkingTreeDiff.mockResolvedValue(localDiff({ rawPatch: "fresh" }));

    await useCommitReview.getState().refreshSource(1);

    const s = slice(1);
    expect(mockListCommits).toHaveBeenCalledWith("C:/repo", expect.any(Number));
    expect(s.commits.map((c) => c.sha)).toEqual(["new"]);
    expect(s.hasLocalChanges).toBe(true);
    // The stale local diff was dropped and re-read from the live tree.
    expect(mockWorkingTreeDiff).toHaveBeenCalledWith("C:/repo");
    expect(s.diffBySha[LOCAL_CHANGES_SHA]?.rawPatch).toBe("fresh");
  });

  it("drops an unselected cached local diff without re-reading it", async () => {
    seed(1, {
      commits: [meta("old")],
      selectedShas: [],
      diffBySha: { [LOCAL_CHANGES_SHA]: localDiff() },
    });
    await useCommitReview.getState().refreshSource(1);
    expect(slice(1).diffBySha[LOCAL_CHANGES_SHA]).toBeUndefined();
    expect(mockWorkingTreeDiff).not.toHaveBeenCalled();
  });
});

/** A tab mid-review of one commit, with a resume point on disk. */
function seedResumable(tabId: number) {
  seed(tabId, {
    runId: "crun-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "cancelled",
    resumable: {
      stage: "verify",
      stepsUsed: 5,
      totalTokens: 100,
      updatedAt: "2026-01-01T00:02:00.000Z",
      outcome: { at: "2026-01-01T00:01:00.000Z", kind: "cancelled" },
    },
  });
  mockGetCheckpoint.mockResolvedValue(checkpointRow());
}

describe("resume", () => {
  it("only one of two concurrent resumes claims the run", async () => {
    seedResumable(1);
    mockRun.mockResolvedValue({ ok: true, findings: [], durationMs: 1 });

    const state = useCommitReview.getState();
    await Promise.all([state.resume(1), state.resume(1)]);

    expect(mockRun).toHaveBeenCalledTimes(1);
  });

  it("runs on the snapshotted diffs — never a fresh read of the tree", async () => {
    seedResumable(1);
    mockRun.mockResolvedValue({ ok: true, findings: [], durationMs: 1 });

    await useCommitReview.getState().resume(1);

    expect(mockWorkingTreeDiff).not.toHaveBeenCalled();
    expect(mockCommitDiff).not.toHaveBeenCalled();
    const args = mockRun.mock.calls[0][0];
    expect(args.diffs).toEqual(checkpoint().inputs.diffs);
    expect(args.resume).toEqual({
      stage: "verify",
      stage1Candidates: [cand("f1")],
      resumeMessages: [],
      stepCapNudge: false,
    });
  });

  it("seeds the selection + diffs so the SAME row goes running, not an orphan", async () => {
    seedResumable(1);
    mockRun.mockResolvedValue({ ok: true, findings: [], durationMs: 1 });

    await useCommitReview.getState().resume(1);

    const running = mockSaveRow.mock.calls
      .map((c) => c[0])
      .find((r) => r.status === "running");
    expect(running).toBeDefined();
    // persistRow early-returns without diffs, so a populated `commits` blob is
    // proof the snapshot landed on the slice BEFORE the row was written.
    expect(JSON.parse(running!.commits!)).toEqual([
      { sha: "aaa", short: "aaa", subject: "commit aaa" },
    ]);
    expect(running!.runId).toBe("crun-1");
    expect(slice(1).selectedShas).toEqual(["aaa"]);
    expect(slice(1).diffBySha["aaa"]).toBeDefined();
  });

  it("seeds the activity log and the input context from the checkpoint", async () => {
    seedResumable(1);
    mockRun.mockResolvedValue({ ok: true, findings: [], durationMs: 1 });

    await useCommitReview.getState().resume(1);

    expect(slice(1).activity.map((a) => a.id)).toEqual(["a1"]);
    expect(slice(1).context).toBe("the ticket");
  });

  it("refuses a run pinned to a retired model, keeping the checkpoint", async () => {
    seedResumable(1);
    mockGetCheckpoint.mockResolvedValue(
      checkpointRow(
        checkpoint({ modelId: "gone-model" as CommitReviewCheckpointV1["modelId"] }),
      ),
    );

    await useCommitReview.getState().resume(1);

    expect(mockRun).not.toHaveBeenCalled();
    expect(mockDeleteCheckpoint).not.toHaveBeenCalled();
    expect(slice(1).error).toContain("no longer available");
    expect(slice(1).resumable).toBeNull();
  });

  it("drops the affordance when the checkpoint is gone", async () => {
    seedResumable(1);
    mockGetCheckpoint.mockResolvedValue(null);

    await useCommitReview.getState().resume(1);

    expect(mockRun).not.toHaveBeenCalled();
    expect(slice(1).resumable).toBeNull();
    expect(slice(1).busy).toBe(false);
  });

  it("asks for a step-cap top-up when that's what ended the last attempt", async () => {
    seedResumable(1);
    mockGetCheckpoint.mockResolvedValue(
      checkpointRow(
        checkpoint({
          lastOutcome: { at: "2026-01-01T00:01:00.000Z", kind: "step_cap" },
        }),
      ),
    );
    mockRun.mockResolvedValue({ ok: true, findings: [], durationMs: 1 });

    await useCommitReview.getState().resume(1);

    expect(mockRun.mock.calls[0][0].resume?.stepCapNudge).toBe(true);
  });
});

describe("run — checkpoint lifecycle", () => {
  /** A tab ready to review one commit. */
  function seedRunnable(tabId: number) {
    seed(tabId, {
      selectedShas: ["aaa"],
      diffBySha: { aaa: commitDiffOf("aaa") },
    });
  }

  it("flushes the inputs before the model call and drops them when done", async () => {
    seedRunnable(1);
    mockRun.mockResolvedValue({ ok: true, findings: [], durationMs: 12 });

    await useCommitReview.getState().run(1);

    // The inputs are on disk BEFORE the provider is touched…
    expect(writerLog[0].kind).toBe("flush");
    const base = writerLog[0].payload as CommitReviewCheckpointV1;
    expect(base.inputs.diffs.map((d) => d.sha)).toEqual(["aaa"]);
    expect(base.stage).toBe("investigate");
    // …and gone once the findings have a durable home in the row.
    expect(writerLog.filter((w) => w.kind === "delete")).toHaveLength(1);
    expect(slice(1).status).toBe("done");
    expect(slice(1).resumable).toBeNull();
  });

  it("keeps the checkpoint when the user stops a run, and offers a resume", async () => {
    seedRunnable(1);
    let reachedModel!: () => void;
    const atModel = new Promise<void>((r) => (reachedModel = r));
    mockRun.mockImplementation(
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(abortError()));
          reachedModel();
        }),
    );

    const running = useCommitReview.getState().run(1);
    await atModel;
    useCommitReview.getState().stop(1);
    await running;

    expect(writerLog.some((w) => w.kind === "delete")).toBe(false);
    expect(mockDeleteCheckpoint).not.toHaveBeenCalled();
    expect(lastFlushed()?.lastOutcome?.kind).toBe("cancelled");
    const s = slice(1);
    expect(s.status).toBe("cancelled");
    expect(s.resumable?.outcome?.kind).toBe("cancelled");
  });

  it("flushes stage-1 candidates the moment they parse, before verify", async () => {
    seedRunnable(1);
    mockRun.mockImplementation(async ({ onStage1Candidates }) => {
      onStage1Candidates?.([cand("f1")]);
      return { ok: true, findings: [], durationMs: 4 };
    });

    await useCommitReview.getState().run(1);

    // Flush (not a throttled save), carrying the stage the resume picks up at.
    const flushed = writerLog.filter((w) => w.kind === "flush");
    const candidatesFlush = flushed[1]?.payload as CommitReviewCheckpointV1;
    expect(candidatesFlush.stage).toBe("verify");
    expect(candidatesFlush.stage1Candidates).toEqual([cand("f1")]);
    expect(candidatesFlush.transcript).toBeNull();
  });

  it("a step-capped run is resumable; a badly-formatted answer is not", async () => {
    seedRunnable(1);
    mockRun.mockResolvedValue({
      ok: false,
      reason: "step_cap",
      rawText: "",
      durationMs: 9,
    });
    await useCommitReview.getState().run(1);
    expect(slice(1).resumable?.outcome?.kind).toBe("step_cap");
    expect(lastFlushed()?.lastOutcome?.kind).toBe("step_cap");
    expect(writerLog.some((w) => w.kind === "delete")).toBe(false);

    seedRunnable(2);
    mockRun.mockResolvedValue({
      ok: false,
      reason: "schema_violation",
      rawText: "nonsense",
      durationMs: 9,
    });
    await useCommitReview.getState().run(2);
    // The loop COMPLETED with a bad answer — resuming it would just re-fail.
    expect(slice(2).resumable).toBeNull();
    expect(slice(2).schemaViolationRaw).toBe("nonsense");
  });

  it("supersedes the previous run's checkpoint when a re-run mints a new id", async () => {
    seedRunnable(1);
    seed(1, {
      selectedShas: ["aaa"],
      diffBySha: { aaa: commitDiffOf("aaa") },
      runId: "crun-old",
    });
    mockRun.mockResolvedValue({ ok: true, findings: [], durationMs: 1 });

    await useCommitReview.getState().run(1);

    expect(mockDeleteCheckpoint).toHaveBeenCalledWith("crun-old");
  });
});

describe("ensure — checkpoint probe", () => {
  it("surfaces a died-mid-flight run's checkpoint as resumable", async () => {
    mockGetRow.mockResolvedValue(savedRow());
    mockGetCheckpoint.mockResolvedValue(checkpointRow());

    await useCommitReview.getState().ensure(7, "C:/repo", "crun-1");

    const s = slice(7);
    expect(s.resumable).toEqual({
      stage: "verify",
      stepsUsed: 5,
      totalTokens: 100,
      updatedAt: "2026-01-01T00:02:00.000Z",
      outcome: { at: "2026-01-01T00:01:00.000Z", kind: "cancelled" },
    });
    // The thin row carries no activity log; the checkpoint does.
    expect(s.activity.map((a) => a.id)).toEqual(["a1"]);
  });

  it("offers no resume for a run that answered with garbage", async () => {
    mockGetRow.mockResolvedValue(savedRow());
    mockGetCheckpoint.mockResolvedValue(
      checkpointRow(
        checkpoint({
          lastOutcome: {
            at: "2026-01-01T00:01:00.000Z",
            kind: "schema_violation",
          },
        }),
      ),
    );

    await useCommitReview.getState().ensure(8, "C:/repo", "crun-1");

    expect(slice(8).resumable).toBeNull();
  });

  it("offers no resume for a review that FINISHED, orphaned checkpoint or not", async () => {
    // writer.delete() swallows IPC failures, so a done run can leave a payload
    // behind whose lastOutcome is null — indistinguishable from a crash unless
    // the row's status is what decides.
    mockGetRow.mockResolvedValue(savedRow("done"));
    mockGetCheckpoint.mockResolvedValue(
      checkpointRow(checkpoint({ lastOutcome: null })),
    );

    await useCommitReview.getState().ensure(10, "C:/repo", "crun-1");

    expect(slice(10).status).toBe("done");
    expect(slice(10).resumable).toBeNull();
  });

  it("still offers a resume for a run interrupted before it wrote an outcome", async () => {
    // The case the probe exists for: the app died mid-run, so nothing flushed a
    // terminal outcome and the sweep flipped the row to "interrupted".
    mockGetRow.mockResolvedValue(savedRow("interrupted"));
    mockGetCheckpoint.mockResolvedValue(
      checkpointRow(checkpoint({ lastOutcome: null })),
    );

    await useCommitReview.getState().ensure(11, "C:/repo", "crun-1");

    expect(slice(11).resumable?.stage).toBe("verify");
    expect(slice(11).resumable?.outcome).toBeNull();
  });

  it("skips the probe entirely on a fresh (non-rehydrate) mount", async () => {
    await useCommitReview.getState().ensure(9, "C:/repo");
    expect(mockGetCheckpoint).not.toHaveBeenCalled();
    expect(slice(9).resumable).toBeNull();
  });
});

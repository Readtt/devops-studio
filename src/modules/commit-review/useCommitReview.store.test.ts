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
    listCheckpoints: vi.fn(),
  };
});

import { useCommitReview, type CommitReviewSlice } from "./useCommitReview";
import {
  LOCAL_CHANGES_SHA,
  commitKey,
  listCommits,
  commitDiff,
  workingTreeDiff,
  type RepoCommitDiff,
  type RepoCommitMeta,
} from "./gitCommitApi";
import { gitStatusSummary } from "@/modules/git";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { WorkspaceRepo } from "@/modules/settings/store";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { DEFAULT_MODEL_ID } from "@/modules/ai/config";
import {
  runCommitReview,
  type RunCommitReviewInput,
} from "./runCommitReview";
import { canOfferResume } from "@/modules/ai/lib/errorClass";
import {
  getCommitReview,
  saveCommitReview,
  type CommitReviewRow,
} from "./commitReviewApi";
import {
  createCheckpointWriter,
  deleteCheckpoint,
  getCheckpoint,
  listCheckpoints,
  type CommitReviewCheckpointV2,
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
const mockListCheckpoints = vi.mocked(listCheckpoints);

/** Every write the run made to its checkpoint, in order. */
type WriterCall = { kind: "save" | "flush" | "delete"; payload?: unknown };
let writerLog: WriterCall[] = [];

function lastFlushed(): CommitReviewCheckpointV2 | undefined {
  const flushes = writerLog.filter((w) => w.kind === "flush");
  return flushes[flushes.length - 1]?.payload as
    | CommitReviewCheckpointV2
    | undefined;
}

/** Two repos, stable ids — a review spans the workspace now, and the ids are
 *  half of every selection key. */
const REPO_A: WorkspaceRepo = {
  id: "ra",
  name: "repo-one",
  root: "C:/repo",
  ado: null,
};
const REPO_B: WorkspaceRepo = {
  id: "rb",
  name: "repo-two",
  root: "C:/repo-two",
  ado: null,
};
/** Selection keys for the fixtures below. */
const K = commitKey;
const LOCAL_A = K(REPO_A.id, LOCAL_CHANGES_SHA);
const LOCAL_B = K(REPO_B.id, LOCAL_CHANGES_SHA);

function meta(
  sha: string,
  repo: WorkspaceRepo = REPO_A,
  date = "2026-01-01T00:00:00Z",
): RepoCommitMeta {
  return {
    sha,
    shortSha: sha.slice(0, 7),
    subject: `c ${sha}`,
    author: "a",
    date,
    isRoot: false,
    repoId: repo.id,
    repoName: repo.name,
  } as unknown as RepoCommitMeta;
}

function localDiff(over: Partial<RepoCommitDiff> = {}): RepoCommitDiff {
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
    repoId: REPO_A.id,
    repoName: REPO_A.name,
    ...over,
  };
}

function commitDiffOf(sha: string, repo: WorkspaceRepo = REPO_A): RepoCommitDiff {
  return {
    ...localDiff(),
    sha,
    shortSha: sha.slice(0, 7),
    subject: `commit ${sha}`,
    isLocal: false,
    repoId: repo.id,
    repoName: repo.name,
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
  over: Partial<CommitReviewCheckpointV2> = {},
): CommitReviewCheckpointV2 {
  return {
    v: 2,
    surface: "commit-review",
    runId: "crun-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    modelId: DEFAULT_MODEL_ID,
    cwd: "workspace",
    repos: [REPO_A],
    repoScope: null,
    inputs: {
      selectedShas: [K(REPO_A.id, "aaa")],
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
    cwd: JSON.stringify([REPO_A.root]),
    commitSha: "aaa",
    commitShort: "aaa",
    commitSubject: "commit aaa",
    commits: JSON.stringify([
      {
        sha: "aaa",
        short: "aaa",
        subject: "commit aaa",
        repoId: REPO_A.id,
        repoName: REPO_A.name,
      },
    ]),
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
    repoIds: null,
    repoScope: null,
    commits: [],
    commitsLoading: false,
    commitsError: null,
    dirtyRepoIds: [],
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
  usePreferencesStore.setState({
    repos: [REPO_A, REPO_B],
    // Explicit, not defaulted: one test turns it off, and the runner shares
    // the module-level preferences store across the whole file.
    codeSearchEnabled: true,
  });
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
  mockListCheckpoints.mockResolvedValue([]);
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
  it("adds one repo's Local changes and loads ITS live working-tree diff", async () => {
    seed(1, { selectedShas: [] });
    await useCommitReview.getState().toggleLocalChanges(1, REPO_B.id);
    const s = slice(1);
    expect(s.selectedShas).toContain(LOCAL_B);
    expect(s.diffBySha[LOCAL_B]?.isLocal).toBe(true);
    // The repo that was asked for — not the first one in the registry.
    expect(mockWorkingTreeDiff).toHaveBeenCalledWith(REPO_B.root);
    expect(mockWorkingTreeDiff).not.toHaveBeenCalledWith(REPO_A.root);
  });

  it("two repos' Local changes coexist in one selection", async () => {
    seed(1, { selectedShas: [] });
    await useCommitReview.getState().toggleLocalChanges(1, REPO_A.id);
    await useCommitReview.getState().toggleLocalChanges(1, REPO_B.id);
    expect(slice(1).selectedShas).toEqual([LOCAL_A, LOCAL_B]);
    expect(slice(1).diffBySha[LOCAL_A]).toBeDefined();
    expect(slice(1).diffBySha[LOCAL_B]).toBeDefined();
  });

  it("removing one repo's Local changes leaves the other's alone", async () => {
    seed(1, {
      selectedShas: [LOCAL_A, LOCAL_B],
      diffBySha: {
        [LOCAL_A]: localDiff(),
        [LOCAL_B]: localDiff({ repoId: REPO_B.id, repoName: REPO_B.name }),
      },
      status: "done",
      findings: [{ id: "x" } as never],
    });
    await useCommitReview.getState().toggleLocalChanges(1, REPO_A.id);
    const s = slice(1);
    expect(s.selectedShas).toEqual([LOCAL_B]);
    expect(s.diffBySha[LOCAL_A]).toBeUndefined();
    expect(s.diffBySha[LOCAL_B]).toBeDefined();
    expect(s.findings).toEqual([]);
    expect(s.status).toBe("idle");
  });
});

describe("refreshSource", () => {
  it("no-ops for a root outside this review's repos", async () => {
    seed(1, {
      selectedShas: [LOCAL_A],
      diffBySha: { [LOCAL_A]: localDiff() },
    });
    await useCommitReview.getState().refreshSource(1, "C:/somewhere-else");
    expect(mockListCommits).not.toHaveBeenCalled();
    expect(slice(1).diffBySha[LOCAL_A]).toBeDefined();
  });

  // A root that round-trips through an event payload comes back in whichever
  // spelling that layer preferred; a raw !== made this return forever.
  it("matches the payload root the way the registry does — separators and case", async () => {
    seed(1, {
      // Unselected, so a match shows up as the cached diff being dropped and
      // NOT re-read — an unambiguous signal that the guard let the event in.
      selectedShas: [],
      diffBySha: { [LOCAL_A]: localDiff() },
    });
    await useCommitReview.getState().refreshSource(1, "c:\\REPO\\");
    expect(mockListCommits).toHaveBeenCalled();
    expect(slice(1).diffBySha[LOCAL_A]).toBeUndefined();
  });

  it("no-ops while a review is running", async () => {
    seed(1, { busy: true });
    await useCommitReview.getState().refreshSource(1);
    expect(mockListCommits).not.toHaveBeenCalled();
  });

  it("reloads commits + dirty-state and re-reads the cached local diff after a switch", async () => {
    seed(1, {
      commits: [meta("old")],
      selectedShas: [LOCAL_A],
      diffBySha: { [LOCAL_A]: localDiff({ rawPatch: "stale" }) },
    });
    mockListCommits.mockResolvedValue([meta("new")]);
    mockStatus.mockResolvedValue({ dirty: true } as Awaited<
      ReturnType<typeof gitStatusSummary>
    >);
    mockWorkingTreeDiff.mockResolvedValue(localDiff({ rawPatch: "fresh" }));

    await useCommitReview.getState().refreshSource(1, REPO_A.root);

    const s = slice(1);
    expect(mockListCommits).toHaveBeenCalledWith(REPO_A.root, expect.any(Number));
    expect(s.commits.map((c) => c.sha)).toEqual(["new"]);
    expect(s.dirtyRepoIds).toEqual([REPO_A.id]);
    // The stale local diff was dropped and re-read from the live tree.
    expect(mockWorkingTreeDiff).toHaveBeenCalledWith(REPO_A.root);
    expect(s.diffBySha[LOCAL_A]?.rawPatch).toBe("fresh");
  });

  // A branch switch moves ONE repo. Re-listing the others spends a `git log`
  // plus a `git status` per repo to re-learn what they already said.
  it("re-lists only the repo the event names, keeping the others' rows", async () => {
    seed(1, {
      commits: [meta("a-old"), meta("b-old", REPO_B)],
      commitsByRepo: {
        [REPO_A.id]: [meta("a-old")],
        [REPO_B.id]: [meta("b-old", REPO_B)],
      },
      dirtyRepoIds: [REPO_B.id],
      selectedShas: [],
    });
    mockListCommits.mockResolvedValue([meta("a-new")]);
    mockStatus.mockResolvedValue({ dirty: false } as Awaited<
      ReturnType<typeof gitStatusSummary>
    >);

    await useCommitReview.getState().refreshSource(1, REPO_A.root);

    const s = slice(1);
    expect(mockListCommits).toHaveBeenCalledTimes(1);
    expect(mockListCommits).toHaveBeenCalledWith(REPO_A.root, expect.any(Number));
    // repo-two never moved, so its rows survive verbatim — and its dirty flag
    // does too, rather than reading as clean because this pass didn't ask.
    expect(s.commits.map((c) => c.sha).sort()).toEqual(["a-new", "b-old"]);
    expect(s.dirtyRepoIds).toEqual([REPO_B.id]);
  });

  // Merging from the CAPPED list would shave rows off every repo the refresh
  // skipped, so a quiet repo erodes toward its floor one switch at a time.
  it("re-merges from what each repo returned, not from the capped timeline", async () => {
    const bRows = Array.from({ length: 40 }, (_, i) =>
      meta(`b${i}`, REPO_B, `2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`),
    );
    seed(1, {
      commits: [meta("a-old")], // capped view: only ONE of repo-two's 40 rows
      commitsByRepo: { [REPO_A.id]: [meta("a-old")], [REPO_B.id]: bRows },
      selectedShas: [],
    });
    mockListCommits.mockResolvedValue([meta("a-new")]);
    mockStatus.mockResolvedValue({ dirty: false } as Awaited<
      ReturnType<typeof gitStatusSummary>
    >);

    await useCommitReview.getState().refreshSource(1, REPO_A.root);

    const s = slice(1);
    expect(s.commits.filter((c) => c.repoId === REPO_B.id)).toHaveLength(40);
  });

  // Only the repo that moved has a stale working tree; dropping the others'
  // cached local diffs would re-read every repo on every branch switch.
  it("leaves another repo's cached local diff alone", async () => {
    const otherLocal = localDiff({
      rawPatch: "b-tree",
      repoId: REPO_B.id,
      repoName: REPO_B.name,
    });
    seed(1, {
      commits: [meta("old")],
      selectedShas: [LOCAL_A, LOCAL_B],
      diffBySha: { [LOCAL_A]: localDiff(), [LOCAL_B]: otherLocal },
    });

    await useCommitReview.getState().refreshSource(1, REPO_A.root);

    expect(slice(1).diffBySha[LOCAL_B]?.rawPatch).toBe("b-tree");
  });

  it("drops an unselected cached local diff without re-reading it", async () => {
    seed(1, {
      commits: [meta("old")],
      selectedShas: [],
      diffBySha: { [LOCAL_A]: localDiff() },
    });
    await useCommitReview.getState().refreshSource(1);
    expect(slice(1).diffBySha[LOCAL_A]).toBeUndefined();
    expect(mockWorkingTreeDiff).not.toHaveBeenCalled();
  });
});

// A fresh mount (app restart, new tab) must surface an interrupted run for its
// cwd instead of presenting a clean review that hides the recoverable spend
// behind History — that was exactly how users lost interrupted runs.
describe("ensure (fresh-mount adoption)", () => {
  const entry = (runId: string) => ({
    runId,
    cwd: "workspace",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:02:00.000Z",
  });

  it("adopts the newest resumable checkpoint: inputs, status, resume affordance", async () => {
    mockListCheckpoints.mockResolvedValue([entry("crun-1")]);
    mockGetCheckpoint.mockResolvedValue(
      checkpointRow(checkpoint({ lastOutcome: null })),
    );
    mockGetRow.mockResolvedValue(savedRow("interrupted"));

    await useCommitReview.getState().ensure(1, null, null);

    const s = slice(1);
    expect(mockListCheckpoints).toHaveBeenCalledWith("commit-review", "workspace");
    expect(s.runId).toBe("crun-1");
    expect(s.status).toBe("interrupted");
    expect(s.context).toBe("the ticket");
    expect(s.selectedShas).toEqual([K(REPO_A.id, "aaa")]);
    expect(s.diffBySha[K(REPO_A.id, "aaa")]).toBeDefined();
    expect(s.activity.map((a) => a.id)).toEqual(["a1"]);
    expect(s.resumable).toMatchObject({ stage: "verify", stepsUsed: 5 });
    // The snapshot seeded every selected diff — nothing re-read from git.
    expect(mockCommitDiff).not.toHaveBeenCalled();
  });

  it("maps a cancelled run to the cancelled banner state", async () => {
    mockListCheckpoints.mockResolvedValue([entry("crun-1")]);
    mockGetCheckpoint.mockResolvedValue(checkpointRow()); // cancelled outcome
    mockGetRow.mockResolvedValue(savedRow("cancelled"));

    await useCommitReview.getState().ensure(1, null, null);

    expect(slice(1).status).toBe("cancelled");
    expect(slice(1).error).toBeNull();
    expect(slice(1).resumable).not.toBeNull();
  });

  it("never steals a run another live tab already owns", async () => {
    seed(2, { runId: "crun-1", busy: true });
    mockListCheckpoints.mockResolvedValue([entry("crun-1")]);
    mockGetCheckpoint.mockResolvedValue(checkpointRow());

    await useCommitReview.getState().ensure(1, null, null);

    expect(slice(1).runId).toBeNull();
    expect(slice(1).resumable).toBeNull();
  });

  it("skips unresumable outcomes and finished runs' orphaned checkpoints", async () => {
    mockListCheckpoints.mockResolvedValue([entry("crun-a"), entry("crun-b")]);
    mockGetCheckpoint.mockImplementation(async (runId) =>
      runId === "crun-a"
        ? checkpointRow(
            checkpoint({
              runId: "crun-a",
              lastOutcome: {
                at: "2026-01-01T00:01:00.000Z",
                kind: "schema_violation",
              },
            }),
          )
        : checkpointRow(checkpoint({ runId: "crun-b", lastOutcome: null })),
    );
    // crun-b finished — its checkpoint is a delete-on-success orphan.
    mockGetRow.mockResolvedValue(savedRow("done"));

    await useCommitReview.getState().ensure(1, null, null);

    expect(slice(1).runId).toBeNull();
    expect(slice(1).resumable).toBeNull();
  });

  it("a rehydrate mount never probes the cwd checkpoint list", async () => {
    mockGetRow.mockResolvedValue(savedRow("done"));
    mockGetCheckpoint.mockResolvedValue(null);

    await useCommitReview.getState().ensure(1, "crun-1", null);

    expect(mockListCheckpoints).not.toHaveBeenCalled();
  });

  it("lifts a step-capped run's reason token so the error card classifies it", async () => {
    mockListCheckpoints.mockResolvedValue([entry("crun-1")]);
    mockGetCheckpoint.mockResolvedValue(
      checkpointRow(
        checkpoint({
          lastOutcome: { at: "2026-01-01T00:01:00.000Z", kind: "step_cap" },
        }),
      ),
    );
    // settleResult persists the raw token into the row's error column.
    mockGetRow.mockResolvedValue({ ...savedRow("error"), error: "step_cap" });

    await useCommitReview.getState().ensure(1, null, null);

    const s = slice(1);
    expect(s.status).toBe("error");
    expect(s.errorReason).toBe("step_cap");
    // Still resumable — that's the whole point of surfacing it.
    expect(s.resumable).toMatchObject({
      outcome: { kind: "step_cap" },
    });
  });

  it("two same-cwd tabs mounting together adopt the checkpoint exactly once", async () => {
    mockListCheckpoints.mockResolvedValue([entry("crun-1")]);
    mockGetCheckpoint.mockResolvedValue(
      checkpointRow(checkpoint({ lastOutcome: null })),
    );
    mockGetRow.mockResolvedValue(savedRow("interrupted"));

    // A duplicated commit-review tab survives restart; both fresh tabs fire
    // ensure() in the same tick, so both compute their pre-await claimed set
    // before either patches.
    const state = useCommitReview.getState();
    await Promise.all([
      state.ensure(1, null, null),
      state.ensure(2, null, null),
    ]);

    const adopted = [slice(1), slice(2)].filter((s) => s.runId === "crun-1");
    expect(adopted).toHaveLength(1);
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
      hasTranscript: true,
      outputCapRaisable: false,
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
      // Not an overflow, so the replay runs at the live eviction budget —
      // which is a no-op for a transcript that fit fine.
      afterOverflow: false,
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
      {
        sha: "aaa",
        short: "aaa",
        subject: "commit aaa",
        repoId: REPO_A.id,
        repoName: REPO_A.name,
      },
    ]);
    expect(running!.runId).toBe("crun-1");
    expect(slice(1).selectedShas).toEqual([K(REPO_A.id, "aaa")]);
    expect(slice(1).diffBySha[K(REPO_A.id, "aaa")]).toBeDefined();
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
        checkpoint({ modelId: "gone-model" as CommitReviewCheckpointV2["modelId"] }),
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
      selectedShas: [K(REPO_A.id, "aaa")],
      diffBySha: { [K(REPO_A.id, "aaa")]: commitDiffOf("aaa") },
    });
  }

  it("flushes the inputs before the model call and drops them when done", async () => {
    seedRunnable(1);
    mockRun.mockResolvedValue({ ok: true, findings: [], durationMs: 12 });

    await useCommitReview.getState().run(1);

    // The inputs are on disk BEFORE the provider is touched…
    expect(writerLog[0].kind).toBe("flush");
    const base = writerLog[0].payload as CommitReviewCheckpointV2;
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
    const candidatesFlush = flushed[1]?.payload as CommitReviewCheckpointV2;
    expect(candidatesFlush.stage).toBe("verify");
    expect(candidatesFlush.stage1Candidates).toEqual([cand("f1")]);
    expect(candidatesFlush.transcript).toBeNull();
  });

  // The candidates were already on disk; nothing ever put them on screen. A
  // review stopped or killed during the verify pass rendered an activity log
  // and read as a total loss of the investigate spend.
  describe("stranded stage-1 findings", () => {
    it("puts them in the slice as soon as they parse, before verify runs", async () => {
      seedRunnable(1);
      let seen: CandidateFinding[] | null = null;
      mockRun.mockImplementation(async ({ onStage1Candidates }) => {
        onStage1Candidates?.([cand("f1")]);
        seen = slice(1).stage1Candidates;
        return { ok: true, findings: [], durationMs: 4 };
      });

      await useCommitReview.getState().run(1);
      expect(seen).toEqual([cand("f1")]);
    });

    it("keeps them when the run is cancelled mid-verify", async () => {
      seedRunnable(1);
      let reachedVerify!: () => void;
      const atVerify = new Promise<void>((r) => (reachedVerify = r));
      mockRun.mockImplementation(
        ({ onStage1Candidates, signal }) =>
          new Promise((_resolve, reject) => {
            onStage1Candidates?.([cand("f1")]);
            signal?.addEventListener("abort", () => reject(abortError()));
            reachedVerify();
          }),
      );

      const running = useCommitReview.getState().run(1);
      await atVerify;
      useCommitReview.getState().stop(1);
      await running;

      expect(slice(1).status).toBe("cancelled");
      expect(slice(1).findings).toEqual([]);
      expect(slice(1).stage1Candidates).toEqual([cand("f1")]);
    });

    it("clears them once the run produces real findings — they'd render twice", async () => {
      seedRunnable(1);
      mockRun.mockImplementation(async ({ onStage1Candidates }) => {
        onStage1Candidates?.([cand("f1")]);
        return {
          ok: true,
          findings: [{ ...cand("f1"), verified: true }],
          durationMs: 4,
        };
      });
      await useCommitReview.getState().run(1);
      expect(slice(1).stage1Candidates).toBeNull();
      expect(slice(1).findings).toHaveLength(1);
    });

    it("restores them when an interrupted run is adopted on a fresh mount", async () => {
      mockListCheckpoints.mockResolvedValue([
        {
          runId: "crun-1",
          cwd: "workspace",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:02:00.000Z",
        },
      ]);
      mockGetCheckpoint.mockResolvedValue(checkpointRow());
      mockGetRow.mockResolvedValue(null);

      await useCommitReview.getState().ensure(1);
      expect(slice(1).stage1Candidates).toEqual([cand("f1")]);
    });

    it("drops them when the reviewed set changes — they were about other code", async () => {
      seedRunnable(1);
      seed(1, { stage1Candidates: [cand("f1")] });
      await useCommitReview.getState().toggleCommit(1, K(REPO_A.id, "bbb"));
      expect(slice(1).stage1Candidates).toBeNull();
    });
  });

  it("a step-capped run is resumable; a badly-formatted answer with nothing banked is not", async () => {
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
    // No onCheckpoint fired, so nothing was banked — the checkpoint is still
    // surfaced (it's the Discard handle) but the gate says no.
    const r2 = slice(2).resumable;
    expect(r2).not.toBeNull();
    expect(canOfferResume(r2?.outcome, null, r2)).toBe(false);
    expect(slice(2).schemaViolationRaw).toBe("nonsense");
  });

  // The generator's data loss, in Commit Review's clothes: the investigate pass
  // reads the diff and the code over many steps, then fumbles the JSON. The
  // findings were nearly bought; re-running pays for the whole investigation
  // again.
  it("a badly-formatted answer AFTER a real investigation IS resumable", async () => {
    seedRunnable(3);
    mockRun.mockImplementation(async (input: RunCommitReviewInput) => {
      input.onCheckpoint?.("investigate", {
        messages: [{ role: "assistant", content: "I read the diff." }],
        stepsUsed: 14,
        usage: { inputTokens: 900_000, outputTokens: 400 },
      });
      return {
        ok: false as const,
        reason: "schema_violation" as const,
        rawText: "nonsense",
        durationMs: 9,
      };
    });

    await useCommitReview.getState().run(3);

    const r = slice(3).resumable;
    expect(r?.stepsUsed).toBe(14);
    expect(canOfferResume(r?.outcome, null, r)).toBe(true);
    // …and the transcript it would replay is on disk, not deleted.
    expect(lastFlushed()?.lastOutcome?.kind).toBe("schema_violation");
    expect(writerLog.some((w) => w.kind === "delete")).toBe(false);
  });

  // A truncated review used to fail closed twice over: the outcome never
  // recorded the cap the attempt ran at, and the resumable never carried the
  // raisable flag — so `canOfferResume` had nothing to say yes on, and the user
  // paid for a full investigation and got no Resume button. The generator has
  // had this path since b7a2724.
  it("offers a resume for an answer the OUTPUT cap cut off", async () => {
    seedRunnable(4);
    mockRun.mockImplementation(async (input: RunCommitReviewInput) => {
      input.onCheckpoint?.("investigate", {
        messages: [{ role: "assistant", content: "I read the diff." }],
        stepsUsed: 9,
        usage: { inputTokens: 500_000, outputTokens: 64_000 },
      });
      return {
        ok: false as const,
        reason: "schema_violation" as const,
        finishReason: "length",
        // Below claude-opus-5's 128k ceiling, so a raise genuinely exists.
        outputCap: 64_000,
        rawText: "{ half a finding",
        durationMs: 9,
      };
    });

    await useCommitReview.getState().run(4);

    const r = slice(4).resumable;
    expect(r?.outputCapRaisable).toBe(true);
    expect(canOfferResume(r?.outcome, null, r)).toBe(true);
    // The cap the failed attempt ran at is on the outcome, which is the only
    // thing that lets the retry differ from it.
    expect(lastFlushed()?.lastOutcome?.outputCap).toBe(64_000);
    expect(lastFlushed()?.lastOutcome?.finishReason).toBe("length");
  });

  it("still refuses a truncation that already ran at the ceiling", async () => {
    // Retrying at the same cap deterministically meets the same ceiling and
    // bills the user twice for one failure.
    seedRunnable(5);
    mockRun.mockImplementation(async (input: RunCommitReviewInput) => {
      input.onCheckpoint?.("investigate", {
        messages: [{ role: "assistant", content: "I read the diff." }],
        stepsUsed: 9,
        usage: { inputTokens: 500_000 },
      });
      return {
        ok: false as const,
        reason: "schema_violation" as const,
        finishReason: "length",
        outputCap: 128_000,
        rawText: "{ half a finding",
        durationMs: 9,
      };
    });

    await useCommitReview.getState().run(5);

    const r = slice(5).resumable;
    expect(r?.outputCapRaisable).toBe(false);
    expect(canOfferResume(r?.outcome, null, r)).toBe(false);
  });

  it("supersedes the previous run's checkpoint when a re-run mints a new id", async () => {
    seedRunnable(1);
    seed(1, {
      selectedShas: [K(REPO_A.id, "aaa")],
      diffBySha: { [K(REPO_A.id, "aaa")]: commitDiffOf("aaa") },
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

    await useCommitReview.getState().ensure(7, "crun-1");

    const s = slice(7);
    expect(s.resumable).toEqual({
      stage: "verify",
      stepsUsed: 5,
      hasTranscript: false,
      // A cancel isn't a truncation, and this fixture's outcome carries no
      // outputCap — the gate fails closed, as it must.
      outputCapRaisable: false,
      totalTokens: 100,
      updatedAt: "2026-01-01T00:02:00.000Z",
      outcome: { at: "2026-01-01T00:01:00.000Z", kind: "cancelled" },
    });
    // The thin row carries no activity log; the checkpoint does.
    expect(s.activity.map((a) => a.id)).toEqual(["a1"]);
  });

  it("offers no resume for a run that answered with garbage having banked nothing", async () => {
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

    await useCommitReview.getState().ensure(8, "crun-1");

    // The checkpoint is surfaced so Discard is reachable; the gate is what
    // withholds the Resume button.
    const r = slice(8).resumable;
    expect(r).not.toBeNull();
    expect(canOfferResume(r?.outcome, null, r)).toBe(false);
  });

  it("DOES offer one when that garbage followed a real investigation", async () => {
    mockGetRow.mockResolvedValue(savedRow());
    mockGetCheckpoint.mockResolvedValue(
      checkpointRow(
        checkpoint({
          transcript: {
            messages: [{ role: "assistant", content: "I read the diff." }],
            stepsUsed: 14,
            usage: { totalTokens: 900_000 },
          },
          lastOutcome: {
            at: "2026-01-01T00:01:00.000Z",
            kind: "schema_violation",
          },
        }),
      ),
    );

    await useCommitReview.getState().ensure(12, "crun-1");

    const r = slice(12).resumable;
    expect(r?.hasTranscript).toBe(true);
    expect(canOfferResume(r?.outcome, null, r)).toBe(true);
  });

  it("offers no resume for a review that FINISHED, orphaned checkpoint or not", async () => {
    // writer.delete() swallows IPC failures, so a done run can leave a payload
    // behind whose lastOutcome is null — indistinguishable from a crash unless
    // the row's status is what decides.
    mockGetRow.mockResolvedValue(savedRow("done"));
    mockGetCheckpoint.mockResolvedValue(
      checkpointRow(checkpoint({ lastOutcome: null })),
    );

    await useCommitReview.getState().ensure(10, "crun-1");

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

    await useCommitReview.getState().ensure(11, "crun-1");

    expect(slice(11).resumable?.stage).toBe("verify");
    expect(slice(11).resumable?.outcome).toBeNull();
  });

  it("skips the probe entirely on a fresh (non-rehydrate) mount", async () => {
    await useCommitReview.getState().ensure(9);
    expect(mockGetCheckpoint).not.toHaveBeenCalled();
    expect(slice(9).resumable).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Multi-repo: one review, every configured repo
// ---------------------------------------------------------------------------

describe("loadCommits — the merged timeline", () => {
  it("reads every repo, tags each row, and merges newest-first", async () => {
    mockListCommits.mockImplementation(async (cwd) =>
      cwd === REPO_A.root
        ? [meta("a1", REPO_A, "2026-01-03T00:00:00Z"), meta("a2", REPO_A, "2026-01-01T00:00:00Z")]
        : [meta("b1", REPO_B, "2026-01-02T00:00:00Z")],
    );
    seed(1, {});

    await useCommitReview.getState().loadCommits(1);

    const s = slice(1);
    expect(mockListCommits).toHaveBeenCalledWith(REPO_A.root, expect.any(Number));
    expect(mockListCommits).toHaveBeenCalledWith(REPO_B.root, expect.any(Number));
    // Interleaved by commit date, not concatenated per repo.
    expect(s.commits.map((c) => c.sha)).toEqual(["a1", "b1", "a2"]);
    expect(s.commits.map((c) => c.repoName)).toEqual([
      REPO_A.name,
      REPO_B.name,
      REPO_A.name,
    ]);
  });

  // Offsets differ between clones, so a lexicographic compare on the ISO string
  // orders "…T01:00:00+02:00" ahead of "…T00:30:00Z" — which is 90 min later.
  it("compares instants, not ISO text, across timezone offsets", async () => {
    mockListCommits.mockImplementation(async (cwd) =>
      cwd === REPO_A.root
        ? [meta("later", REPO_A, "2026-01-01T00:30:00Z")]
        : [meta("earlier", REPO_B, "2026-01-01T01:00:00+02:00")],
    );
    seed(1, {});
    await useCommitReview.getState().loadCommits(1);
    expect(slice(1).commits.map((c) => c.sha)).toEqual(["later", "earlier"]);
  });

  // A repo that moved on disk must not empty the picker for the ones that
  // answered — the same "failure travels as data" rule the tool layer follows.
  it("keeps a readable repo's commits when another repo fails", async () => {
    mockListCommits.mockImplementation(async (cwd) => {
      if (cwd === REPO_B.root) throw new Error("not a git repository");
      return [meta("a1", REPO_A)];
    });
    seed(1, {});

    await useCommitReview.getState().loadCommits(1);

    const s = slice(1);
    expect(s.commits.map((c) => c.sha)).toEqual(["a1"]);
    expect(s.commitsError).toContain(REPO_B.name);
    expect(s.commitsError).toContain("not a git repository");
  });

  it("reports each repo's dirty state independently", async () => {
    mockStatus.mockImplementation(async (cwd) =>
      ({ dirty: cwd === REPO_B.root }) as Awaited<
        ReturnType<typeof gitStatusSummary>
      >,
    );
    seed(1, {});
    await useCommitReview.getState().loadCommits(1);
    expect(slice(1).dirtyRepoIds).toEqual([REPO_B.id]);
  });

  // Removing a repo in Settings re-runs this pass (the pane watches the repo
  // signature). Its commits leave the picker, but its SELECTION keys used to
  // stay — so the trigger counted commits that no longer had a row, and a run
  // started against changes it could no longer read.
  it("drops selections and cached diffs belonging to a removed repo", async () => {
    mockListCommits.mockImplementation(async (cwd) =>
      cwd === REPO_A.root ? [meta("a1", REPO_A)] : [meta("b1", REPO_B)],
    );
    seed(1, {
      selectedShas: [K(REPO_A.id, "a1"), K(REPO_B.id, "b1"), LOCAL_B],
      diffBySha: {
        [K(REPO_A.id, "a1")]: commitDiffOf("a1"),
        [K(REPO_B.id, "b1")]: commitDiffOf("b1"),
      },
    });

    // Repo B leaves the workspace.
    usePreferencesStore.setState({ repos: [REPO_A] });
    await useCommitReview.getState().loadCommits(1);

    const s = slice(1);
    expect(s.commits.map((c) => c.sha)).toEqual(["a1"]);
    expect(s.selectedShas).toEqual([K(REPO_A.id, "a1")]);
    expect(Object.keys(s.diffBySha)).toEqual([K(REPO_A.id, "a1")]);
  });

  it("leaves selections alone when every repo is still configured", async () => {
    mockListCommits.mockImplementation(async (cwd) =>
      cwd === REPO_A.root ? [meta("a1", REPO_A)] : [meta("b1", REPO_B)],
    );
    const picked = [K(REPO_A.id, "a1"), K(REPO_B.id, "b1"), LOCAL_B];
    seed(1, { selectedShas: picked });

    await useCommitReview.getState().loadCommits(1);

    expect(slice(1).selectedShas).toEqual(picked);
  });

  // A `source-git-changed` event narrows a refresh to one repo while the full
  // pass `ensure` kicked off is still awaiting its reads. Both write the same
  // buckets, and without a token the later-RESOLVING pass wins whichever was
  // issued first — folding pre-switch history back over the branch the user
  // just moved to.
  it("keeps a narrowed refresh's rows when the full pass it raced resolves last", async () => {
    let releaseFull = () => {};
    let readsOfA = 0;
    mockListCommits.mockImplementation(async (cwd) => {
      if (cwd !== REPO_A.root) return [meta("b1", REPO_B)];
      readsOfA++;
      if (readsOfA === 1) {
        // The full pass, issued first — held until the narrowed one has landed.
        await new Promise<void>((r) => (releaseFull = r));
        return [meta("before-switch", REPO_A)];
      }
      return [meta("after-switch", REPO_A)];
    });
    seed(1, {});

    const full = useCommitReview.getState().loadCommits(1);
    await useCommitReview.getState().loadCommits(1, REPO_A.root);
    releaseFull();
    await full;

    const shas = slice(1).commits.map((c) => c.sha);
    expect(shas).toContain("after-switch");
    expect(shas).not.toContain("before-switch");
    // The repos the narrowed pass never read still get the full pass's answer.
    expect(shas).toContain("b1");
    // And the pass that lost the race must not re-raise the spinner it no
    // longer owns — nothing would be left to lower it.
    expect(slice(1).commitsLoading).toBe(false);
  });

  it("a status probe failing only hides that repo's local row", async () => {
    mockStatus.mockImplementation(async (cwd) => {
      if (cwd === REPO_A.root) throw new Error("status failed");
      return { dirty: true } as Awaited<ReturnType<typeof gitStatusSummary>>;
    });
    mockListCommits.mockResolvedValue([meta("a1")]);
    seed(1, {});
    await useCommitReview.getState().loadCommits(1);
    expect(slice(1).dirtyRepoIds).toEqual([REPO_B.id]);
    expect(slice(1).commitsError).toBeNull();
  });
});

describe("loadDiffs — per repo", () => {
  it("reads each selected change from ITS OWN repo root", async () => {
    seed(1, {
      selectedShas: [K(REPO_A.id, "aaa"), K(REPO_B.id, "bbb")],
    });

    await useCommitReview.getState().loadDiffs(1);

    expect(mockCommitDiff).toHaveBeenCalledWith(REPO_A.root, "aaa");
    expect(mockCommitDiff).toHaveBeenCalledWith(REPO_B.root, "bbb");
    const s = slice(1);
    expect(s.diffBySha[K(REPO_A.id, "aaa")]?.repoName).toBe(REPO_A.name);
    expect(s.diffBySha[K(REPO_B.id, "bbb")]?.repoName).toBe(REPO_B.name);
  });

  it("surfaces a change whose repo left the workspace instead of misreading it", async () => {
    seed(1, { selectedShas: [K("gone", "aaa")] });
    await useCommitReview.getState().loadDiffs(1);
    expect(mockCommitDiff).not.toHaveBeenCalled();
    expect(slice(1).diffError).toContain("no longer in your workspace");
  });
});

describe("read scope", () => {
  function seedTwoRepoRun(tabId: number) {
    seed(tabId, {
      selectedShas: [K(REPO_A.id, "aaa")],
      diffBySha: { [K(REPO_A.id, "aaa")]: commitDiffOf("aaa") },
    });
    mockRun.mockResolvedValue({ ok: true, findings: [], durationMs: 1 });
  }

  it("hands the engine every repo by default", async () => {
    seedTwoRepoRun(1);
    await useCommitReview.getState().run(1);
    expect(mockRun.mock.calls[0][0].repos.map((r) => r.id)).toEqual([
      REPO_A.id,
      REPO_B.id,
    ]);
  });

  it("narrows the engine's repos to the scope, without touching the selection", async () => {
    seedTwoRepoRun(1);
    useCommitReview.getState().toggleRepo(1, REPO_B.id);

    await useCommitReview.getState().run(1);

    expect(mockRun.mock.calls[0][0].repos.map((r) => r.id)).toEqual([REPO_A.id]);
    // The picked commits are a different concept — deselecting a repo from the
    // read scope must not silently drop a ticked commit.
    expect(slice(1).selectedShas).toEqual([K(REPO_A.id, "aaa")]);
  });

  it("deselecting every repo makes the run tool-less", async () => {
    seedTwoRepoRun(1);
    useCommitReview.getState().toggleRepo(1, REPO_A.id);
    useCommitReview.getState().toggleRepo(1, REPO_B.id);
    await useCommitReview.getState().run(1);
    expect(mockRun.mock.calls[0][0].repos).toEqual([]);
  });

  it("code search off beats any scope — nothing reads source", async () => {
    usePreferencesStore.setState({ codeSearchEnabled: false });
    seedTwoRepoRun(1);
    await useCommitReview.getState().run(1);
    expect(mockRun.mock.calls[0][0].repos).toEqual([]);
  });

  it("persists the scope with the checkpoint so a resume can't widen it", async () => {
    seedTwoRepoRun(1);
    useCommitReview.getState().toggleRepo(1, REPO_B.id);

    await useCommitReview.getState().run(1);

    const base = writerLog[0].payload as CommitReviewCheckpointV2;
    expect(base.repoScope).toEqual([REPO_A.id]);
    expect(base.repos.map((r) => r.id)).toEqual([REPO_A.id]);
    // Filed under the workspace scope, not a directory.
    expect(base.cwd).toBe("workspace");
  });
});

describe("persistence — the review's own repos", () => {
  it("saves the workspace's repo roots as a JSON array", async () => {
    seed(1, {
      selectedShas: [K(REPO_A.id, "aaa")],
      diffBySha: { [K(REPO_A.id, "aaa")]: commitDiffOf("aaa") },
    });
    mockRun.mockResolvedValue({ ok: true, findings: [], durationMs: 1 });

    await useCommitReview.getState().run(1);

    const row = mockSaveRow.mock.calls[0][0];
    expect(JSON.parse(row.cwd)).toEqual([REPO_A.root, REPO_B.root]);
  });

  // Bug #8: reopening bound the review to whatever repo was current.
  it("reopening a saved run restores ITS repos, not today's", async () => {
    mockGetRow.mockResolvedValue({
      ...savedRow("done"),
      cwd: JSON.stringify([REPO_B.root]),
    });
    mockGetCheckpoint.mockResolvedValue(null);

    await useCommitReview.getState().ensure(1, "crun-1");

    expect(slice(1).repoIds).toEqual([REPO_B.id]);
    // …and only that repo's history is listed.
    expect(mockListCommits).toHaveBeenCalledWith(REPO_B.root, expect.any(Number));
    expect(mockListCommits).not.toHaveBeenCalledWith(
      REPO_A.root,
      expect.any(Number),
    );
  });

  it("reads a legacy single-path cwd as the one repo it names", async () => {
    mockGetRow.mockResolvedValue({ ...savedRow("done"), cwd: REPO_B.root });
    mockGetCheckpoint.mockResolvedValue(null);
    await useCommitReview.getState().ensure(1, "crun-1");
    expect(slice(1).repoIds).toEqual([REPO_B.id]);
  });

  // A dead pane helps nobody: the findings are historical either way.
  it("falls back to the live registry when none of the saved repos resolve", async () => {
    mockGetRow.mockResolvedValue({
      ...savedRow("done"),
      cwd: JSON.stringify(["C:/deleted-long-ago"]),
    });
    mockGetCheckpoint.mockResolvedValue(null);
    await useCommitReview.getState().ensure(1, "crun-1");
    expect(slice(1).repoIds).toBeNull();
  });

  it("keys a legacy row's bare shas to the first repo", async () => {
    mockGetRow.mockResolvedValue({
      ...savedRow("done"),
      cwd: REPO_A.root,
      commits: JSON.stringify([{ sha: "aaa", short: "aaa", subject: "c" }]),
    });
    mockGetCheckpoint.mockResolvedValue(null);
    await useCommitReview.getState().ensure(1, "crun-1");
    expect(slice(1).selectedShas).toEqual([K(REPO_A.id, "aaa")]);
  });
});

describe("adoption — the workspace has to still be the workspace", () => {
  const entry = (runId: string) => ({
    runId,
    cwd: "workspace",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:02:00.000Z",
  });

  it("declines a checkpoint whose repo is no longer configured", async () => {
    mockListCheckpoints.mockResolvedValue([entry("crun-1")]);
    mockGetCheckpoint.mockResolvedValue(
      checkpointRow(
        checkpoint({
          lastOutcome: null,
          repos: [{ id: "gone", name: "gone", root: "C:/gone", ado: null }],
        }),
      ),
    );
    mockGetRow.mockResolvedValue(savedRow("interrupted"));

    await useCommitReview.getState().ensure(1);

    // Resuming would replay a transcript against tools that can't reach the
    // repo it read — worse than not offering the resume at all.
    expect(slice(1).runId).toBeNull();
    expect(slice(1).resumable).toBeNull();
  });

  it("restores the scope the interrupted run started with", async () => {
    mockListCheckpoints.mockResolvedValue([entry("crun-1")]);
    mockGetCheckpoint.mockResolvedValue(
      checkpointRow(checkpoint({ lastOutcome: null, repoScope: [REPO_A.id] })),
    );
    mockGetRow.mockResolvedValue(savedRow("interrupted"));

    await useCommitReview.getState().ensure(1);

    expect(slice(1).repoScope).toEqual([REPO_A.id]);
  });

  // A checkpoint written before commit review went multi-repo carries untagged
  // diffs and bare shas under a single root.
  it("keys a pre-multi-repo checkpoint's snapshot to the first repo", async () => {
    const legacy = checkpoint({ lastOutcome: null });
    mockListCheckpoints.mockResolvedValue([entry("crun-1")]);
    mockGetCheckpoint.mockResolvedValue(
      checkpointRow({
        ...legacy,
        inputs: {
          ...legacy.inputs,
          selectedShas: ["aaa"],
          diffs: [
            {
              ...commitDiffOf("aaa"),
              repoId: undefined,
              repoName: undefined,
            } as unknown as (typeof legacy.inputs.diffs)[number],
          ],
        },
      }),
    );
    mockGetRow.mockResolvedValue(savedRow("interrupted"));

    await useCommitReview.getState().ensure(1);

    expect(slice(1).selectedShas).toEqual([K(REPO_A.id, "aaa")]);
    expect(slice(1).diffBySha[K(REPO_A.id, "aaa")]?.repoName).toBe(REPO_A.name);
    // Keyed to the same repo the selection was, so the snapshot IS the diff —
    // a mismatch would silently re-read git and lose the frozen inputs a
    // resume replays.
    expect(mockCommitDiff).not.toHaveBeenCalled();
  });
});

describe("run — the live working tree, per repo", () => {
  it("re-reads every selected repo's tree right before the run", async () => {
    seed(1, {
      selectedShas: [LOCAL_A, LOCAL_B],
      diffBySha: {
        [LOCAL_A]: localDiff({ rawPatch: "stale-a" }),
        [LOCAL_B]: localDiff({
          rawPatch: "stale-b",
          repoId: REPO_B.id,
          repoName: REPO_B.name,
        }),
      },
    });
    mockWorkingTreeDiff.mockImplementation(async (cwd) =>
      cwd === REPO_A.root
        ? localDiff({ rawPatch: "fresh-a" })
        : localDiff({ rawPatch: "fresh-b", repoId: REPO_B.id, repoName: REPO_B.name }),
    );
    mockRun.mockResolvedValue({ ok: true, findings: [], durationMs: 1 });

    await useCommitReview.getState().run(1);

    expect(mockWorkingTreeDiff).toHaveBeenCalledWith(REPO_A.root);
    expect(mockWorkingTreeDiff).toHaveBeenCalledWith(REPO_B.root);
    const sent = mockRun.mock.calls[0][0].diffs.map((d) => d.rawPatch);
    expect(sent).toEqual(["fresh-a", "fresh-b"]);
  });

  it("one repo's read failing keeps its cached diff and still runs the rest", async () => {
    seed(1, {
      selectedShas: [LOCAL_A, LOCAL_B],
      diffBySha: {
        [LOCAL_A]: localDiff({ rawPatch: "cached-a" }),
        [LOCAL_B]: localDiff({
          rawPatch: "cached-b",
          repoId: REPO_B.id,
          repoName: REPO_B.name,
        }),
      },
    });
    mockWorkingTreeDiff.mockImplementation(async (cwd) => {
      if (cwd === REPO_A.root) throw new Error("unreadable");
      return localDiff({
        rawPatch: "fresh-b",
        repoId: REPO_B.id,
        repoName: REPO_B.name,
      });
    });
    mockRun.mockResolvedValue({ ok: true, findings: [], durationMs: 1 });

    await useCommitReview.getState().run(1);

    const sent = mockRun.mock.calls[0][0].diffs.map((d) => d.rawPatch);
    expect(sent).toEqual(["cached-a", "fresh-b"]);
  });

  it("the run's diffs carry their repo through to the engine", async () => {
    seed(1, {
      selectedShas: [K(REPO_A.id, "aaa"), K(REPO_B.id, "bbb")],
      diffBySha: {
        [K(REPO_A.id, "aaa")]: commitDiffOf("aaa", REPO_A),
        [K(REPO_B.id, "bbb")]: commitDiffOf("bbb", REPO_B),
      },
    });
    mockRun.mockResolvedValue({ ok: true, findings: [], durationMs: 1 });

    await useCommitReview.getState().run(1);

    expect(
      mockRun.mock.calls[0][0].diffs.map((d) => `${d.repoName}:${d.sha}`),
    ).toEqual([`${REPO_A.name}:aaa`, `${REPO_B.name}:bbb`]);
    // …and the saved row records which repo each reviewed commit came from.
    const row = mockSaveRow.mock.calls[0][0];
    expect(JSON.parse(row.commits!).map((c: { repoName: string }) => c.repoName)).toEqual([
      REPO_A.name,
      REPO_B.name,
    ]);
  });
});

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

import { useCommitReview, type CommitReviewSlice } from "./useCommitReview";
import {
  LOCAL_CHANGES_SHA,
  listCommits,
  workingTreeDiff,
  type CommitDiff,
  type CommitMeta,
} from "./gitCommitApi";
import { gitStatusSummary } from "@/modules/git";
import { usePreferencesStore } from "@/modules/settings/preferences";

const mockListCommits = vi.mocked(listCommits);
const mockWorkingTreeDiff = vi.mocked(workingTreeDiff);
const mockStatus = vi.mocked(gitStatusSummary);

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

beforeEach(() => {
  vi.clearAllMocks();
  useCommitReview.setState({ byTab: new Map() } as Partial<
    ReturnType<typeof useCommitReview.getState>
  >);
  usePreferencesStore.setState({ sourceRoot: "C:/repo" } as Partial<
    ReturnType<typeof usePreferencesStore.getState>
  >);
  mockStatus.mockResolvedValue({ dirty: false } as Awaited<
    ReturnType<typeof gitStatusSummary>
  >);
  mockListCommits.mockResolvedValue([]);
  mockWorkingTreeDiff.mockResolvedValue(localDiff());
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

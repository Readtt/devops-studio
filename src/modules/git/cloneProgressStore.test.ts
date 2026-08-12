import { beforeEach, describe, expect, it, vi } from "vitest";

// A clone used to end by asking which repo became THE source directory, which
// meant cloning two and keeping one. Every repo that lands now joins the
// workspace, and nothing already in it is replaced.
const h = vi.hoisted(() => ({
  added: [] as string[],
  toasts: [] as { tone: string; message: string }[],
  fail: new Set<string>(),
}));

vi.mock("@/modules/settings/store", () => ({
  addRepo: async (root: string) => {
    h.added.push(root);
    return { id: root, name: root, root, ado: null };
  },
}));

vi.mock("@/components/actionToastStore", () => ({
  useActionToast: {
    getState: () => ({
      show: (t: { tone: string; message: string }) => h.toasts.push(t),
    }),
  },
}));

vi.mock("./gitOps", () => ({ emitSourceGitChanged: vi.fn() }));

vi.mock("./cloneOps", () => ({
  cancelClone: vi.fn(),
  nextCloneId: () => 1,
  cloneRepo: async (req: { destParent: string; dirName: string }) =>
    h.fail.has(req.dirName)
      ? { status: "error", path: null, message: "auth failed" }
      : {
          status: "cloned",
          path: `${req.destParent}\\${req.dirName}`,
          message: null,
        },
}));

import { useCloneProgress, type CloneJob } from "./cloneProgressStore";

const job = (name: string): CloneJob => ({
  url: `https://example.invalid/${name}`,
  dirName: name,
  auth: { kind: "none" } as CloneJob["auth"],
  persistAuth: false,
  repoLabel: name,
  project: null,
});

beforeEach(() => {
  h.added = [];
  h.toasts = [];
  h.fail = new Set();
  useCloneProgress.getState().dismiss();
});

describe("cloneProgressStore", () => {
  it("adds every cloned repo to the workspace", async () => {
    await useCloneProgress.getState().startBatch({
      jobs: [job("repo-one"), job("repo-two")],
      destParent: "C:\\clones",
    });

    expect(h.added).toEqual(["C:\\clones\\repo-one", "C:\\clones\\repo-two"]);
    expect(h.toasts).toEqual([{ tone: "ok", message: "Added 2 repos" }]);
    expect(useCloneProgress.getState().phase).toBe("done");
  });

  it("names the repo when only one was cloned", async () => {
    await useCloneProgress.getState().startBatch({
      jobs: [job("repo-one")],
      destParent: "C:\\clones",
    });

    expect(h.added).toEqual(["C:\\clones\\repo-one"]);
    expect(h.toasts).toEqual([{ tone: "ok", message: "Added repo-one" }]);
  });

  it("adds only what actually cloned", async () => {
    h.fail.add("repo-two");
    await useCloneProgress.getState().startBatch({
      jobs: [job("repo-one"), job("repo-two")],
      destParent: "C:\\clones",
    });

    expect(h.added).toEqual(["C:\\clones\\repo-one"]);
    expect(h.toasts).toEqual([{ tone: "ok", message: "Added repo-one" }]);
  });

  it("says nothing when the whole batch failed", async () => {
    h.fail.add("repo-one");
    await useCloneProgress.getState().startBatch({
      jobs: [job("repo-one")],
      destParent: "C:\\clones",
    });

    expect(h.added).toEqual([]);
    expect(h.toasts).toEqual([]);
  });
});

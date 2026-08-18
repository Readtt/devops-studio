import { beforeEach, describe, expect, it, vi } from "vitest";

// A clone used to end by asking which repo became THE source directory, which
// meant cloning two and keeping one. Every repo that lands now joins the
// workspace, and nothing already in it is replaced.
const h = vi.hoisted(() => ({
  added: [] as string[],
  toasts: [] as { tone: string; message: string }[],
  fail: new Set<string>(),
  /** Make the registry write fail — a locked settings file, say. */
  addFails: false,
  /** Run inside the registry write, i.e. while the batch is superseded-able. */
  duringAdd: null as (() => void) | null,
}));

vi.mock("@/modules/settings/store", () => ({
  addRepo: async (root: string) => {
    h.added.push(root);
    h.duringAdd?.();
    if (h.addFails) throw new Error("settings file is locked");
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
  h.addFails = false;
  h.duringAdd = null;
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

  it("says the clones landed even though the workspace write didn't", async () => {
    h.addFails = true;
    await useCloneProgress.getState().startBatch({
      jobs: [job("repo-one")],
      destParent: "C:\clones",
    });

    expect(h.toasts).toEqual([
      {
        tone: "error",
        message: "Cloned repo-one, but couldn't add it to the workspace",
      },
    ]);
  });

  // The success path has always been token-guarded; the failure path wasn't, so
  // a batch the user cancelled still narrated its outcome over the one they
  // were actually watching.
  it("stays quiet when a superseded batch fails to add its clones", async () => {
    h.addFails = true;
    h.duringAdd = () => useCloneProgress.getState().cancel();

    await useCloneProgress.getState().startBatch({
      jobs: [job("repo-one")],
      destParent: "C:\clones",
    });

    expect(h.toasts).toEqual([]);
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

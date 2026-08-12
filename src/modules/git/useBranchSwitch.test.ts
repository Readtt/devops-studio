import { beforeEach, describe, expect, it, vi } from "vitest";

// Repos switch branches independently. Before this was keyed by cwd a single
// module-global token meant starting an op in one repo silently discarded the
// result of one already running in another — the user got a capsule stuck on
// "Switching…" and a branch that had in fact moved.
const h = vi.hoisted(() => ({
  checkout: [] as { cwd: string; branch: string; resolve: (r: unknown) => void }[],
  pull: [] as { cwd: string; resolve: (r: unknown) => void }[],
}));

vi.mock("./gitOps", () => ({
  emitSourceGitChanged: vi.fn(),
  gitCheckout: (cwd: string, branch: string) =>
    new Promise((resolve) => h.checkout.push({ cwd, branch, resolve })),
  gitPull: (cwd: string) => new Promise((resolve) => h.pull.push({ cwd, resolve })),
  gitStatusSummary: vi.fn(async () => ({ staged: 1, unstaged: 0, untracked: 0 })),
  gitStashRestore: vi.fn(),
}));

// The store schedules toast dismissal on window timers; vitest runs in node.
vi.stubGlobal("window", {
  setTimeout: (fn: () => void, ms: number) =>
    setTimeout(fn, ms) as unknown as number,
  clearTimeout: (id: number) => clearTimeout(id as unknown as NodeJS.Timeout),
});

import { useBranchSwitch, type BranchSwitchToast } from "./useBranchSwitch";
import type { GitStatusSummary } from "./gitOps";

const A = "C:/repos/repo-one";
const B = "C:/repos/repo-two";

function status(over: Partial<GitStatusSummary> = {}): GitStatusSummary {
  return {
    isRepo: true,
    branch: "main",
    commit: "abc1234",
    detached: false,
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicted: 0,
    dirty: false,
    parkedHere: false,
    ...over,
  };
}

const switched = (branch: string) => ({
  status: "switched",
  branch,
  stashed: false,
  message: "",
});

/** Let the store's awaits run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

const toast = (cwd: string): BranchSwitchToast | undefined =>
  useBranchSwitch.getState().toasts.get(cwd);

beforeEach(() => {
  h.checkout = [];
  h.pull = [];
  useBranchSwitch.setState({ toasts: new Map(), confirms: new Map() });
});

describe("useBranchSwitch", () => {
  it("finishes a switch in one repo that started before a switch in another", async () => {
    const { requestSwitch } = useBranchSwitch.getState();
    requestSwitch(A, "feat/x", status());
    requestSwitch(B, "feat/y", status());
    expect(h.checkout.map((c) => c.cwd)).toEqual([A, B]);

    // Resolve out of order: B (the newer op) first, then A.
    h.checkout[1].resolve(switched("feat/y"));
    h.checkout[0].resolve(switched("feat/x"));
    await settle();

    for (const p of h.pull) p.resolve({ status: "up-to-date", message: "" });
    await settle();

    expect(toast(A)).toMatchObject({ kind: "done" });
    expect(toast(B)).toMatchObject({ kind: "done" });
  });

  it("keeps each repo's toast separate", async () => {
    const { requestSwitch } = useBranchSwitch.getState();
    requestSwitch(A, "feat/x", status());
    requestSwitch(B, "feat/y", status());

    expect(toast(A)).toMatchObject({ kind: "switching", branch: "feat/x" });
    expect(toast(B)).toMatchObject({ kind: "switching", branch: "feat/y" });
  });

  it("still supersedes an earlier operation on the SAME repo", async () => {
    const { requestSwitch } = useBranchSwitch.getState();
    requestSwitch(A, "feat/x", status());
    requestSwitch(A, "feat/z", status());

    h.checkout[0].resolve(switched("feat/x"));
    await settle();

    // The superseded run must not go on to pull, nor repaint the capsule.
    expect(h.pull).toHaveLength(0);
    expect(toast(A)).toMatchObject({ kind: "switching", branch: "feat/z" });
  });

  it("asks each dirty repo separately and answers only the one confirmed", () => {
    const { requestSwitch } = useBranchSwitch.getState();
    requestSwitch(A, "feat/x", status({ dirty: true, staged: 1 }));
    requestSwitch(B, "feat/y", status({ dirty: true, staged: 1 }));
    expect([...useBranchSwitch.getState().confirms.keys()]).toEqual([A, B]);

    useBranchSwitch.getState().confirmSwitch(B, "stash");

    expect([...useBranchSwitch.getState().confirms.keys()]).toEqual([A]);
    expect(h.checkout).toHaveLength(1);
    expect(h.checkout[0]).toMatchObject({ cwd: B, branch: "feat/y" });
  });

  it("dismisses one repo's toast without touching the other's", async () => {
    const { requestSwitch, dismissToast } = useBranchSwitch.getState();
    requestSwitch(A, "feat/x", status());
    requestSwitch(B, "feat/y", status());

    dismissToast(A);

    expect(toast(A)).toBeUndefined();
    expect(toast(B)).toMatchObject({ kind: "switching" });
  });
});

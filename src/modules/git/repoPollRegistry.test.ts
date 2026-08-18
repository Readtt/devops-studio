import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Each of these reads is a git subprocess per repo. Before the poll was shared,
// every mounted consumer ran its own: the status bar, every generator tab in
// its input phase, every confidence panel. Ten repos and five consumers made a
// single 30 s tick fifty CreateProcess calls on Windows.

const h = vi.hoisted(() => ({
  gitListener: null as ((root?: string) => void) | null,
  focusListener: null as ((e: { payload: boolean }) => void) | null,
}));

vi.mock("./gitOps", () => ({
  onSourceGitChanged: (fn: (root?: string) => void) => {
    h.gitListener = fn;
    return () => {
      h.gitListener = null;
    };
  },
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onFocusChanged: async (fn: (e: { payload: boolean }) => void) => {
      h.focusListener = fn;
      return () => {
        h.focusListener = null;
      };
    },
  }),
}));

vi.stubGlobal("window", {
  setInterval: (fn: () => void, ms: number) =>
    setInterval(fn, ms) as unknown as number,
  clearInterval: (id: number) => clearInterval(id as unknown as NodeJS.Timeout),
});

import { __resetRootPolls, subscribeRootPoll } from "./repoPollRegistry";

const A = "C:/repos/repo-one";
const B = "C:/repos/repo-two";

/** A reader that records every root it was asked for. Module-level identity is
 *  the channel key, so each test makes its own. */
function reader() {
  const calls: string[] = [];
  const read = async (root: string) => {
    calls.push(root);
    return `v:${root}`;
  };
  return { calls, read };
}

/** Let the registry's in-flight reads settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

/** Subscribe and track the latest values. The map is REPLACED on every update
 *  (never mutated) so subscribers can compare by identity — which means the
 *  one returned at subscribe time is a snapshot, and `notify` is the live feed.
 *  This is exactly what `useRootPoll` does with `setByRoot`. */
function track<T>(read: (root: string) => Promise<T>, empty: T, roots: string[]) {
  const seen = { current: new Map<string, T>(), notifies: 0 };
  const sub = subscribeRootPoll(read, empty, roots, (v) => {
    seen.current = v;
    seen.notifies++;
  });
  seen.current = sub.values;
  return { ...sub, seen };
}

beforeEach(() => {
  h.gitListener = null;
  h.focusListener = null;
});

afterEach(() => {
  __resetRootPolls();
});

describe("subscribeRootPoll", () => {
  it("reads each root once no matter how many consumers want it", async () => {
    const { calls, read } = reader();
    const first = subscribeRootPoll(read, "", [A, B], vi.fn());
    await settle();
    expect(calls).toEqual([A, B]);

    // Four more consumers of the same repos — the status bar plus three
    // generator tabs. Every one of these used to be a fresh pair of spawns.
    const rest = Array.from({ length: 4 }, () =>
      subscribeRootPoll(read, "", [A, B], vi.fn()),
    );
    await settle();
    expect(calls).toEqual([A, B]);

    first.unsubscribe();
    rest.forEach((s) => s.unsubscribe());
  });

  it("reads only the roots nobody has a value for yet", async () => {
    const { calls, read } = reader();
    const first = subscribeRootPoll(read, "", [A], vi.fn());
    await settle();
    expect(calls).toEqual([A]);

    // A second consumer wants A (already known) and B (new).
    const second = subscribeRootPoll(read, "", [A, B], vi.fn());
    await settle();
    expect(calls).toEqual([A, B]);

    first.unsubscribe();
    second.unsubscribe();
  });

  it("hands a late subscriber the values already read", async () => {
    const { read } = reader();
    const first = subscribeRootPoll(read, "", [A], vi.fn());
    await settle();

    const second = subscribeRootPoll(read, "", [A], vi.fn());
    expect(second.values.get(A)).toBe(`v:${A}`);

    first.unsubscribe();
    second.unsubscribe();
  });

  it("notifies every subscriber when a change event lands", async () => {
    const { calls, read } = reader();
    const one = vi.fn();
    const two = vi.fn();
    const a = subscribeRootPoll(read, "", [A, B], one);
    const b = subscribeRootPoll(read, "", [A, B], two);
    await settle();
    one.mockClear();
    two.mockClear();
    calls.length = 0;

    // A payload narrows the refresh to the repo that moved.
    h.gitListener?.(A);
    await settle();
    expect(calls).toEqual([A]);
    expect(one).toHaveBeenCalled();
    expect(two).toHaveBeenCalled();

    a.unsubscribe();
    b.unsubscribe();
  });

  it("refreshes every root when the event names none", async () => {
    const { calls, read } = reader();
    const sub = subscribeRootPoll(read, "", [A, B], vi.fn());
    await settle();
    calls.length = 0;

    h.gitListener?.();
    await settle();
    expect(calls.sort()).toEqual([A, B].sort());

    sub.unsubscribe();
  });

  // A first subscriber with no repos configured yet leaves the channel idle.
  // Guarding the start on "am I the first subscriber" left it idle forever.
  it("starts the poll for the subscriber that brings the first root", async () => {
    const { read } = reader();
    const empty = subscribeRootPoll(read, "", [], vi.fn());
    await settle();
    expect(h.gitListener).toBeNull();

    const withRoots = subscribeRootPoll(read, "", [A], vi.fn());
    await settle();
    expect(h.gitListener).not.toBeNull();

    empty.unsubscribe();
    withRoots.unsubscribe();
  });

  it("tears the listeners down only when the last subscriber leaves", async () => {
    const { read } = reader();
    const a = subscribeRootPoll(read, "", [A], vi.fn());
    const b = subscribeRootPoll(read, "", [A], vi.fn());
    await settle();

    a.unsubscribe();
    expect(h.gitListener).not.toBeNull();
    b.unsubscribe();
    expect(h.gitListener).toBeNull();
  });

  it("drops a repo that left the workspace while its read was in flight", async () => {
    const { read } = reader();
    const a = track(read, "", [A, B]);
    await settle();
    expect(a.seen.current.has(B)).toBe(true);

    // B's owner unsubscribes and only A is wanted now.
    a.unsubscribe();
    const b = track(read, "", [A]);
    h.gitListener?.();
    await settle();
    expect(b.seen.current.has(B)).toBe(false);
    expect(b.seen.current.get(A)).toBe(`v:${A}`);

    b.unsubscribe();
  });

  // One unreadable root (moved on disk, not a git repo) must not cost the repos
  // that answered their values.
  it("keeps a failed read from taking the whole refresh down", async () => {
    const read = async (root: string) => {
      if (root === A) throw new Error("not a repo");
      return `v:${root}`;
    };
    const sub = track(read, "EMPTY", [A, B]);
    await settle();
    expect(sub.seen.current.get(A)).toBe("EMPTY");
    expect(sub.seen.current.get(B)).toBe(`v:${B}`);

    sub.unsubscribe();
  });
});

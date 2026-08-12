import { beforeEach, describe, expect, it, vi } from "vitest";

// A git change is announced on two buses — the DOM event (same window) and the
// Tauri bus (every window, including the one that fired it). Readers used to
// pick one each, so a switch made in Settings refreshed the branch label but not
// the dirty chips. Listening to both is right; doing it naively costs every
// reader a doubled refresh in the emitting window.
const h = vi.hoisted(() => ({
  bus: [] as ((e: { payload: unknown }) => void)[],
  dom: new Map<string, ((e: unknown) => void)[]>(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/event", () => ({
  emit: async (_event: string, payload: unknown) => {
    for (const handler of [...h.bus]) handler({ payload });
  },
  listen: async (_event: string, handler: (e: { payload: unknown }) => void) => {
    h.bus.push(handler);
    return () => {
      h.bus = h.bus.filter((x) => x !== handler);
    };
  },
}));

class FakeCustomEvent {
  type: string;
  detail: unknown;
  constructor(type: string, init?: { detail?: unknown }) {
    this.type = type;
    this.detail = init?.detail;
  }
}

vi.stubGlobal("CustomEvent", FakeCustomEvent);
vi.stubGlobal("window", {
  addEventListener: (type: string, handler: (e: unknown) => void) => {
    h.dom.set(type, [...(h.dom.get(type) ?? []), handler]);
  },
  removeEventListener: (type: string, handler: (e: unknown) => void) => {
    h.dom.set(type, (h.dom.get(type) ?? []).filter((x) => x !== handler));
  },
  dispatchEvent: (e: FakeCustomEvent) => {
    for (const handler of [...(h.dom.get(e.type) ?? [])]) handler(e);
  },
});

import {
  SOURCE_GIT_CHANGED_EVENT,
  emitSourceGitChanged,
  onSourceGitChanged,
} from "./gitOps";

/** Let `listen()`'s promise register the bus handler. */
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  h.bus = [];
  h.dom = new Map();
});

describe("onSourceGitChanged", () => {
  it("fires once per change even though both buses deliver it", async () => {
    const seen: (string | undefined)[] = [];
    const off = onSourceGitChanged((root) => seen.push(root));
    await tick();

    emitSourceGitChanged("C:/repos/repo-one");
    await tick();

    expect(seen).toEqual(["C:/repos/repo-one"]);
    off();
  });

  it("reports each change separately", async () => {
    const seen: (string | undefined)[] = [];
    const off = onSourceGitChanged((root) => seen.push(root));
    await tick();

    emitSourceGitChanged("C:/repos/repo-one");
    emitSourceGitChanged("C:/repos/repo-two");
    await tick();

    expect(seen).toEqual(["C:/repos/repo-one", "C:/repos/repo-two"]);
    off();
  });

  it("treats an event carrying no payload as refresh-everything", async () => {
    const seen: (string | undefined)[] = [];
    const off = onSourceGitChanged((root) => seen.push(root));
    await tick();

    // What a raw dispatch (or a caller that doesn't know which repo moved) sends.
    window.dispatchEvent(new CustomEvent(SOURCE_GIT_CHANGED_EVENT));
    await tick();

    expect(seen).toEqual([undefined]);
    off();
  });

  it("detaches from both buses when unsubscribed", async () => {
    const seen: (string | undefined)[] = [];
    const off = onSourceGitChanged((root) => seen.push(root));
    await tick();
    off();

    emitSourceGitChanged("C:/repos/repo-one");
    await tick();

    expect(seen).toEqual([]);
    expect(h.bus).toHaveLength(0);
    expect(h.dom.get(SOURCE_GIT_CHANGED_EVENT) ?? []).toHaveLength(0);
  });
});

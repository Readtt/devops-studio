import { beforeEach, describe, expect, it, vi } from "vitest";

// The main window's catalogue sync: when it refreshes, what it drops, and that
// it answers Settings' Check now. The stores and the refresh pass are stand-ins
// so the decisions can be watched directly.

const h = vi.hoisted(() => ({
  refreshes: [] as Array<{ force?: unknown; drop?: unknown }>,
  checkListener: null as null | (() => void),
  finished: 0,
}));

vi.mock("../store/chatStore", async () => {
  const { create } = await import("zustand");
  return {
    useChatStore: create<{ keysLoaded: boolean; apiKeys: Record<string, string | null> }>(
      () => ({ keysLoaded: false, apiKeys: {} as never }),
    ),
  };
});
vi.mock("../store/modelCatalogStore", async () => {
  const { create } = await import("zustand");
  return {
  useModelCatalogStore: create<{ hydrated: boolean }>(() => ({ hydrated: false })),
  onModelCatalogCheckRequested: async (cb: () => void) => {
    h.checkListener = cb;
    return () => {};
  },
  announceModelCatalogCheckFinished: async () => {
    h.finished++;
  },
  };
});
vi.mock("./modelCatalog", () => ({
  refreshModelCatalog: async (opts: { force?: unknown; drop?: unknown }) => {
    h.refreshes.push({ force: opts.force, drop: opts.drop });
    return {};
  },
}));

import { providersToDrop, startModelCatalogSync } from "./modelCatalogSync";
import { useChatStore as chat } from "../store/chatStore";
import { useModelCatalogStore as catalog } from "../store/modelCatalogStore";

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  h.refreshes.length = 0;
  h.finished = 0;
  chat.setState({ keysLoaded: false, apiKeys: {} as never });
  catalog.setState({ hydrated: false });
});

describe("providersToDrop", () => {
  it("drops the providers without a key when others still have one", () => {
    const drop = providersToDrop({ anthropic: "k", openrouter: null });
    expect(drop).toContain("openrouter");
    expect(drop).not.toContain("anthropic");
  });

  // Every keychain error reads as "no key", and a failed read loses all of
  // them at once — which no single removal does.
  it("drops nothing on a read with no keys at all", () => {
    expect(providersToDrop({})).toEqual([]);
    expect(providersToDrop({ anthropic: null, openai: "  " })).toEqual([]);
  });
});

describe("startModelCatalogSync", () => {
  it("waits for both the keys and the saved catalogue before its first check", async () => {
    const stop = startModelCatalogSync();
    chat.setState({ keysLoaded: true, apiKeys: { anthropic: "k" } as never });
    await flush();
    expect(h.refreshes).toHaveLength(0);
    catalog.setState({ hydrated: true });
    await flush();
    expect(h.refreshes).toHaveLength(1);
    stop();
  });

  it("re-reads just the provider whose key changed", async () => {
    catalog.setState({ hydrated: true });
    const stop = startModelCatalogSync();
    chat.setState({ keysLoaded: true, apiKeys: { anthropic: "k", openai: null } as never });
    await flush();
    chat.setState({ apiKeys: { anthropic: "k", openai: "sk-new" } as never });
    await flush();
    expect(h.refreshes[h.refreshes.length - 1].force).toEqual(["openai"]);
    stop();
  });

  it("drops a removed key's list, but not everything on a failed keychain read", async () => {
    catalog.setState({ hydrated: true });
    const stop = startModelCatalogSync();
    chat.setState({ keysLoaded: true, apiKeys: { anthropic: "k", mistral: "m" } as never });
    await flush();
    chat.setState({ apiKeys: { anthropic: "k", mistral: null } as never });
    await flush();
    expect(h.refreshes[h.refreshes.length - 1].drop).toContain("mistral");
    chat.setState({ apiKeys: { anthropic: null, mistral: null } as never });
    await flush();
    expect(h.refreshes[h.refreshes.length - 1].drop).toEqual([]);
    stop();
  });

  it("answers Settings' Check now once the forced check is done", async () => {
    catalog.setState({ hydrated: true });
    chat.setState({ keysLoaded: true, apiKeys: { anthropic: "k" } as never });
    const stop = startModelCatalogSync();
    await flush();
    h.checkListener?.();
    await flush();
    expect(h.refreshes[h.refreshes.length - 1].force).toBe(true);
    expect(h.finished).toBe(1);
    stop();
  });

  // Settings must not spin until its timeout when nothing could run.
  it("still answers when it can't check yet", async () => {
    const stop = startModelCatalogSync();
    await flush();
    h.checkListener?.();
    await flush();
    expect(h.refreshes).toHaveLength(0);
    expect(h.finished).toBe(1);
    stop();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The live model catalogue's persistence: its own store file, one writer, and
// an event every window re-reads on — including the two ways that goes wrong
// (a window re-reading its own write, a damaged file).
const h = vi.hoisted(() => ({
  files: new Map<string, Map<string, unknown>>(),
  emitted: [] as { event: string; payload: unknown }[],
  listeners: new Map<string, ((e: { payload: unknown }) => void)[]>(),
  gets: 0,
}));

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    private data: Map<string, unknown>;
    constructor(path: string) {
      this.data = h.files.get(path) ?? new Map();
      h.files.set(path, this.data);
    }
    async get(key: string) {
      h.gets++;
      return this.data.get(key);
    }
    async set(key: string, value: unknown) {
      this.data.set(key, value);
    }
    async save() {}
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: async (event: string, payload?: unknown) => {
    h.emitted.push({ event, payload });
  },
  listen: async (event: string, handler: (e: { payload: unknown }) => void) => {
    h.listeners.set(event, [...(h.listeners.get(event) ?? []), handler]);
    return () => {};
  },
}));

import { getModel, setDiscoveredModels, type ModelCatalog } from "../config";
import {
  onModelCatalogCheckRequested,
  requestModelCatalogCheck,
  saveModelCatalog,
  useModelCatalogStore,
} from "./modelCatalogStore";

const catalog: ModelCatalog = {
  anthropic: {
    checkedAt: 5,
    fetchedAt: 5,
    models: [
      { provider: "anthropic", apiId: "claude-opus-5-6", label: "Claude Opus 5.6" },
    ],
  },
};

const fire = (event: string, payload: unknown) =>
  (h.listeners.get(event) ?? []).forEach((fn) => fn({ payload }));
const file = () => h.files.get("devops-studio-models.json");

beforeEach(() => {
  h.emitted.length = 0;
});
afterEach(() => setDiscoveredModels([]));

describe("model catalogue store", () => {
  // Not the settings file: a few hundred listings rewritten with every
  // theme change is how that file stops being small.
  it("persists to its own file and tells every window", async () => {
    await useModelCatalogStore.getState().init();
    await saveModelCatalog(catalog);
    expect(file()?.get("catalog")).toMatchObject({ catalog });
    expect(h.files.get("devops-studio-settings.json")).toBeUndefined();
    expect(h.emitted.map((e) => e.event)).toEqual([
      "devops-studio://model-catalog-changed",
    ]);
  });

  // Whichever window fetched the list, `getModel` here has to answer with the
  // listing — its real name, not one guessed from the id.
  it("feeds the registry the moment it changes", async () => {
    await saveModelCatalog({ ...catalog });
    expect(getModel("anthropic:claude-opus-5-6").label).toBe("Claude Opus 5.6");
  });

  it("doesn't re-read the file on its own change event", async () => {
    await useModelCatalogStore.getState().init();
    await saveModelCatalog(catalog);
    const before = h.gets;
    fire("devops-studio://model-catalog-changed", h.emitted[h.emitted.length - 1]?.payload);
    await Promise.resolve();
    expect(h.gets).toBe(before);
  });

  it("re-reads when another window wrote, and normalises what it finds", async () => {
    await useModelCatalogStore.getState().init();
    file()?.set("catalog", {
      stamp: 424242,
      catalog: { ...catalog, bogus: { checkedAt: 1, models: [] } },
    });
    fire("devops-studio://model-catalog-changed", { stamp: 424242 });
    await vi.waitFor(() =>
      expect(useModelCatalogStore.getState().catalog).toEqual(catalog),
    );
  });

  it("carries Settings' Check now to the writer", async () => {
    const heard = vi.fn();
    await onModelCatalogCheckRequested(heard);
    await requestModelCatalogCheck();
    fire(h.emitted[h.emitted.length - 1].event, null);
    expect(heard).toHaveBeenCalledOnce();
  });
});

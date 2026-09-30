import { beforeEach, describe, expect, it, vi } from "vitest";

// A saved model id outlives the model: providers shut models down, the
// catalogue drops them, and the next launch has to do something sensible with
// the id still sitting in the settings file.
const h = vi.hoisted(() => ({
  data: new Map<string, unknown>(),
  emitted: [] as { key: string; value: unknown }[],
  listeners: [] as { event: string; handler: (e: unknown) => void }[],
}));

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async entries() {
      return [...h.data.entries()];
    }
    async get(key: string) {
      return h.data.get(key);
    }
    async set(key: string, value: unknown) {
      h.data.set(key, value);
    }
    async delete(key: string) {
      return h.data.delete(key);
    }
    async save() {}
    async onChange() {
      return () => {};
    }
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: async (_event: string, payload?: { key: string; value: unknown }) => {
    if (payload) h.emitted.push(payload);
  },
  listen: async (event: string, handler: (e: unknown) => void) => {
    h.listeners.push({ event, handler });
    return () => {};
  },
}));

vi.mock("@/lib/launchDir", () => ({ consumeLaunchDir: () => undefined }));

import { DEFAULT_MODEL_ID } from "@/modules/ai/config";
import { loadPreferences } from "./store";

beforeEach(() => {
  h.data.clear();
  h.emitted.length = 0;
});

describe("saved model ids across a retirement", () => {
  // Groq shut this down. Falling back to DEFAULT_MODEL_ID would hand a
  // Groq-only user an Anthropic model they have no key for.
  it("a retired default moves to the same provider's successor", async () => {
    h.data.set("defaultModelId", "llama-3.3-70b-versatile");
    const prefs = await loadPreferences();
    expect(prefs.defaultModelId).toBe("openai/gpt-oss-120b");
  });

  it("an id with no successor still falls back to the default", async () => {
    h.data.set("defaultModelId", "some-model-that-never-existed");
    const prefs = await loadPreferences();
    expect(prefs.defaultModelId).toBe(DEFAULT_MODEL_ID);
  });

  // The picker offers these; a saved default pointing at one must not be
  // reset on a launch where that provider's list hasn't loaded yet.
  it("a discovered default survives a launch with no catalogue", async () => {
    h.data.set("defaultModelId", "openai:gpt-7");
    const prefs = await loadPreferences();
    expect(prefs.defaultModelId).toBe("openai:gpt-7");
  });

  it("favorites and recents carry over to the successor", async () => {
    h.data.set("favoriteModelIds", ["grok-4-fast-reasoning", "claude-opus-5"]);
    h.data.set("recentModelIds", ["qwen-3-32b"]);
    const prefs = await loadPreferences();
    expect(prefs.favoriteModelIds).toEqual(["grok-4.3", "claude-opus-5"]);
    expect(prefs.recentModelIds).toEqual(["qwen-3.8-27b"]);
  });

  it("favorites don't list a successor twice", async () => {
    h.data.set("favoriteModelIds", [
      "deepseek-v4-flash",
      "deepseek-flash",
      "gone-for-good",
      "claude-opus-5",
    ]);
    const prefs = await loadPreferences();
    expect(prefs.favoriteModelIds).toEqual(["deepseek-flash", "claude-opus-5"]);
  });
});

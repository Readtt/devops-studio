import { describe, expect, it, vi } from "vitest";

// The refresh pass is pure apart from its injected `list`; the store it
// persists through is stubbed out.
vi.mock("../store/modelCatalogStore", () => ({
  useModelCatalogStore: { getState: () => ({ catalog: {} }) },
  saveModelCatalog: async () => {},
}));

import type { DiscoverableProvider, ModelCatalog, ModelListing } from "../config";
import {
  CATALOG_RETRY_FAILED_AFTER_MS,
  CATALOG_STALE_AFTER_MS,
  describeListError,
  nextModelCatalog,
} from "./modelCatalog";

const NOW = 1_800_000_000_000;
const listing = (provider: DiscoverableProvider, apiId: string): ModelListing => ({
  provider,
  apiId,
});

function lister(answers: Partial<Record<DiscoverableProvider, ModelListing[] | Error>>) {
  const calls: DiscoverableProvider[] = [];
  const list = async (p: DiscoverableProvider) => {
    calls.push(p);
    const a = answers[p];
    if (a instanceof Error) throw a;
    return a ?? [];
  };
  return { list, calls };
}

describe("nextModelCatalog", () => {
  it("reads every provider that has a key and no list yet", async () => {
    const { list, calls } = lister({
      openai: [listing("openai", "gpt-7")],
      anthropic: [listing("anthropic", "claude-opus-6")],
    });
    const next = await nextModelCatalog({}, {
      keys: { openai: "k1", anthropic: "k2", google: null },
      now: NOW,
      list,
    });
    expect(calls.sort()).toEqual(["anthropic", "openai"]);
    expect(next.openai).toEqual({
      checkedAt: NOW,
      fetchedAt: NOW,
      models: [listing("openai", "gpt-7")],
    });
  });

  it("leaves a fresh list alone and re-reads a stale one", async () => {
    const current: ModelCatalog = {
      openai: { checkedAt: NOW - 1_000, fetchedAt: NOW - 1_000, models: [] },
      xai: {
        checkedAt: NOW - CATALOG_STALE_AFTER_MS - 1,
        fetchedAt: NOW - CATALOG_STALE_AFTER_MS - 1,
        models: [],
      },
    };
    const { list, calls } = lister({ xai: [listing("xai", "grok-5")] });
    await nextModelCatalog(current, { keys: { openai: "k", xai: "k" }, now: NOW, list });
    expect(calls).toEqual(["xai"]);
  });

  it("re-reads exactly the forced providers even when fresh", async () => {
    const fresh = { checkedAt: NOW, fetchedAt: NOW, models: [] };
    const { list, calls } = lister({ groq: [listing("groq", "x")] });
    await nextModelCatalog(
      { groq: fresh, mistral: fresh },
      { keys: { groq: "k", mistral: "k" }, force: ["groq"], now: NOW, list },
    );
    expect(calls).toEqual(["groq"]);
  });

  // A 500 or a timeout must not delete every model the user could pick.
  it("keeps the last good list when a refresh fails, and says why", async () => {
    const good = [listing("openai", "gpt-7")];
    const { list } = lister({ openai: new Error("HTTP 503") });
    const next = await nextModelCatalog(
      { openai: { checkedAt: 1, fetchedAt: 1, models: good } },
      { keys: { openai: "k" }, force: true, now: NOW, list },
    );
    expect(next.openai).toEqual({
      checkedAt: NOW,
      fetchedAt: 1,
      models: good,
      error: "HTTP 503",
    });
  });

  it("treats an empty answer as a failure, not as 'no models'", async () => {
    const good = [listing("mistral", "mistral-large-latest")];
    const { list } = lister({ mistral: [] });
    const next = await nextModelCatalog(
      { mistral: { checkedAt: 1, fetchedAt: 1, models: good } },
      { keys: { mistral: "k" }, force: true, now: NOW, list },
    );
    expect(next.mistral?.models).toEqual(good);
    expect(next.mistral?.error).toMatch(/no models/);
  });

  it("drops a provider whose key was removed", async () => {
    const { list, calls } = lister({});
    const next = await nextModelCatalog(
      { deepseek: { checkedAt: NOW, fetchedAt: NOW, models: [] } },
      { keys: { deepseek: null }, drop: ["deepseek"], now: NOW, list },
    );
    expect(next.deepseek).toBeUndefined();
    expect(calls).toEqual([]);
  });

  // A locked or unreadable keychain reads as "no keys"; that must not wipe
  // every saved list.
  it("keeps the list of a provider whose key merely didn't load", async () => {
    const current: ModelCatalog = {
      openai: { checkedAt: 1, fetchedAt: 1, models: [listing("openai", "gpt-7")] },
    };
    const { list, calls } = lister({});
    const next = await nextModelCatalog(current, { keys: {}, force: true, now: NOW, list });
    expect(next).toBe(current);
    expect(calls).toEqual([]);
  });

  // A laptop that starts before its network does shouldn't wait twelve hours
  // for its lists — but a provider that keeps failing isn't asked every tick.
  it("retries a failed provider after an hour, not before", async () => {
    const failed = (checkedAgo: number): ModelCatalog => ({
      xai: { checkedAt: NOW - checkedAgo, models: [], error: "Timed out" },
    });
    const soon = lister({ xai: [listing("xai", "grok-5")] });
    await nextModelCatalog(failed(CATALOG_RETRY_FAILED_AFTER_MS - 1), { keys: { xai: "k" }, now: NOW, list: soon.list });
    expect(soon.calls).toEqual([]);
    const later = lister({ xai: [listing("xai", "grok-5")] });
    const next = await nextModelCatalog(failed(CATALOG_RETRY_FAILED_AFTER_MS), { keys: { xai: "k" }, now: NOW, list: later.list });
    expect(later.calls).toEqual(["xai"]);
    expect(next.xai).toEqual({ checkedAt: NOW, fetchedAt: NOW, models: [listing("xai", "grok-5")] });
  });

  it("counts staleness from the last success, not the last attempt", async () => {
    const { list, calls } = lister({ groq: [listing("groq", "x")] });
    await nextModelCatalog(
      {
        groq: {
          checkedAt: NOW - CATALOG_RETRY_FAILED_AFTER_MS,
          fetchedAt: NOW - CATALOG_STALE_AFTER_MS,
          models: [],
          error: "HTTP 500",
        },
      },
      { keys: { groq: "k" }, now: NOW, list },
    );
    expect(calls).toEqual(["groq"]);
  });

  // The caller skips the settings write on an unchanged object.
  it("returns the same object when nothing was due", async () => {
    const current: ModelCatalog = {
      openai: { checkedAt: NOW, fetchedAt: NOW, models: [] },
    };
    const { list } = lister({});
    expect(await nextModelCatalog(current, { keys: { openai: "k" }, now: NOW, list })).toBe(
      current,
    );
  });
});

describe("describeListError", () => {
  it.each([
    ["HTTP 401: Invalid API key", "it refused the key"],
    ["HTTP 403", "it refused the key"],
    ["HTTP 429", "it was rate-limiting requests"],
    ["HTTP 503", "it had a server error"],
    ["Timed out", "it didn't answer in time"],
    ["The provider listed no models.", "its answer had no models in it"],
    ["error sending request for url", "it couldn't be reached"],
  ])("%s → %s", (raw, plain) => expect(describeListError(raw)).toBe(plain));
});

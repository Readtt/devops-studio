// Models this build has never seen, reached through a provider's live list.
// The release guard for them is the same as for the curated list — "a new model
// shipped and every AI surface started 400ing" — except nobody gets to decide
// per model, so the defaults are what's pinned here.

import { afterEach, describe, expect, it } from "vitest";
import {
  apiModelId,
  discoveredModelId,
  discoveredModelsForCatalog,
  discoveredModelsFrom,
  estimateCost,
  getModel,
  getModelContextLimit,
  getModelOutputCap,
  getModelOutputCeiling,
  isKnownModelId,
  modelInfoFromListing,
  normalizeModelCatalog,
  parseDiscoveredModelId,
  preservesThinking,
  prettifyModelId,
  setDiscoveredModels,
  supportsTemperature,
  supportsVision,
  type ModelListing,
} from "./config";

afterEach(() => setDiscoveredModels([]));

describe("discovered ids", () => {
  it("round-trip, splitting on the FIRST colon (OpenRouter ids have their own)", () => {
    const id = discoveredModelId("openrouter", "qwen/qwen3-coder:free");
    expect(id).toBe("openrouter:qwen/qwen3-coder:free");
    expect(parseDiscoveredModelId(id)).toEqual({
      provider: "openrouter",
      apiId: "qwen/qwen3-coder:free",
    });
  });

  it.each(["claude-sonnet-5", "bogus:x", "openai:", ":gpt-6", "lmstudio:qwen", ""])(
    "%j is not a discovered id",
    (id) => expect(parseDiscoveredModelId(id)).toBeNull(),
  );

  // A saved default must survive a launch where the provider hasn't answered
  // yet: accepted on its shape, resolved from the id alone.
  it("a well-formed discovered id is known before any list has loaded", () => {
    expect(isKnownModelId("openai:gpt-7")).toBe(true);
    expect(getModel("openai:gpt-7")).toMatchObject({
      provider: "openai",
      apiId: "gpt-7",
      label: "GPT-7",
      discovered: true,
    });
    expect(apiModelId("openai:gpt-7")).toBe("gpt-7");
  });

  it("curated ids still resolve to their curated entry", () => {
    expect(getModel("claude-sonnet-5").discovered).toBeUndefined();
    expect(apiModelId("claude-sonnet-5")).toBe("claude-sonnet-5");
  });

  it("anything else still throws", () => {
    expect(() => getModel("not-a-model")).toThrow("Unknown model");
  });
});

describe("request shaping for a model nobody catalogued", () => {
  const listing = (over: Partial<ModelListing> = {}): ModelListing => ({
    provider: "openai",
    apiId: "gpt-7",
    ...over,
  });

  // Every API accepts a missing temperature; the frontier tier 400s on a
  // present one — and a model new enough to be discovered is frontier.
  it.each([
    listing(),
    listing({ provider: "google", apiId: "gemini-4-flash" }),
    listing({ provider: "groq", apiId: "llama-5-8b" }),
    listing({ provider: "openrouter", apiId: "anthropic/claude-opus-6" }),
  ])("never sends a temperature ($provider $apiId)", (l) => {
    const m = modelInfoFromListing(l);
    setDiscoveredModels([m]);
    expect(supportsTemperature(m.id)).toBe(false);
  });

  it("a Claude route gets an explicit cap: half its ceiling, at most 64k", () => {
    const m = modelInfoFromListing(
      listing({ provider: "anthropic", apiId: "claude-opus-6", maxOutputTokens: 128_000 }),
    );
    setDiscoveredModels([m]);
    expect(getModelOutputCap(m.id)).toBe(64_000);
    expect(getModelOutputCeiling(m.id)).toBe(128_000);

    const small = modelInfoFromListing(
      listing({ provider: "openrouter", apiId: "anthropic/claude-haiku-5", maxOutputTokens: 64_000 }),
    );
    setDiscoveredModels([small]);
    expect(getModelOutputCap(small.id)).toBe(32_000);
  });

  // @ai-sdk/anthropic invents a cap for an id it doesn't know; the synthesized
  // (pre-list) path must still send ours.
  it("a Claude id with no listing yet still gets a cap below its ceiling", () => {
    const cap = getModelOutputCap("anthropic:claude-sonnet-6")!;
    const ceiling = getModelOutputCeiling("anthropic:claude-sonnet-6")!;
    expect(cap).toBeGreaterThan(0);
    expect(cap).toBeLessThan(ceiling);
  });

  it("everyone else is sent no cap, as before", () => {
    const m = modelInfoFromListing(listing({ maxOutputTokens: 128_000 }));
    setDiscoveredModels([m]);
    expect(getModelOutputCap(m.id)).toBeUndefined();
  });

  it("preserved thinking follows the Claude generation, not the route", () => {
    expect(preservesThinking("anthropic:claude-opus-6")).toBe(true);
    expect(preservesThinking("anthropic:claude-sonnet-5-6")).toBe(true);
    expect(preservesThinking("openrouter:anthropic/claude-opus-5.5")).toBe(true);
    // 5.0 predates the check; a date stamp is not a minor version.
    expect(preservesThinking("anthropic:claude-opus-5")).toBe(false);
    expect(preservesThinking("anthropic:claude-opus-5-20260101")).toBe(false);
    expect(preservesThinking("anthropic:claude-haiku-4-5-20251001")).toBe(false);
    expect(preservesThinking("openai:gpt-7")).toBe(false);
  });

  it("uses the listing's window, vision and price when it states them", () => {
    const m = modelInfoFromListing(
      listing({
        provider: "openrouter",
        apiId: "vendor/big-model",
        contextWindow: 262_144,
        vision: true,
        pricing: { input: 1, output: 2 },
      }),
    );
    setDiscoveredModels([m]);
    expect(getModelContextLimit(m.id)).toBe(262_144);
    expect(supportsVision(m.id)).toBe(true);
    expect(
      estimateCost(m.id, { inputTokens: 1_000_000, outputTokens: 1_000_000, cachedInputTokens: 0 }),
    ).toBe(3);
  });

  it("falls back to the long-standing defaults when it doesn't", () => {
    expect(getModelContextLimit("openai:gpt-7")).toBe(128_000);
    expect(supportsVision("openai:gpt-7")).toBe(false);
    expect(
      estimateCost("openai:gpt-7", { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 }),
    ).toBeNull();
  });
});

describe("merging live lists with the curated list", () => {
  it("drops listings that are a curated model, under its own or a dated id", () => {
    const got = discoveredModelsFrom([
      { provider: "anthropic", apiId: "claude-sonnet-5" },
      { provider: "anthropic", apiId: "claude-haiku-4-5-20251001" },
      { provider: "openrouter", apiId: "anthropic/claude-opus-5.5" },
      { provider: "anthropic", apiId: "claude-opus-5-6" },
      { provider: "anthropic", apiId: "claude-opus-5-6" },
    ]);
    expect(got.map((m) => m.id)).toEqual(["anthropic:claude-opus-5-6"]);
  });

  // The same id under two providers is two models (Groq's and OpenRouter's
  // `openai/gpt-oss-20b`), and neither may shadow the other.
  it("keeps one id listed by two providers as two models", () => {
    const got = discoveredModelsFrom([
      { provider: "groq", apiId: "openai/gpt-oss-safeguard-20b" },
      { provider: "openrouter", apiId: "openai/gpt-oss-safeguard-20b" },
    ]);
    expect(got.map((m) => m.id)).toEqual([
      "groq:openai/gpt-oss-safeguard-20b",
      "openrouter:openai/gpt-oss-safeguard-20b",
    ]);
  });

  it("a registered listing's own label wins over the synthesized one", () => {
    setDiscoveredModels(
      discoveredModelsFrom([
        { provider: "anthropic", apiId: "claude-opus-5-6", label: "Claude Opus 5.6" },
      ]),
    );
    expect(getModel("anthropic:claude-opus-5-6").label).toBe("Claude Opus 5.6");
  });

  it("computes a catalogue's models once per catalogue", () => {
    const catalog = normalizeModelCatalog({
      openai: { checkedAt: 1, models: [{ apiId: "gpt-7" }] },
    });
    expect(discoveredModelsForCatalog(catalog)).toBe(discoveredModelsForCatalog(catalog));
  });
});

describe("the persisted catalogue", () => {
  it("survives a damaged settings file entry by entry", () => {
    const got = normalizeModelCatalog({
      openai: { checkedAt: 5, fetchedAt: 5, models: [{ apiId: "gpt-7" }, { apiId: "" }, "x", null] },
      anthropic: { models: [{ apiId: "claude-x" }] }, // no checkedAt
      lmstudio: { checkedAt: 1, models: [{ apiId: "local" }] }, // not discoverable
      google: "garbage",
      xai: {
        checkedAt: 2,
        error: "HTTP 500",
        models: [{ apiId: "grok-5", pricing: { input: "1", output: 2 } }],
      },
    });
    expect(got).toEqual({
      openai: { checkedAt: 5, fetchedAt: 5, models: [{ provider: "openai", apiId: "gpt-7" }] },
      xai: { checkedAt: 2, error: "HTTP 500", models: [{ provider: "xai", apiId: "grok-5" }] },
    });
  });

  it.each([undefined, null, "x", [], 7])("%j reads as an empty catalogue", (raw) => {
    expect(normalizeModelCatalog(raw)).toEqual({});
  });
});

describe("prettifyModelId", () => {
  it.each([
    ["gpt-6.2-sol", "GPT-6.2 Sol"],
    ["gpt-7", "GPT-7"],
    ["gpt-oss-120b", "GPT-OSS 120B"],
    ["qwen-3.8-27b", "Qwen 3.8 27B"],
    ["deepseek-v5", "Deepseek V5"],
    ["meta-llama/llama-5-scout", "Llama 5 Scout"],
  ])("%s → %s", (id, label) => expect(prettifyModelId(id)).toBe(label));
});

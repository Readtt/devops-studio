import { describe, expect, it } from "vitest";
import { isReasoningModel, PROVIDERS, providerNeedsKey } from "../config";
import { probeModelId } from "./testKey";

describe("probeModelId", () => {
  // The catalogue leads with each provider's newest flagship. A key test that
  // followed list order would probe Claude Fable 5.1 at Fable prices, or a
  // model that shipped the day before its quirks were known.
  it("probes Anthropic keys with Haiku, not the newest flagship", () => {
    expect(probeModelId("anthropic")).toBe("claude-haiku-4-5");
  });

  it("probes OpenAI keys with the cheapest non-reasoning model", () => {
    const id = probeModelId("openai");
    expect(id).toBe("gpt-5.4-nano");
    expect(isReasoningModel(id!)).toBe(false);
  });

  // Every current Google and DeepSeek model reasons; the probe must still
  // land on something rather than report "no model to test against".
  it("still picks a model when every one the provider has reasons", () => {
    expect(probeModelId("google")).not.toBeNull();
    expect(probeModelId("deepseek")).not.toBeNull();
  });

  it("has a probe for every provider that takes a key", () => {
    const missing = PROVIDERS.filter(
      (p) => providerNeedsKey(p.id) && probeModelId(p.id) === null,
    );
    expect(missing.map((p) => p.id)).toEqual([]);
  });
});

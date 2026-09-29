// Second pass on the discovery filters, from review against the providers'
// real lists: what the first version let through (OpenRouter's $30/$180 `-pro`
// routes, throttled `:free` copies, 8k-context routes, safety and audio
// models) or wrongly dropped (a two-word OpenAI variant, Google's custom-tools
// model), and what it lost on the way to the catalogue (aliases, expiry, the
// adaptive-thinking flag, the provider's reason for a refusal).

import { describe, expect, it } from "vitest";
import {
  listProviderModels,
  parseAnthropicModels,
  parseGoogleModels,
  parseMistralModels,
  parseOpenAIModels,
  parseOpenRouterModels,
  parseXaiModels,
} from "./modelDiscovery";

const ids = (xs: { apiId: string }[]) => xs.map((x) => x.apiId);

describe("OpenAI", () => {
  it("admits a two-word variant and rejects an excluded word anywhere", () => {
    const list = {
      data: [
        { id: "gpt-6.1-sol-mini", created: 3 },
        { id: "gpt-6.1-sol-pro", created: 2 },
        { id: "gpt-6-chat-latest", created: 1 },
      ],
    };
    expect(ids(parseOpenAIModels(list))).toEqual(["gpt-6.1-sol-mini"]);
  });

  it("marks GPT-5+ chat models as taking images", () => {
    expect(parseOpenAIModels({ data: [{ id: "gpt-7" }] })[0].vision).toBe(true);
  });
});

describe("Anthropic", () => {
  it("reads whether the model takes adaptive thinking", () => {
    const card = (supported: boolean) => ({
      type: "model",
      id: "claude-haiku-5-1",
      capabilities: { thinking: { types: { adaptive: { supported } } } },
    });
    expect(parseAnthropicModels({ data: [card(false)] })[0].adaptiveThinking).toBe(false);
    expect(parseAnthropicModels({ data: [card(true)] })[0].adaptiveThinking).toBe(true);
  });
});

describe("Google", () => {
  const model = (name: string) => ({
    name: `models/${name}`,
    supportedGenerationMethods: ["generateContent"],
  });

  // Whole words only: a chat model isn't dropped for a word that merely
  // contains "omni" or "live".
  it("matches excluded words whole, and keeps the custom-tools variant", () => {
    const list = {
      models: [
        model("gemini-3.1-pro-preview-customtools"),
        model("gemini-4-omnibus"),
        model("gemini-3.5-flash-live"),
        model("gemini-2.5-computer-use-preview-10-2025"),
      ],
    };
    expect(ids(parseGoogleModels(list))).toEqual([
      "gemini-3.1-pro-preview-customtools",
      "gemini-4-omnibus",
    ]);
  });
});

describe("aliases", () => {
  it("xAI keeps the aliases a model answers to", () => {
    const [grok] = parseXaiModels({
      data: [
        {
          id: "grok-4.20-0309-reasoning",
          aliases: ["grok-4.20-reasoning"],
          prompt_text_token_price: 12500,
          completion_text_token_price: 25000,
        },
      ],
    });
    expect(grok.aliases).toEqual(["grok-4.20-reasoning"]);
  });

  it("Mistral records every other id of a collapsed model as an alias", () => {
    const card = (id: string) => ({
      id,
      name: "mistral-medium-2604",
      capabilities: { completion_chat: true, function_calling: true },
      type: "base",
      deprecation: null,
    });
    const [m] = parseMistralModels({
      data: [card("mistral-medium-2604"), card("mistral-medium-latest")],
    });
    expect(m.apiId).toBe("mistral-medium-latest");
    expect(m.aliases).toEqual(["mistral-medium-2604"]);
  });
});

describe("OpenRouter", () => {
  const now = Date.parse("2026-09-29T12:00:00Z");
  const route = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    name: `Vendor: ${id}`,
    created: 1790000000,
    context_length: 1_000_000,
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    pricing: { prompt: "0.000001", completion: "0.000002" },
    top_provider: { max_completion_tokens: 64_000 },
    supported_parameters: ["tools"],
    ...over,
  });

  it("drops what an agentic run can't use or shouldn't pay for", () => {
    const data = [
      route("google/gemini-3.1-pro-preview"),
      route("anthropic/claude-sonnet-5.5:free"),
      route("openrouter/auto"),
      route("openai/gpt-6.1-sol-pro"),
      route("openai/gpt-oss-safeguard-20b"),
      route("mistralai/voxtral-small-24b-2507"),
      route("openai/gpt-chat-latest"),
      route("openai/gpt-4", { context_length: 8_192 }),
    ];
    expect(ids(parseOpenRouterModels({ data }, now))).toEqual([
      "google/gemini-3.1-pro-preview",
    ]);
  });

  it("keeps a future expiry so the route leaves the picker on the day", () => {
    const [r] = parseOpenRouterModels(
      { data: [route("qwen/qwen3-max", { expiration_date: "2026-10-09" })] },
      now,
    );
    expect(r.expiresAt).toBe(Date.parse("2026-10-09"));
  });
});

describe("listProviderModels", () => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const asFetch = (f: (url: string) => Promise<Response>) =>
    f as unknown as typeof globalThis.fetch;

  it("asks OpenRouter for the key's own list, falling back to the public one", async () => {
    const urls: string[] = [];
    const fetch = asFetch(async (url) => {
      urls.push(url);
      return url.endsWith("/models/user")
        ? new Response("", { status: 404 })
        : json({ data: [] });
    });
    await listProviderModels("openrouter", "sk-or-x", { fetch });
    expect(urls).toEqual([
      "https://openrouter.ai/api/v1/models/user",
      "https://openrouter.ai/api/v1/models",
    ]);
  });

  it("carries the provider's reason for a refusal", async () => {
    const fetch = asFetch(async () =>
      json({ error: { message: "Missing scope: model.read" } }, 403),
    );
    await expect(listProviderModels("openai", "k", { fetch })).rejects.toThrow(
      "HTTP 403: Missing scope: model.read",
    );
  });

  it("says so plainly when a 200 isn't a model list", async () => {
    const fetch = asFetch(async () => new Response("<html>login</html>", { status: 200 }));
    await expect(listProviderModels("openai", "k", { fetch })).rejects.toThrow(
      "wasn't a model list",
    );
  });
});

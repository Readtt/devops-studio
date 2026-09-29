// Each provider's `/models` answer, as documented (fixtures follow the shapes
// in the providers' API references, 2026-09), and what survives the filter.
// Every list mixes chat models with speech, image, embedding and retired ones;
// the tests are mostly about what must NOT reach the picker.

import { describe, expect, it } from "vitest";
import {
  listProviderModels,
  parseAnthropicModels,
  parseCerebrasModels,
  parseDeepSeekModels,
  parseGoogleModels,
  parseGroqModels,
  parseMistralModels,
  parseOpenAIModels,
  parseOpenRouterModels,
  parseXaiModels,
} from "./modelDiscovery";

const ids = (xs: { apiId: string }[]) => xs.map((x) => x.apiId);

describe("OpenAI", () => {
  const list = {
    object: "list",
    data: [
      { id: "gpt-6-astra", object: "model", created: 1788400000, owned_by: "openai" },
      { id: "gpt-6.1-sol", object: "model", created: 1790640000, owned_by: "openai" },
      { id: "gpt-5.5-2026-04-23", object: "model", created: 1776900000 },
      { id: "gpt-5.2-pro", object: "model", created: 1765400000 },
      { id: "gpt-5.3-codex", object: "model", created: 1771900000 },
      { id: "gpt-5-chat-latest", object: "model", created: 1754500000 },
      { id: "gpt-realtime", object: "model", created: 1756000000 },
      { id: "gpt-4o", object: "model", created: 1715300000 },
      { id: "o3", object: "model", created: 1744800000 },
      { id: "text-embedding-3-large", object: "model", created: 1705900000 },
      { id: "gpt-image-1", object: "model", created: 1745400000 },
      { id: "ft:gpt-5.4-mini:acme::abc123", object: "model", created: 1770000000 },
      { id: "gpt-5.6-luna", object: "model", created: 1783500000, shutdown_date: "2026-10-23" },
    ],
  };

  it("keeps GPT-5+ chat models and nothing else", () => {
    expect(ids(parseOpenAIModels(list)).sort()).toEqual(["gpt-6-astra", "gpt-6.1-sol"]);
  });

  it("dates them from `created` (seconds)", () => {
    const [astra] = parseOpenAIModels(list);
    expect(astra.createdAt).toBe(1788400000 * 1000);
  });
});

describe("Anthropic", () => {
  const page = {
    data: [
      {
        type: "model",
        id: "claude-opus-5-6",
        display_name: "Claude Opus 5.6",
        created_at: "2026-10-01T00:00:00Z",
        max_input_tokens: 1_000_000,
        max_tokens: 128_000,
        capabilities: { image_input: { supported: true } },
      },
      {
        type: "model",
        id: "claude-haiku-4-5-20251001",
        display_name: "Claude Haiku 4.5",
        created_at: "2025-10-01T00:00:00Z",
        max_input_tokens: 200_000,
        max_tokens: 64_000,
        capabilities: { image_input: { supported: true } },
      },
    ],
    has_more: false,
  };

  it("carries the display name, limits and vision", () => {
    expect(parseAnthropicModels(page)[0]).toEqual({
      provider: "anthropic",
      apiId: "claude-opus-5-6",
      label: "Claude Opus 5.6",
      createdAt: Date.parse("2026-10-01T00:00:00Z"),
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      vision: true,
    });
  });
});

describe("Google", () => {
  const list = {
    models: [
      {
        name: "models/gemini-3.8-flash",
        displayName: "Gemini 3.8 Flash",
        inputTokenLimit: 1_048_576,
        outputTokenLimit: 65_536,
        supportedGenerationMethods: ["generateContent", "countTokens"],
        temperature: 1,
        thinking: true,
      },
      {
        name: "models/gemini-pro-latest",
        displayName: "Gemini Pro Latest",
        supportedGenerationMethods: ["generateContent"],
      },
      {
        name: "models/gemini-3.1-flash-tts-preview",
        supportedGenerationMethods: ["generateContent"],
      },
      {
        name: "models/gemini-3.1-flash-image-preview",
        supportedGenerationMethods: ["generateContent"],
      },
      {
        name: "models/gemini-embedding-001",
        supportedGenerationMethods: ["embedContent"],
      },
      {
        name: "models/gemma-3-27b-it",
        supportedGenerationMethods: ["generateContent"],
      },
      {
        name: "models/gemini-2.5-flash-native-audio-latest",
        supportedGenerationMethods: ["generateContent"],
      },
    ],
    nextPageToken: "p2",
  };

  it("keeps text Gemini models, drops aliases, speech, images, embeddings, Gemma", () => {
    expect(ids(parseGoogleModels(list))).toEqual(["gemini-3.8-flash"]);
  });

  it("strips the `models/` prefix and keeps the limits", () => {
    expect(parseGoogleModels(list)[0]).toMatchObject({
      apiId: "gemini-3.8-flash",
      label: "Gemini 3.8 Flash",
      contextWindow: 1_048_576,
      maxOutputTokens: 65_536,
      vision: true,
    });
  });
});

describe("xAI", () => {
  const list = {
    object: "list",
    data: [
      {
        id: "grok-4.7",
        created: 1789900000,
        context_length: 500_000,
        prompt_text_token_price: 20000,
        cached_prompt_text_token_price: 5000,
        completion_text_token_price: 60000,
      },
      { id: "grok-imagine-image", created: 1769472000, image_price: 200000000 },
      {
        id: "grok-4.20-multi-agent-0309",
        created: 1773000000,
        prompt_text_token_price: 12500,
        completion_text_token_price: 25000,
      },
    ],
  };

  it("keeps text models, prices them in $ per 1M", () => {
    expect(parseXaiModels(list)).toEqual([
      {
        provider: "xai",
        apiId: "grok-4.7",
        createdAt: 1789900000 * 1000,
        contextWindow: 500_000,
        pricing: { input: 2, output: 6, cacheRead: 0.5 },
      },
    ]);
  });
});

describe("DeepSeek", () => {
  it("reads the documented example", () => {
    const list = {
      object: "list",
      data: [
        {
          id: "deepseek-flash",
          object: "model",
          owned_by: "deepseek",
          name: "DeepSeek-V4.1-Flash",
          context_window: 1_048_576,
          max_output_tokens: 393_216,
          input_modalities: ["text", "image"],
          output_modalities: ["text"],
        },
      ],
    };
    expect(parseDeepSeekModels(list)[0]).toMatchObject({
      apiId: "deepseek-flash",
      label: "DeepSeek-V4.1-Flash",
      contextWindow: 1_048_576,
      vision: true,
    });
  });
});

describe("Mistral", () => {
  const card = (over: Record<string, unknown>) => ({
    object: "model",
    created: 1776528143,
    owned_by: "mistralai",
    capabilities: { completion_chat: true, function_calling: true, vision: true },
    max_context_length: 262_144,
    aliases: [],
    deprecation: null,
    type: "base",
    ...over,
  });
  const list = {
    object: "list",
    data: [
      card({ id: "mistral-large-2512", name: "mistral-large-2512" }),
      card({ id: "mistral-large-latest", name: "mistral-large-2512" }),
      card({ id: "mistral-medium-2508", name: "mistral-medium-2508", deprecation: "2026-08-31" }),
      card({ id: "mistral-ocr-latest", name: "mistral-ocr-2512", capabilities: { completion_chat: true, function_calling: true, ocr: true } }),
      card({ id: "mistral-embed", name: "mistral-embed", capabilities: { completion_chat: false } }),
      card({ id: "codestral-2508", name: "codestral-2508", capabilities: { completion_chat: true, function_calling: false } }),
    ],
  };

  // Each alias is its own row; keeping `-latest` lets the curated entry, which
  // uses the alias, win the de-duplication.
  it("collapses alias rows onto the -latest id and drops the rest", () => {
    expect(ids(parseMistralModels(list))).toEqual(["mistral-large-latest"]);
  });
});

describe("Groq", () => {
  it("drops inactive, speech and guard models", () => {
    const list = {
      data: [
        { id: "openai/gpt-oss-120b", created: 1754400000, active: true, context_window: 131_072 },
        { id: "whisper-large-v3", created: 1700000000, active: true },
        { id: "meta-llama/llama-guard-4-12b", created: 1740000000, active: true },
        { id: "llama-3.3-70b-versatile", created: 1733000000, active: false },
      ],
    };
    expect(ids(parseGroqModels(list))).toEqual(["openai/gpt-oss-120b"]);
  });
});

describe("Cerebras", () => {
  it("keeps every listed model", () => {
    const list = { data: [{ id: "gpt-oss-120b", created: 1754400000 }, { id: "qwen-3.8-27b" }] };
    expect(ids(parseCerebrasModels(list))).toEqual(["gpt-oss-120b", "qwen-3.8-27b"]);
  });
});

describe("OpenRouter", () => {
  // Verbatim shape of a live entry (2026-09-29).
  const sonnet = {
    id: "anthropic/claude-sonnet-5.5",
    canonical_slug: "anthropic/claude-sonnet-5.5-20260928",
    name: "Anthropic: Claude Sonnet 5.5",
    created: 1790618686,
    context_length: 1_000_000,
    architecture: {
      modality: "text+image+file->text",
      input_modalities: ["text", "image", "file"],
      output_modalities: ["text"],
    },
    pricing: { prompt: "0.000002", completion: "0.00001", input_cache_read: "0.0000002" },
    top_provider: { context_length: 1_000_000, max_completion_tokens: 128_000 },
    supported_parameters: ["max_tokens", "reasoning", "temperature", "tool_choice", "tools"],
    expiration_date: null,
  };
  const route = (over: Record<string, unknown>) => ({ ...sonnet, ...over });
  const now = Date.parse("2026-09-29T12:00:00Z");

  it("reads a route's name, limits, price and vision", () => {
    expect(parseOpenRouterModels({ data: [sonnet] }, now)[0]).toEqual({
      provider: "openrouter",
      apiId: "anthropic/claude-sonnet-5.5",
      label: "Claude Sonnet 5.5",
      createdAt: 1790618686 * 1000,
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      vision: true,
      pricing: { input: 2, output: 10, cacheRead: 0.2 },
    });
  });

  it("drops batch variants, aliases, tool-less, image-out and expired routes", () => {
    const data = [
      sonnet,
      route({ id: "anthropic/claude-sonnet-5.5:batch" }),
      route({ id: "~anthropic/claude-sonnet-latest" }),
      route({ id: "some/no-tools", supported_parameters: ["max_tokens"] }),
      route({
        id: "google/gemini-3.1-flash-image",
        architecture: { input_modalities: ["text"], output_modalities: ["text", "image"] },
      }),
      route({ id: "qwen/qwen3-max", expiration_date: "2026-09-01" }),
      route({ id: "qwen/qwen3.8-max-0902", expiration_date: "2026-12-01" }),
    ];
    expect(ids(parseOpenRouterModels({ data }, now))).toEqual([
      "anthropic/claude-sonnet-5.5",
      "qwen/qwen3.8-max-0902",
    ]);
  });

  it("leaves out a price it can't read (variable-price routes send -1)", () => {
    const [r] = parseOpenRouterModels(
      { data: [route({ id: "vendor/variable-price", pricing: { prompt: "-1", completion: "-1" } })] },
      now,
    );
    expect(r.pricing).toBeUndefined();
  });
});

describe("unrecognised shapes", () => {
  it.each([null, "nope", 42, [], { data: "x" }, { data: [null, 1, "s", {}] }])(
    "%j yields nothing rather than throwing",
    (json) => {
      expect(parseOpenAIModels(json)).toEqual([]);
      expect(parseAnthropicModels(json)).toEqual([]);
      expect(parseGoogleModels(json)).toEqual([]);
      expect(parseOpenRouterModels(json)).toEqual([]);
      expect(parseMistralModels(json)).toEqual([]);
    },
  );
});

describe("listProviderModels", () => {
  const ok = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  it("follows Anthropic's pages and sends its auth headers", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, headers: init?.headers as Record<string, string> });
      return calls.length === 1
        ? ok({ data: [{ type: "model", id: "claude-a" }], has_more: true, last_id: "claude-a" })
        : ok({ data: [{ type: "model", id: "claude-b" }], has_more: false });
    }) as unknown as typeof globalThis.fetch;
    const got = await listProviderModels("anthropic", "sk-ant-x", { fetch });
    expect(ids(got).sort()).toEqual(["claude-a", "claude-b"]);
    expect(calls[1].url).toContain("after_id=claude-a");
    expect(calls[0].headers["x-api-key"]).toBe("sk-ant-x");
    expect(calls[0].headers["anthropic-version"]).toBe("2023-06-01");
  });

  it("reports the HTTP status of a refusal", async () => {
    const fetch = (async () => new Response("no", { status: 401 })) as unknown as typeof globalThis.fetch;
    await expect(listProviderModels("openai", "k", { fetch })).rejects.toThrow("HTTP 401");
  });

  it("gives up after the timeout", async () => {
    const fetch = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof globalThis.fetch;
    await expect(
      listProviderModels("openai", "k", { fetch, timeoutMs: 10 }),
    ).rejects.toThrow("Timed out");
  });

  it("orders the list newest first", async () => {
    const fetch = (async () =>
      ok({
        data: [
          { id: "gpt-5.5", created: 100 },
          { id: "gpt-6.1-sol", created: 300 },
          { id: "gpt-6-astra", created: 200 },
        ],
      })) as unknown as typeof globalThis.fetch;
    expect(ids(await listProviderModels("openai", "k", { fetch }))).toEqual([
      "gpt-6.1-sol",
      "gpt-6-astra",
      "gpt-5.5",
    ]);
  });
});

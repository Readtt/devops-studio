// Live model lists, read from each provider's own `/models` endpoint with the
// user's key — so a model a provider launches shows up in the picker the same
// day, without an app release, and only if this key can actually call it.
//
// Why the providers' endpoints and not a shared catalogue (models.dev, a JSON
// we host): they're already reachable (every run talks to them), they're the
// authority on what exists, and they're scoped to the key. What they lack is
// metadata — OpenAI lists bare ids — and config.ts's `modelInfoFromListing`
// fills that gap with defaults that can't produce a 400.
//
// Every parser here is pure and total: a response in a shape we don't
// recognise yields fewer models, never a throw. Filtering is per provider
// because every list mixes chat models with embeddings, speech, image and
// video models, and each vendor names those differently.

import type { DiscoverableProvider, ModelListing } from "../config";
import { proxyFetch } from "./proxyFetch";

type Json = Record<string, unknown>;

const asRecord = (v: unknown): Json | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const asString = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;
const asPositive = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
/** Unix seconds → epoch ms. */
const fromSeconds = (v: unknown): number | undefined => {
  const s = asPositive(v);
  return s ? s * 1000 : undefined;
};
const recordsOf = (v: unknown): Json[] =>
  asArray(v).flatMap((x) => {
    const r = asRecord(x);
    return r ? [r] : [];
  });

// ── OpenAI ──────────────────────────────────────────────────────────────────

/** `gpt-<major>[.<minor>][-<one word>]` — the shape of every OpenAI chat model
 *  since GPT-5 (gpt-5.4-mini, gpt-6-astra, gpt-6.1-sol). Dated snapshots,
 *  `-chat-latest`, audio/realtime/image variants and fine-tunes all fall
 *  outside it, which is most of what `/v1/models` returns. */
const OPENAI_CHAT_ID = /^gpt-(\d+)(?:\.\d+)?(?:-([a-z]+))?$/;
/** Single-word variants that aren't general chat models, or aren't for this
 *  app: `-pro` is Responses-only at many times the price, `-codex` and
 *  `-cyber` are special-purpose, the rest aren't text chat at all. */
const OPENAI_EXCLUDED_VARIANTS = new Set([
  "pro",
  "codex",
  "cyber",
  "chat",
  "audio",
  "realtime",
  "transcribe",
  "tts",
  "image",
  "search",
  "instruct",
  "preview",
]);

export function parseOpenAIModels(json: unknown): ModelListing[] {
  return recordsOf(asRecord(json)?.data).flatMap((m) => {
    const id = asString(m.id);
    if (!id) return [];
    const match = OPENAI_CHAT_ID.exec(id);
    if (!match || Number(match[1]) < 5) return [];
    if (match[2] && OPENAI_EXCLUDED_VARIANTS.has(match[2])) return [];
    // A scheduled shutdown is still listed until the day it happens.
    if (m.shutdown_date != null) return [];
    return [{ provider: "openai", apiId: id, createdAt: fromSeconds(m.created) }];
  });
}

// ── Anthropic ───────────────────────────────────────────────────────────────

export function parseAnthropicModels(json: unknown): ModelListing[] {
  return recordsOf(asRecord(json)?.data).flatMap((m) => {
    const id = asString(m.id);
    if (!id || (m.type !== undefined && m.type !== "model")) return [];
    const created = asString(m.created_at);
    const createdAt = created ? Date.parse(created) : NaN;
    const caps = asRecord(m.capabilities);
    const image = asRecord(caps?.image_input);
    return [
      {
        provider: "anthropic",
        apiId: id,
        label: asString(m.display_name),
        createdAt: Number.isFinite(createdAt) ? createdAt : undefined,
        contextWindow: asPositive(m.max_input_tokens),
        maxOutputTokens: asPositive(m.max_tokens),
        vision: image ? image.supported === true : undefined,
      },
    ];
  });
}

// ── Google ──────────────────────────────────────────────────────────────────

/** Gemini models that answer `generateContent` but aren't text chat: speech,
 *  images, live audio, embeddings, robotics — plus the `-latest` aliases, which
 *  would list one model twice. */
const GOOGLE_EXCLUDED =
  /(tts|image|live|audio|transcribe|translate|embedding|robotics|computer-use|omni|customtools|-latest|lyria|veo|imagen|aqa|deep-research|antigravity)/;

export function parseGoogleModels(json: unknown): ModelListing[] {
  return recordsOf(asRecord(json)?.models).flatMap((m) => {
    const name = asString(m.name);
    if (!name?.startsWith("models/gemini-")) return [];
    const id = name.slice("models/".length);
    if (GOOGLE_EXCLUDED.test(id)) return [];
    const methods = asArray(m.supportedGenerationMethods);
    if (!methods.includes("generateContent")) return [];
    return [
      {
        provider: "google",
        apiId: id,
        label: asString(m.displayName),
        contextWindow: asPositive(m.inputTokenLimit),
        maxOutputTokens: asPositive(m.outputTokenLimit),
        // Every Gemini chat model takes images.
        vision: true,
      },
    ];
  });
}

// ── xAI ─────────────────────────────────────────────────────────────────────

/** xAI prices in cents per 100M tokens: 12500 → $1.25 per 1M. */
const xaiPrice = (v: unknown): number | undefined => {
  const n = typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
  return n === undefined ? undefined : n / 10_000;
};

export function parseXaiModels(json: unknown): ModelListing[] {
  return recordsOf(asRecord(json)?.data).flatMap((m) => {
    const id = asString(m.id);
    if (!id) return [];
    // Text models carry text token prices; image/video/voice models don't, and
    // multi-agent can't call functions.
    if (m.image_price != null || m.video_price != null) return [];
    if (/imagine|image|video|voice|tts|embed|multi-agent/.test(id)) return [];
    const input = xaiPrice(m.prompt_text_token_price);
    const output = xaiPrice(m.completion_text_token_price);
    if (input === undefined && output === undefined) return [];
    const cacheRead = xaiPrice(m.cached_prompt_text_token_price);
    return [
      {
        provider: "xai",
        apiId: id,
        createdAt: fromSeconds(m.created),
        contextWindow: asPositive(m.context_length),
        ...(input !== undefined && output !== undefined
          ? { pricing: { input, output, ...(cacheRead !== undefined ? { cacheRead } : {}) } }
          : {}),
      },
    ];
  });
}

// ── DeepSeek ────────────────────────────────────────────────────────────────

export function parseDeepSeekModels(json: unknown): ModelListing[] {
  return recordsOf(asRecord(json)?.data).flatMap((m) => {
    const id = asString(m.id);
    if (!id) return [];
    const modalities = asArray(m.input_modalities);
    return [
      {
        provider: "deepseek",
        apiId: id,
        label: asString(m.name),
        contextWindow: asPositive(m.context_window),
        maxOutputTokens: asPositive(m.max_output_tokens),
        vision: modalities.length ? modalities.includes("image") : undefined,
      },
    ];
  });
}

// ── Mistral ─────────────────────────────────────────────────────────────────

/** Mistral lists every alias as its own row (`mistral-large-latest` and
 *  `mistral-large-2512` are one model), so rows are collapsed on the model's
 *  `name`, keeping the `-latest` alias — which is also what the curated list
 *  uses, so the curated entry wins the de-duplication. */
export function parseMistralModels(json: unknown): ModelListing[] {
  const byName = new Map<string, ModelListing>();
  for (const m of recordsOf(asRecord(json)?.data)) {
    const id = asString(m.id);
    if (!id) continue;
    if (m.deprecation != null || m.archived === true) continue;
    if (m.type !== undefined && m.type !== "base" && m.type !== "fine-tuned") {
      continue;
    }
    const caps = asRecord(m.capabilities) ?? {};
    if (caps.completion_chat !== true || caps.function_calling !== true) continue;
    if (caps.ocr === true || caps.moderation === true || caps.classification === true) {
      continue;
    }
    if (/embed|moderation|ocr|transcribe|voxtral|audio/.test(id)) continue;
    const name = asString(m.name) ?? id;
    const listing: ModelListing = {
      provider: "mistral",
      apiId: id,
      createdAt: fromSeconds(m.created),
      contextWindow: asPositive(m.max_context_length),
      vision: caps.vision === true,
    };
    const held = byName.get(name);
    if (!held || (!held.apiId.endsWith("-latest") && id.endsWith("-latest"))) {
      byName.set(name, listing);
    }
  }
  return [...byName.values()];
}

// ── Groq ────────────────────────────────────────────────────────────────────

const GROQ_EXCLUDED =
  /whisper|tts|guard|safeguard|playai|orpheus|distil|compound|prompt-guard/;

export function parseGroqModels(json: unknown): ModelListing[] {
  return recordsOf(asRecord(json)?.data).flatMap((m) => {
    const id = asString(m.id);
    if (!id || m.active === false || GROQ_EXCLUDED.test(id)) return [];
    return [
      {
        provider: "groq",
        apiId: id,
        createdAt: fromSeconds(m.created),
        contextWindow: asPositive(m.context_window),
        maxOutputTokens: asPositive(m.max_completion_tokens),
      },
    ];
  });
}

// ── Cerebras ────────────────────────────────────────────────────────────────

export function parseCerebrasModels(json: unknown): ModelListing[] {
  return recordsOf(asRecord(json)?.data).flatMap((m) => {
    const id = asString(m.id);
    if (!id) return [];
    return [{ provider: "cerebras", apiId: id, createdAt: fromSeconds(m.created) }];
  });
}

// ── OpenRouter ──────────────────────────────────────────────────────────────

/** OpenRouter prices are $ per token as strings; "-1" marks a route whose
 *  price depends on where it's sent. */
const perMillion = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6 * 1e6) / 1e6 : undefined;
};

/** Of ~460 routes, keep the ones an agentic run can use: text in, text out,
 *  tool calling (every surface here reads code through tools), not expired —
 *  and not the `:batch` variants or `~vendor/…-latest` aliases, which repeat
 *  another route. */
export function parseOpenRouterModels(json: unknown, now = Date.now()): ModelListing[] {
  return recordsOf(asRecord(json)?.data).flatMap((m) => {
    const id = asString(m.id);
    if (!id || id.startsWith("~") || id.endsWith(":batch")) return [];
    const arch = asRecord(m.architecture) ?? {};
    const inputs = asArray(arch.input_modalities);
    const outputs = asArray(arch.output_modalities);
    if (!inputs.includes("text") || !outputs.includes("text")) return [];
    if (outputs.includes("image") || outputs.includes("audio")) return [];
    if (!asArray(m.supported_parameters).includes("tools")) return [];
    const expires = asString(m.expiration_date);
    if (expires && Date.parse(expires) <= now) return [];
    const top = asRecord(m.top_provider) ?? {};
    const price = asRecord(m.pricing) ?? {};
    const input = perMillion(price.prompt);
    const output = perMillion(price.completion);
    const cacheRead = perMillion(price.input_cache_read);
    return [
      {
        provider: "openrouter",
        apiId: id,
        // "Anthropic: Claude Sonnet 5.5" → "Claude Sonnet 5.5", matching the
        // curated routes' labels; the vendor is in the id, which is searchable.
        label: asString(m.name)?.replace(/^[^:]{1,40}:\s+/, ""),
        createdAt: fromSeconds(m.created),
        contextWindow: asPositive(m.context_length) ?? asPositive(top.context_length),
        maxOutputTokens: asPositive(top.max_completion_tokens),
        vision: inputs.includes("image"),
        ...(input !== undefined && output !== undefined
          ? { pricing: { input, output, ...(cacheRead !== undefined ? { cacheRead } : {}) } }
          : {}),
      },
    ];
  });
}

// ── Fetching ────────────────────────────────────────────────────────────────

type Request = { url: string; headers: Record<string, string> };

const bearer = (key: string) => ({ Authorization: `Bearer ${key}` });

/** The list endpoint for a provider, for page `cursor` when it paginates. */
function listRequest(
  provider: DiscoverableProvider,
  key: string,
  cursor: string | undefined,
): Request {
  switch (provider) {
    case "openai":
      return { url: "https://api.openai.com/v1/models", headers: bearer(key) };
    case "anthropic":
      return {
        url: `https://api.anthropic.com/v1/models?limit=1000${cursor ? `&after_id=${encodeURIComponent(cursor)}` : ""}`,
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      };
    case "google":
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000${cursor ? `&pageToken=${encodeURIComponent(cursor)}` : ""}`,
        headers: { "x-goog-api-key": key },
      };
    case "xai":
      return { url: "https://api.x.ai/v1/models", headers: bearer(key) };
    case "deepseek":
      return { url: "https://api.deepseek.com/models", headers: bearer(key) };
    case "mistral":
      return { url: "https://api.mistral.ai/v1/models", headers: bearer(key) };
    case "groq":
      return { url: "https://api.groq.com/openai/v1/models", headers: bearer(key) };
    case "cerebras":
      return { url: "https://api.cerebras.ai/v1/models", headers: bearer(key) };
    case "openrouter":
      return { url: "https://openrouter.ai/api/v1/models", headers: bearer(key) };
  }
}

/** Where the next page starts, for the two providers that paginate. */
function nextCursor(provider: DiscoverableProvider, json: unknown): string | undefined {
  const r = asRecord(json);
  if (provider === "anthropic") {
    return r?.has_more === true ? asString(r.last_id) : undefined;
  }
  if (provider === "google") return asString(r?.nextPageToken);
  return undefined;
}

function parse(provider: DiscoverableProvider, json: unknown): ModelListing[] {
  switch (provider) {
    case "openai":
      return parseOpenAIModels(json);
    case "anthropic":
      return parseAnthropicModels(json);
    case "google":
      return parseGoogleModels(json);
    case "xai":
      return parseXaiModels(json);
    case "deepseek":
      return parseDeepSeekModels(json);
    case "mistral":
      return parseMistralModels(json);
    case "groq":
      return parseGroqModels(json);
    case "cerebras":
      return parseCerebrasModels(json);
    case "openrouter":
      return parseOpenRouterModels(json);
  }
}

/** Enough for a 1000-per-page list; a cursor that never ends is a bug on
 *  someone's side, not a reason to loop forever. */
const MAX_PAGES = 10;
export const LIST_TIMEOUT_MS = 20_000;

/** Every chat model `key` can call on `provider`, newest first when the
 *  provider dates them. Throws on a transport failure or an HTTP error, with
 *  the status in the message — the caller keeps the last good list. */
export async function listProviderModels(
  provider: DiscoverableProvider,
  key: string,
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<ModelListing[]> {
  const doFetch = opts.fetch ?? proxyFetch;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), opts.timeoutMs ?? LIST_TIMEOUT_MS);
  try {
    const out: ModelListing[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const req = listRequest(provider, key, cursor);
      const res = await doFetch(req.url, {
        method: "GET",
        headers: req.headers,
        signal: abort.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: unknown = await res.json();
      out.push(...parse(provider, json));
      cursor = nextCursor(provider, json);
      if (!cursor) break;
    }
    return out.sort(
      (a, b) =>
        (b.createdAt ?? 0) - (a.createdAt ?? 0) ||
        b.apiId.localeCompare(a.apiId, undefined, { numeric: true }),
    );
  } catch (e) {
    if (abort.signal.aborted) throw new Error("Timed out");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

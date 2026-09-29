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

/** `gpt-<major>[.<minor>]` plus up to two words — the shape of every OpenAI
 *  chat model since GPT-5 (gpt-5.4-mini, gpt-6-astra, gpt-6.1-sol, and room for
 *  a `gpt-6.1-sol-mini`). Dated snapshots end in digits and fall outside it,
 *  as do `o`-series and pre-GPT-5 ids. */
const OPENAI_CHAT_ID = /^gpt-(\d+)(?:\.\d+)?((?:-[a-z]+){0,2})$/;
/** Words that mark a variant that isn't a general chat model, or isn't for
 *  this app: `-pro` is Responses-only at many times the price, `-codex` and
 *  `-cyber` are special-purpose, the rest aren't text chat at all. */
const OPENAI_EXCLUDED_WORDS = new Set([
  "pro",
  "codex",
  "cyber",
  "chat",
  "latest",
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
    const words = match[2].split("-").filter(Boolean);
    if (words.some((w) => OPENAI_EXCLUDED_WORDS.has(w))) return [];
    // A scheduled shutdown is still listed until the day it happens.
    if (m.shutdown_date != null) return [];
    return [
      {
        provider: "openai",
        apiId: id,
        createdAt: fromSeconds(m.created),
        // Every GPT-5+ chat model takes image input.
        vision: true,
      },
    ];
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
    const adaptive = asRecord(asRecord(asRecord(caps?.thinking)?.types)?.adaptive);
    return [
      {
        provider: "anthropic",
        apiId: id,
        label: asString(m.display_name),
        createdAt: Number.isFinite(createdAt) ? createdAt : undefined,
        contextWindow: asPositive(m.max_input_tokens),
        maxOutputTokens: asPositive(m.max_tokens),
        vision: image ? image.supported === true : undefined,
        adaptiveThinking: adaptive ? adaptive.supported === true : undefined,
      },
    ];
  });
}

// ── Google ──────────────────────────────────────────────────────────────────

/** Words in a Gemini id that mark a model answering `generateContent` without
 *  being text chat — speech, images, live audio, embeddings, robotics — plus
 *  `latest`, whose aliases would list one model twice. Whole words, so a
 *  future chat model isn't dropped for containing "live" or "omni" inside a
 *  word. */
const GOOGLE_EXCLUDED_WORDS = new Set([
  "tts",
  "image",
  "live",
  "audio",
  "transcribe",
  "translate",
  "embedding",
  "robotics",
  "omni",
  "latest",
  "lyria",
  "veo",
  "imagen",
  "aqa",
  "antigravity",
]);
const GOOGLE_EXCLUDED_PHRASES = ["computer-use", "deep-research"];

export function parseGoogleModels(json: unknown): ModelListing[] {
  return recordsOf(asRecord(json)?.models).flatMap((m) => {
    const name = asString(m.name);
    if (!name?.startsWith("models/gemini-")) return [];
    const id = name.slice("models/".length);
    if (id.split("-").some((w) => GOOGLE_EXCLUDED_WORDS.has(w))) return [];
    if (GOOGLE_EXCLUDED_PHRASES.some((p) => id.includes(p))) return [];
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
    const aliases = asArray(m.aliases).flatMap((a) => asString(a) ?? []);
    return [
      {
        provider: "xai",
        apiId: id,
        ...(aliases.length ? { aliases } : {}),
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
  const byName = new Map<string, { listing: ModelListing; ids: Set<string> }>();
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
    const group = byName.get(name) ?? { listing, ids: new Set<string>() };
    group.ids.add(id);
    for (const a of asArray(m.aliases)) {
      const alias = asString(a);
      if (alias) group.ids.add(alias);
    }
    if (!group.listing.apiId.endsWith("-latest") && id.endsWith("-latest")) {
      group.listing = listing;
    }
    byName.set(name, group);
  }
  // Every other id in the group is an alias of the one kept, so a curated
  // entry under any of them still wins the de-duplication.
  return [...byName.values()].map(({ listing, ids }) => {
    const aliases = [...ids].filter((i) => i !== listing.apiId);
    return aliases.length ? { ...listing, aliases } : listing;
  });
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

/** Words in a route's model name that mark something other than a chat model
 *  an agentic run can use — the same exclusions the direct providers' filters
 *  make, applied to what OpenRouter resells. */
const OPENROUTER_EXCLUDED_WORDS = new Set([
  "guard",
  "safeguard",
  "voxtral",
  "audio",
  "tts",
  "realtime",
  "transcribe",
  "search",
  "research",
  "embed",
  "embedding",
  "moderation",
  "ocr",
  "image",
]);

/** Below this a spec, some code and the tool definitions don't fit — the run
 *  fails on its first step, so the route isn't worth offering. */
const OPENROUTER_MIN_CONTEXT = 64_000;

/** Of ~460 routes, keep the ones an agentic run can use: text in, text out,
 *  tool calling (every surface here reads code through tools), a window a run
 *  fits in, not expired. Dropped as well: `:batch` and `:free` variants and
 *  `~vendor/…-latest` aliases, which repeat another route (and free routes
 *  throttle long before a 40-step run ends); OpenRouter's own meta-routers,
 *  which pick a different model per request; and OpenAI's `-pro` tier,
 *  priced like nothing else in the list. */
export function parseOpenRouterModels(json: unknown, now = Date.now()): ModelListing[] {
  return recordsOf(asRecord(json)?.data).flatMap((m) => {
    const id = asString(m.id);
    if (!id || id.startsWith("~") || id.startsWith("openrouter/")) return [];
    if (id.endsWith(":batch") || id.endsWith(":free")) return [];
    const model = id.slice(id.indexOf("/") + 1);
    const words = model.toLowerCase().split(/[^a-z0-9]+/);
    if (words.some((w) => OPENROUTER_EXCLUDED_WORDS.has(w))) return [];
    if (model.includes("chat-latest")) return [];
    if (id.startsWith("openai/") && model.endsWith("-pro")) return [];
    const arch = asRecord(m.architecture) ?? {};
    const inputs = asArray(arch.input_modalities);
    const outputs = asArray(arch.output_modalities);
    if (!inputs.includes("text") || !outputs.includes("text")) return [];
    if (outputs.includes("image") || outputs.includes("audio")) return [];
    if (!asArray(m.supported_parameters).includes("tools")) return [];
    const expires = asString(m.expiration_date);
    const expiresAt = expires ? Date.parse(expires) : NaN;
    if (Number.isFinite(expiresAt) && expiresAt <= now) return [];
    const top = asRecord(m.top_provider) ?? {};
    const contextWindow =
      asPositive(m.context_length) ?? asPositive(top.context_length);
    if (contextWindow !== undefined && contextWindow < OPENROUTER_MIN_CONTEXT) return [];
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
        // Kept so a route that expires between refreshes leaves the picker on
        // the day it goes, not at the next successful check.
        ...(Number.isFinite(expiresAt) ? { expiresAt } : {}),
        contextWindow,
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

type Request = {
  url: string;
  headers: Record<string, string>;
  /** Asked instead when `url` answers 404. */
  fallbackUrl?: string;
};

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
      // The key-scoped list: filtered by the account's provider preferences,
      // privacy settings and guardrails, so it holds only routes this key can
      // actually call. Same shape as the public list, which is the fallback.
      return {
        url: "https://openrouter.ai/api/v1/models/user",
        headers: bearer(key),
        fallbackUrl: "https://openrouter.ai/api/v1/models",
      };
  }
}

/** The provider's own words for a refusal, when its error body has any —
 *  "HTTP 403" alone doesn't say the key lacks a scope. */
async function httpError(res: Response): Promise<Error> {
  let detail: string | undefined;
  try {
    const body = asRecord(JSON.parse(await res.text()));
    const err = body?.error;
    detail =
      asString(err) ?? asString(asRecord(err)?.message) ?? asString(body?.message);
  } catch {
    // Not JSON — the status is all there is.
  }
  const text = detail ? `HTTP ${res.status}: ${detail}` : `HTTP ${res.status}`;
  return new Error(text.length > 160 ? `${text.slice(0, 157)}…` : text);
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
      const get = (url: string) =>
        doFetch(url, { method: "GET", headers: req.headers, signal: abort.signal });
      let res = await get(req.url);
      if (res.status === 404 && req.fallbackUrl) res = await get(req.fallbackUrl);
      if (!res.ok) throw await httpError(res);
      let json: unknown;
      try {
        json = JSON.parse(await res.text());
      } catch {
        throw new Error("The provider's answer wasn't a model list.");
      }
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

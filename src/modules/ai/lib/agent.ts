import { type LanguageModel } from "ai";
import {
  getModel,
  getProvider,
  LMSTUDIO_DEFAULT_BASE_URL,
  MLX_DEFAULT_BASE_URL,
  OLLAMA_DEFAULT_BASE_URL,
  providerNeedsKey,
  type ModelId,
  type ProviderId,
} from "../config";
import type { ProviderKeys } from "./keyring";
import { createProxyFetch, proxyFetch } from "./proxyFetch";

// Local/custom providers may point at a LAN or localhost server, so they get a
// proxy fetch that allows private networks. Cloud providers are public HTTPS
// only and use the default `proxyFetch` (private networks refused).
const localProxyFetch = createProxyFetch({ allowPrivateNetwork: true });
// EVERY provider's HTTP must go through the Rust proxy (`ai_http_stream`), not
// the webview's browser fetch: cloud APIs (Anthropic, OpenAI, …) reject
// cross-origin browser requests, which surfaces as a bare "Failed to fetch".
// Routing through Rust originates the request server-side, so there's no CORS.
const cloudProxyFetch = proxyFetch;

export type BuildModelOptions = {
  lmstudioBaseURL?: string;
  mlxBaseURL?: string;
  ollamaBaseURL?: string;
  openaiCompatibleBaseURL?: string;
};

// Keyed by the whole provider configuration, so it grows with the number of
// distinct configurations a user has used this session — not with requests.
// Never evicted, deliberately: there is nothing per-run in the key.
const modelCache = new Map<string, LanguageModel>();

export async function buildLanguageModel(
  provider: ProviderId,
  keys: ProviderKeys,
  resolvedModelId: string,
  options: BuildModelOptions = {},
): Promise<LanguageModel> {
  if (providerNeedsKey(provider) && !keys[provider]) {
    // The provider here is whichever one the active model belongs to —
    // NOT a hard-coded vendor. Users have read "No API key configured
    // for anthropic" as "this app only works with Anthropic", which is
    // wrong: any of the configured providers works. Lead with the
    // generic "Configure an API key" framing, then name the active
    // provider as supplementary info plus the always-available
    // alternative of switching models.
    const info = getProvider(provider);
    throw new Error(
      `Configure an API key to use this model. The active model needs ${info.label} access — add a key in Settings → Models, or switch to a model from a provider you've already set up.`,
    );
  }
  const key = keys[provider] ?? "";
  const lmstudioURL = options.lmstudioBaseURL ?? LMSTUDIO_DEFAULT_BASE_URL;
  const mlxURL = options.mlxBaseURL ?? MLX_DEFAULT_BASE_URL;
  const ollamaURL = options.ollamaBaseURL ?? OLLAMA_DEFAULT_BASE_URL;
  const compatURL = options.openaiCompatibleBaseURL ?? "";
  // JSON, not a delimiter-joined string: a model id or base URL carrying the
  // delimiter would otherwise let two different configurations share a key,
  // and the hit would silently answer with the wrong endpoint's model.
  const cacheKey = JSON.stringify([
    provider,
    key,
    resolvedModelId,
    lmstudioURL,
    mlxURL,
    ollamaURL,
    compatURL,
  ]);
  const hit = modelCache.get(cacheKey);
  if (hit) return hit;

  let built: LanguageModel;
  switch (provider) {
    case "openai": {
      const { createOpenAI } = await import("@ai-sdk/openai");
      built = createOpenAI({ apiKey: key, fetch: cloudProxyFetch })(
        resolvedModelId,
      );
      break;
    }
    case "anthropic": {
      const { createAnthropic } = await import("@ai-sdk/anthropic");
      built = createAnthropic({ apiKey: key, fetch: cloudProxyFetch })(
        resolvedModelId,
      );
      break;
    }
    case "google": {
      const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
      built = createGoogleGenerativeAI({ apiKey: key, fetch: cloudProxyFetch })(
        resolvedModelId,
      );
      break;
    }
    case "xai": {
      const { createXai } = await import("@ai-sdk/xai");
      built = createXai({ apiKey: key, fetch: cloudProxyFetch })(
        resolvedModelId,
      );
      break;
    }
    case "cerebras": {
      const { createCerebras } = await import("@ai-sdk/cerebras");
      built = createCerebras({ apiKey: key, fetch: cloudProxyFetch })(
        resolvedModelId,
      );
      break;
    }
    case "deepseek": {
      const { createOpenAICompatible } =
        await import("@ai-sdk/openai-compatible");
      built = createOpenAICompatible({
        name: "deepseek",
        baseURL: "https://api.deepseek.com",
        apiKey: key,
        fetch: cloudProxyFetch,
        // Without this, generateObject falls back to weak json_object mode (no
        // schema sent) and these endpoints often return prose/fenced JSON →
        // empty results. DeepSeek/Mistral/OpenRouter support strict json_schema.
        supportsStructuredOutputs: true,
      })(resolvedModelId);
      break;
    }
    case "mistral": {
      const { createOpenAICompatible } =
        await import("@ai-sdk/openai-compatible");
      built = createOpenAICompatible({
        name: "mistral",
        baseURL: "https://api.mistral.ai/v1",
        apiKey: key,
        fetch: cloudProxyFetch,
        supportsStructuredOutputs: true,
      })(resolvedModelId);
      break;
    }
    case "groq": {
      const { createGroq } = await import("@ai-sdk/groq");
      built = createGroq({ apiKey: key, fetch: cloudProxyFetch })(
        resolvedModelId,
      );
      break;
    }
    case "openrouter": {
      const { createOpenAICompatible } =
        await import("@ai-sdk/openai-compatible");
      built = createOpenAICompatible({
        name: "openrouter",
        baseURL: "https://openrouter.ai/api/v1",
        apiKey: key,
        headers: {
          "HTTP-Referer": "https://devopsstudio.app",
          "X-Title": "DevOps Studio",
        },
        fetch: cloudProxyFetch,
        supportsStructuredOutputs: true,
      })(resolvedModelId);
      break;
    }
    case "openai-compatible": {
      if (!compatURL) {
        throw new Error(
          "OpenAI-compatible provider has no base URL. Set it in Settings → Models.",
        );
      }
      const { createOpenAICompatible } =
        await import("@ai-sdk/openai-compatible");
      built = createOpenAICompatible({
        name: "openai-compatible",
        baseURL: compatURL,
        apiKey: key || undefined,
        fetch: localProxyFetch,
      })(resolvedModelId);
      break;
    }
    case "lmstudio": {
      const { createOpenAICompatible } =
        await import("@ai-sdk/openai-compatible");
      built = createOpenAICompatible({
        name: "lmstudio",
        baseURL: lmstudioURL,
        fetch: localProxyFetch,
      })(resolvedModelId);
      break;
    }
    case "mlx": {
      const { createOpenAICompatible } =
        await import("@ai-sdk/openai-compatible");
      built = createOpenAICompatible({
        name: "mlx",
        baseURL: mlxURL,
        fetch: localProxyFetch,
      })(resolvedModelId);
      break;
    }
    case "ollama": {
      const { createOpenAICompatible } =
        await import("@ai-sdk/openai-compatible");
      built = createOpenAICompatible({
        name: "ollama",
        baseURL: ollamaURL,
        fetch: localProxyFetch,
      })(resolvedModelId);
      break;
    }
    default: {
      const _exhaustive: never = provider;
      throw new Error(`Unsupported provider: ${_exhaustive as ProviderId}`);
    }
  }
  modelCache.set(cacheKey, built);
  return built;
}

export type LocalProviderConfig = {
  lmstudioBaseURL?: string;
  lmstudioModelId?: string;
  mlxBaseURL?: string;
  mlxModelId?: string;
  ollamaBaseURL?: string;
  ollamaModelId?: string;
  openaiCompatibleBaseURL?: string;
  openaiCompatibleModelId?: string;
};

export function buildConfiguredLanguageModel(
  modelId: ModelId,
  keys: ProviderKeys,
  local: LocalProviderConfig = {},
): Promise<LanguageModel> {
  const m = getModel(modelId);
  let resolvedId: string = m.id;
  if (m.id === "lmstudio-local") {
    if (!local.lmstudioModelId?.trim()) {
      throw new Error(
        "LM Studio: no model id set. Open Settings → Models and enter the model id loaded in LM Studio.",
      );
    }
    resolvedId = local.lmstudioModelId.trim();
  } else if (m.id === "mlx-local") {
    if (!local.mlxModelId?.trim()) {
      throw new Error(
        "MLX: no model id set. Open Settings → Models and enter the model id served by mlx_lm.server.",
      );
    }
    resolvedId = local.mlxModelId.trim();
  } else if (m.id === "ollama-local") {
    if (!local.ollamaModelId?.trim()) {
      throw new Error(
        "Ollama: no model id set. Open Settings → Models and enter the model id (e.g. the name from `ollama list`).",
      );
    }
    resolvedId = local.ollamaModelId.trim();
  } else if (m.id === "openai-compatible-custom") {
    if (!local.openaiCompatibleModelId?.trim()) {
      throw new Error(
        "OpenAI-compatible: no model id set. Open Settings → Models.",
      );
    }
    resolvedId = local.openaiCompatibleModelId.trim();
  }
  return buildLanguageModel(m.provider, keys, resolvedId, {
    lmstudioBaseURL: local.lmstudioBaseURL,
    mlxBaseURL: local.mlxBaseURL,
    ollamaBaseURL: local.ollamaBaseURL,
    openaiCompatibleBaseURL: local.openaiCompatibleBaseURL,
  });
}

// Assemble the stable system prefix for a surface: the surface's base prompt,
// then optional project memory and user custom instructions. The runner passes
// the per-surface base (from systemPrompts.ts); this helper only layers the
// shared blocks so cache breakpoints land on identical bytes across turns.
export function buildStableSystem(
  base: string,
  customInstructions: string | undefined,
  projectMemory: string | null,
): string {
  const customBlock = customInstructions?.trim()
    ? `\n\n## USER CUSTOM INSTRUCTIONS — follow unless they conflict with safety rules above\n${customInstructions.trim()}`
    : "";
  const memoryBlock =
    projectMemory && projectMemory.trim().length > 0
      ? `\n\n## PROJECT — DEVOPS_STUDIO.md\n${projectMemory.trim()}`
      : "";
  return `${base}${memoryBlock}${customBlock}`;
}

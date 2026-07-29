export const KEYRING_SERVICE = "devops-studio";

export type ProviderId =
  | "openai"
  | "anthropic"
  | "google"
  | "xai"
  | "cerebras"
  | "groq"
  | "deepseek"
  | "mistral"
  | "openrouter"
  | "openai-compatible"
  | "lmstudio"
  | "mlx"
  | "ollama";

export type ProviderInfo = {
  id: ProviderId;
  label: string;
  keyringAccount: string;
  keyPrefix: string | null;
  consoleUrl: string;
  /** Provider accepts (but does not require) an API key. */
  keyOptional?: boolean;
};

export const PROVIDERS: readonly ProviderInfo[] = [
  {
    id: "openai",
    label: "OpenAI",
    keyringAccount: "openai-api-key",
    keyPrefix: "sk-",
    consoleUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    keyringAccount: "anthropic-api-key",
    keyPrefix: "sk-ant-",
    consoleUrl: "https://console.anthropic.com/settings/keys",
  },
  {
    id: "google",
    label: "Google",
    keyringAccount: "google-api-key",
    keyPrefix: null,
    consoleUrl: "https://aistudio.google.com/apikey",
  },
  {
    id: "xai",
    label: "xAI",
    keyringAccount: "xai-api-key",
    keyPrefix: "xai-",
    consoleUrl: "https://console.x.ai/",
  },
  {
    id: "cerebras",
    label: "Cerebras",
    keyringAccount: "cerebras-api-key",
    keyPrefix: "csk-",
    consoleUrl: "https://cloud.cerebras.ai/",
  },
  {
    id: "groq",
    label: "Groq",
    keyringAccount: "groq-api-key",
    keyPrefix: "gsk_",
    consoleUrl: "https://console.groq.com/keys",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    keyringAccount: "deepseek-api-key",
    keyPrefix: "sk-",
    consoleUrl: "https://platform.deepseek.com/api_keys",
  },
  {
    id: "mistral",
    label: "Mistral",
    keyringAccount: "mistral-api-key",
    keyPrefix: null,
    consoleUrl: "https://console.mistral.ai/api-keys/",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    keyringAccount: "openrouter-api-key",
    keyPrefix: "sk-or-",
    consoleUrl: "https://openrouter.ai/keys",
  },
  {
    id: "openai-compatible",
    label: "OpenAI Compatible",
    keyringAccount: "openai-compatible-api-key",
    keyPrefix: null,
    consoleUrl: "https://platform.openai.com/docs/api-reference",
    keyOptional: true,
  },
  {
    id: "lmstudio",
    label: "LM Studio",
    keyringAccount: "",
    keyPrefix: null,
    consoleUrl: "https://lmstudio.ai/docs/basics/server",
  },
  {
    id: "mlx",
    label: "MLX",
    keyringAccount: "",
    keyPrefix: null,
    consoleUrl: "https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/SERVER.md",
  },
  {
    id: "ollama",
    label: "Ollama",
    keyringAccount: "",
    keyPrefix: null,
    consoleUrl: "https://ollama.com/download",
  },
] as const;

export function getProvider(id: ProviderId): ProviderInfo {
  const p = PROVIDERS.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown provider: ${id}`);
  return p;
}

/** 1 (lowest) – 5 (highest). For `cost`, higher = cheaper. */
export type CapabilityScore = 1 | 2 | 3 | 4 | 5;

export type ModelCapabilities = {
  intelligence: CapabilityScore;
  speed: CapabilityScore;
  cost: CapabilityScore;
};

export type ModelTag = "vision" | "reasoning" | "tools" | "coding";

export type ModelInfo = {
  id: string;
  provider: ProviderId;
  label: string;
  /** One short word for the dropdown trigger. */
  hint: string;
  /** One-line marketing-style description shown under the label. */
  description: string;
  capabilities: ModelCapabilities;
  tags?: readonly ModelTag[];
};

export const MODELS = [
  // ── OpenAI ────────────────────────────────────────────────────────────────
  {
    id: "gpt-5.5",
    provider: "openai",
    label: "GPT-5.5",
    hint: "Flagship",
    description: "Frontier reasoning and code.",
    capabilities: { intelligence: 5, speed: 3, cost: 1 },
    tags: ["vision", "reasoning", "tools", "coding"],
  },
  {
    id: "gpt-5.4-mini",
    provider: "openai",
    label: "GPT-5.4 mini",
    hint: "Fast",
    description: "Snappy default at low cost.",
    capabilities: { intelligence: 4, speed: 4, cost: 4 },
    tags: ["vision", "tools"],
  },
  {
    id: "gpt-5.4-nano",
    provider: "openai",
    label: "GPT-5.4 nano",
    hint: "Fastest",
    description: "Tiny and instant — great for autocomplete.",
    capabilities: { intelligence: 3, speed: 5, cost: 5 },
    tags: ["tools"],
  },
  {
    id: "gpt-5.3-codex",
    provider: "openai",
    label: "GPT-5.3 Codex",
    hint: "Coding",
    description: "Tuned for code and tool use.",
    capabilities: { intelligence: 4, speed: 4, cost: 3 },
    tags: ["tools", "coding"],
  },

  // ── Anthropic ─────────────────────────────────────────────────────────────
  {
    id: "claude-opus-5",
    provider: "anthropic",
    label: "Claude Opus 5",
    hint: "Best",
    description: "Anthropic's flagship for deep reasoning and agentic work.",
    capabilities: { intelligence: 5, speed: 2, cost: 1 },
    tags: ["vision", "reasoning", "tools", "coding"],
  },
  {
    id: "claude-sonnet-5",
    provider: "anthropic",
    label: "Claude Sonnet 5",
    hint: "Balanced",
    description: "Frontier Sonnet with a 1M-token context window.",
    capabilities: { intelligence: 5, speed: 4, cost: 3 },
    tags: ["vision", "tools", "coding"],
  },
  {
    id: "claude-haiku-4-5",
    provider: "anthropic",
    label: "Claude Haiku 4.5",
    hint: "Fast",
    description: "Quick, cheap, multimodal.",
    capabilities: { intelligence: 3, speed: 5, cost: 4 },
    tags: ["vision", "tools"],
  },

  // ── Google ────────────────────────────────────────────────────────────────
  {
    id: "gemini-3.1-pro-preview",
    provider: "google",
    label: "Gemini 3.1 Pro",
    hint: "Flagship",
    description: "Strong reasoning, 1M context.",
    capabilities: { intelligence: 5, speed: 3, cost: 2 },
    tags: ["vision", "reasoning", "tools", "coding"],
  },
  {
    id: "gemini-3-flash-preview",
    provider: "google",
    label: "Gemini 3 Flash",
    hint: "Fast",
    description: "Fast multimodal, 1M context.",
    capabilities: { intelligence: 4, speed: 5, cost: 4 },
    tags: ["vision", "tools"],
  },

  // ── xAI ───────────────────────────────────────────────────────────────────
  {
    id: "grok-4.20-reasoning",
    provider: "xai",
    label: "Grok 4.20 Reasoning",
    hint: "Reasoning",
    description: "Frontier reasoning with extended thinking.",
    capabilities: { intelligence: 5, speed: 2, cost: 2 },
    tags: ["reasoning", "tools", "coding"],
  },
  {
    id: "grok-4.20-non-reasoning",
    provider: "xai",
    label: "Grok 4.20",
    hint: "Fast",
    description: "Fast tier for chat and tools.",
    capabilities: { intelligence: 4, speed: 4, cost: 3 },
    tags: ["tools"],
  },
  {
    id: "grok-4-fast-reasoning",
    provider: "xai",
    label: "Grok 4 Fast",
    hint: "Reasoning",
    description: "Cheaper Grok 4 with vision and reasoning.",
    capabilities: { intelligence: 4, speed: 4, cost: 4 },
    tags: ["vision", "reasoning", "tools"],
  },

  // ── DeepSeek ──────────────────────────────────────────────────────────────
  {
    id: "deepseek-v4-pro",
    provider: "deepseek",
    label: "DeepSeek V4 Pro",
    hint: "Best",
    description: "Strong open-weight code model.",
    capabilities: { intelligence: 5, speed: 3, cost: 4 },
    tags: ["reasoning", "tools", "coding"],
  },
  {
    id: "deepseek-v4-flash",
    provider: "deepseek",
    label: "DeepSeek V4 Flash",
    hint: "Fast",
    description: "Cheap and fast everyday tier.",
    capabilities: { intelligence: 4, speed: 5, cost: 5 },
    tags: ["tools"],
  },
  {
    id: "deepseek-reasoner",
    provider: "deepseek",
    label: "DeepSeek Reasoner",
    hint: "Thinking",
    description: "Chain-of-thought at open-weight prices.",
    capabilities: { intelligence: 5, speed: 2, cost: 4 },
    tags: ["reasoning", "coding"],
  },

  // ── Mistral ────────────────────────────────────────────────────────────────
  {
    id: "mistral-large-latest",
    provider: "mistral",
    label: "Mistral Large 3",
    hint: "Best",
    description: "Flagship Mistral model with 128K context.",
    capabilities: { intelligence: 5, speed: 3, cost: 3 },
    tags: ["vision", "tools", "coding"],
  },
  {
    id: "mistral-medium-latest",
    provider: "mistral",
    label: "Mistral Medium 3.5",
    hint: "Balanced",
    description: "Good balance of speed and intelligence.",
    capabilities: { intelligence: 4, speed: 4, cost: 4 },
    tags: ["vision", "tools"],
  },
  {
    id: "codestral-latest",
    provider: "mistral",
    label: "Codestral",
    hint: "Code",
    description: "Purpose-built coding model from Mistral.",
    capabilities: { intelligence: 4, speed: 4, cost: 4 },
    tags: ["coding"],
  },

  // ── Cerebras (autocomplete-tier) ──────────────────────────────────────────
  {
    id: "gpt-oss-120b",
    provider: "cerebras",
    label: "GPT-OSS 120B",
    hint: "Ultra-fast",
    description: "Fastest inference on Cerebras silicon.",
    capabilities: { intelligence: 4, speed: 5, cost: 4 },
    tags: ["tools", "coding"],
  },
  {
    id: "llama3.3-70b",
    provider: "cerebras",
    label: "Llama 3.3 70B",
    hint: "Fast",
    description: "Meta's open model on wafer-scale silicon.",
    capabilities: { intelligence: 3, speed: 5, cost: 5 },
    tags: ["tools"],
  },
  {
    id: "qwen-3-32b",
    provider: "cerebras",
    label: "Qwen 3 32B",
    hint: "Fast",
    description: "Multilingual model at extreme speed.",
    capabilities: { intelligence: 3, speed: 5, cost: 5 },
    tags: ["tools", "coding"],
  },

  // ── Groq (autocomplete-tier) ──────────────────────────────────────────────
  {
    id: "openai/gpt-oss-20b",
    provider: "groq",
    label: "GPT-OSS 20B",
    hint: "Ultra-fast",
    description: "Sub-second responses on Groq LPU.",
    capabilities: { intelligence: 3, speed: 5, cost: 5 },
    tags: ["tools", "coding"],
  },
  {
    id: "llama-3.3-70b-versatile",
    provider: "groq",
    label: "Llama 3.3 70B",
    hint: "Versatile",
    description: "Fast and broadly capable.",
    capabilities: { intelligence: 4, speed: 5, cost: 5 },
    tags: ["tools"],
  },
  {
    id: "deepseek-r1-distill-llama-70b",
    provider: "groq",
    label: "DeepSeek R1 Distill 70B",
    hint: "Thinking",
    description: "Reasoning-distilled Llama on Groq.",
    capabilities: { intelligence: 4, speed: 5, cost: 5 },
    tags: ["reasoning", "tools"],
  },

  // ── OpenRouter (gateway — curated cross-provider routes) ──────────────────
  {
    id: "anthropic/claude-sonnet-5",
    provider: "openrouter",
    label: "Claude Sonnet 5",
    hint: "OpenRouter",
    description: "Frontier Sonnet via OpenRouter.",
    capabilities: { intelligence: 5, speed: 4, cost: 3 },
    tags: ["vision", "tools", "coding"],
  },
  {
    id: "anthropic/claude-opus-5",
    provider: "openrouter",
    label: "Claude Opus 5",
    hint: "OpenRouter",
    description: "Anthropic flagship via OpenRouter.",
    capabilities: { intelligence: 5, speed: 2, cost: 1 },
    tags: ["vision", "reasoning", "tools", "coding"],
  },
  {
    id: "openai/gpt-5.5",
    provider: "openrouter",
    label: "GPT-5.5",
    hint: "OpenRouter",
    description: "OpenAI flagship via OpenRouter.",
    capabilities: { intelligence: 5, speed: 3, cost: 1 },
    tags: ["vision", "reasoning", "tools", "coding"],
  },
  {
    id: "openai/gpt-5.4-mini",
    provider: "openrouter",
    label: "GPT-5.4 mini",
    hint: "OpenRouter",
    description: "Snappy GPT via OpenRouter.",
    capabilities: { intelligence: 4, speed: 4, cost: 4 },
    tags: ["vision", "tools"],
  },
  {
    id: "google/gemini-3.1-pro-preview",
    provider: "openrouter",
    label: "Gemini 3.1 Pro",
    hint: "OpenRouter",
    description: "Google flagship via OpenRouter.",
    capabilities: { intelligence: 5, speed: 3, cost: 2 },
    tags: ["vision", "reasoning", "tools", "coding"],
  },
  {
    id: "x-ai/grok-4.20-reasoning",
    provider: "openrouter",
    label: "Grok 4.20 Reasoning",
    hint: "OpenRouter",
    description: "xAI reasoning via OpenRouter.",
    capabilities: { intelligence: 5, speed: 2, cost: 2 },
    tags: ["reasoning", "tools", "coding"],
  },
  {
    id: "deepseek/deepseek-v4-pro",
    provider: "openrouter",
    label: "DeepSeek V4 Pro",
    hint: "OpenRouter",
    description: "Open-weight coding model.",
    capabilities: { intelligence: 5, speed: 3, cost: 5 },
    tags: ["reasoning", "tools", "coding"],
  },
  {
    id: "deepseek/deepseek-reasoner",
    provider: "openrouter",
    label: "DeepSeek Reasoner",
    hint: "OpenRouter",
    description: "Cheap chain-of-thought reasoner.",
    capabilities: { intelligence: 5, speed: 2, cost: 5 },
    tags: ["reasoning", "coding"],
  },
  {
    id: "meta-llama/llama-4-scout-17b-16e-instruct",
    provider: "openrouter",
    label: "Llama 4 Scout",
    hint: "OpenRouter",
    description: "Meta's efficient multimodal model.",
    capabilities: { intelligence: 4, speed: 4, cost: 5 },
    tags: ["vision", "tools"],
  },
  {
    id: "meta-llama/llama-4-maverick",
    provider: "openrouter",
    label: "Llama 4 Maverick",
    hint: "OpenRouter",
    description: "Meta's flagship open multimodal model.",
    capabilities: { intelligence: 4, speed: 3, cost: 5 },
    tags: ["vision", "tools", "coding"],
  },
  {
    id: "moonshotai/kimi-k2.5",
    provider: "openrouter",
    label: "Kimi K2.5",
    hint: "OpenRouter",
    description: "Moonshot's agentic flagship.",
    capabilities: { intelligence: 5, speed: 3, cost: 4 },
    tags: ["vision", "tools", "coding"],
  },
  {
    id: "qwen/qwen3-max",
    provider: "openrouter",
    label: "Qwen 3 Max",
    hint: "OpenRouter",
    description: "Alibaba's multilingual reasoner.",
    capabilities: { intelligence: 5, speed: 3, cost: 4 },
    tags: ["reasoning", "tools", "coding"],
  },
  {
    id: "qwen/qwen3-coder",
    provider: "openrouter",
    label: "Qwen 3 Coder",
    hint: "OpenRouter",
    description: "Qwen tuned for code.",
    capabilities: { intelligence: 4, speed: 4, cost: 5 },
    tags: ["tools", "coding"],
  },
  {
    id: "mistralai/mistral-large-latest",
    provider: "openrouter",
    label: "Mistral Large",
    hint: "OpenRouter",
    description: "EU-hosted general-purpose flagship.",
    capabilities: { intelligence: 4, speed: 4, cost: 3 },
    tags: ["tools", "coding"],
  },
  {
    id: "z-ai/glm-4.6",
    provider: "openrouter",
    label: "GLM 4.6",
    hint: "OpenRouter",
    description: "Zhipu's long-context agentic model.",
    capabilities: { intelligence: 4, speed: 4, cost: 4 },
    tags: ["tools", "coding"],
  },

  // ── Generic OpenAI-compatible (user-defined endpoint) ─────────────────────
  {
    id: "openai-compatible-custom",
    provider: "openai-compatible",
    label: "Custom endpoint",
    hint: "Configurable",
    description: "Any OpenAI-compatible endpoint.",
    capabilities: { intelligence: 3, speed: 3, cost: 3 },
  },

  // ── LM Studio (local; model id is user-supplied at runtime) ───────────────
  {
    id: "lmstudio-local",
    provider: "lmstudio",
    label: "LM Studio",
    hint: "Local",
    description: "Local GGUF models via LM Studio.",
    capabilities: { intelligence: 3, speed: 3, cost: 5 },
  },

  // ── MLX (local; Apple-silicon; model id is user-supplied at runtime) ──────
  {
    id: "mlx-local",
    provider: "mlx",
    label: "MLX",
    hint: "Local",
    description: "Apple-silicon models via mlx_lm.server.",
    capabilities: { intelligence: 3, speed: 3, cost: 5 },
  },

  // ── Ollama (local; model id is user-supplied at runtime) ──────────────────
  {
    id: "ollama-local",
    provider: "ollama",
    label: "Ollama",
    hint: "Local",
    description: "Local models via Ollama.",
    capabilities: { intelligence: 3, speed: 3, cost: 5 },
  },
] as const satisfies readonly ModelInfo[];

export type ModelId = (typeof MODELS)[number]["id"];

export function getModel(id: ModelId): ModelInfo {
  const m = MODELS.find((x) => x.id === id);
  if (!m) throw new Error(`Unknown model: ${id}`);
  return m;
}

/** Whether `id` is a currently-registered model. Used to sanitize persisted
 *  selections (default/favorites/recents) after a model is retired — a stale id
 *  would otherwise crash `getModel` at the picker/runner. */
export function isKnownModelId(id: string): id is ModelId {
  return MODELS.some((x) => x.id === id);
}

/** Whether a model accepts image input. Used to gate sending image
 *  attachments / best-practices images as real vision parts — non-vision
 *  models would error, so callers fall back to a text-only reference. Unknown
 *  model ids (custom / local endpoints) conservatively return false. */
export function supportsVision(id: ModelId | string): boolean {
  try {
    return getModel(id as ModelId).tags?.includes("vision") ?? false;
  } catch {
    return false;
  }
}

/** Whether a model is a reasoning model. Reasoning models on several providers
 *  (DeepSeek's reasoner, xAI Grok reasoning, OpenAI o-series) reject or ignore
 *  sampling params like `temperature` — the native @ai-sdk/openai provider
 *  strips them, but @ai-sdk/openai-compatible and @ai-sdk/xai pass them through
 *  unconditionally and can 400. The runner uses this to omit temperature for
 *  reasoning targets. Unknown ids (custom / local) conservatively return false. */
export function isReasoningModel(id: ModelId | string): boolean {
  try {
    return getModel(id as ModelId).tags?.includes("reasoning") ?? false;
  } catch {
    return false;
  }
}

export const DEFAULT_MODEL_ID: ModelId = "claude-sonnet-5";

/** Approximate context window (in tokens) per model. Used for the
 *  context-usage indicator in the AI mini-window header. Conservative
 *  estimates — actual provider limits may shift. */
export const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  "gpt-5.5": 1_050_000,
  "gpt-5.4-mini": 400_000,
  "gpt-5.4-nano": 400_000,
  "gpt-5.3-codex": 400_000,
  "claude-opus-5": 1_000_000,
  "claude-sonnet-5": 1_000_000,
  "claude-haiku-4-5": 200_000,
  "gemini-3.1-pro-preview": 1_000_000,
  "gemini-3-flash-preview": 1_000_000,
  "grok-4.20-reasoning": 2_000_000,
  "grok-4.20-non-reasoning": 2_000_000,
  "grok-4-fast-reasoning": 2_000_000,
  "deepseek-v4-pro": 1_000_000,
  "deepseek-v4-flash": 1_000_000,
  "deepseek-reasoner": 128_000,
  "gpt-oss-120b": 128_000,
  "llama3.3-70b": 128_000,
  "qwen-3-32b": 32_000,
  "openai/gpt-oss-20b": 128_000,
  "llama-3.3-70b-versatile": 128_000,
  "deepseek-r1-distill-llama-70b": 128_000,
  "anthropic/claude-opus-5": 1_000_000,
  "anthropic/claude-sonnet-5": 1_000_000,
  "openai/gpt-5.5": 1_050_000,
  "openai/gpt-5.4-mini": 400_000,
  "google/gemini-3.1-pro-preview": 1_000_000,
  "x-ai/grok-4.20-reasoning": 2_000_000,
  "deepseek/deepseek-v4-pro": 1_000_000,
  "deepseek/deepseek-reasoner": 128_000,
  "meta-llama/llama-4-scout-17b-16e-instruct": 1_000_000,
  "meta-llama/llama-4-maverick": 1_000_000,
  "moonshotai/kimi-k2.5": 256_000,
  "qwen/qwen3-max": 256_000,
  "qwen/qwen3-coder": 256_000,
  "mistralai/mistral-large-latest": 128_000,
  "z-ai/glm-4.6": 200_000,
  "openai-compatible-custom": 128_000,
  "lmstudio-local": 32_000,
  "mlx-local": 32_000,
  "ollama-local": 32_000,
  "mistral-large-latest": 131_072,
  "mistral-medium-latest": 32_768,
  "codestral-latest": 256_000,
};

export function getModelContextLimit(
  modelId: string | undefined,
  compatOverride?: number,
): number {
  if (!modelId) return 128_000;
  if (modelId === "openai-compatible-custom" && compatOverride)
    return compatOverride;
  return MODEL_CONTEXT_LIMITS[modelId] ?? 128_000;
}

export type ModelPricing = {
  input: number;
  output: number;
  cacheRead?: number;
};

export const MODEL_PRICING: Record<string, ModelPricing> = {
  "gpt-5.5": { input: 5, output: 15, cacheRead: 0.5 },
  "gpt-5.4-mini": { input: 0.4, output: 1.6, cacheRead: 0.04 },
  "gpt-5.4-nano": { input: 0.1, output: 0.4, cacheRead: 0.01 },
  "gpt-5.3-codex": { input: 1.5, output: 6, cacheRead: 0.15 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-sonnet-5": { input: 3, output: 15, cacheRead: 0.3 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1 },
  "gemini-3.1-pro-preview": { input: 1.25, output: 10, cacheRead: 0.31 },
  "gemini-3-flash-preview": { input: 0.3, output: 2.5, cacheRead: 0.075 },
  "grok-4.20-reasoning": { input: 3, output: 15 },
  "grok-4.20-non-reasoning": { input: 1, output: 5 },
  "grok-4-fast-reasoning": { input: 0.2, output: 0.5 },
  "deepseek-v4-pro": { input: 0.28, output: 1.1, cacheRead: 0.028 },
  "deepseek-v4-flash": { input: 0.07, output: 0.27, cacheRead: 0.007 },
  "deepseek-reasoner": { input: 0.55, output: 2.19, cacheRead: 0.14 },
};

export function estimateCost(
  modelId: string | undefined,
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number },
): number | null {
  if (!modelId) return null;
  const p = MODEL_PRICING[modelId];
  if (!p) return null;
  const fresh = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  const cached = usage.cachedInputTokens;
  return (
    (fresh * p.input + cached * (p.cacheRead ?? p.input) + usage.outputTokens * p.output) /
    1_000_000
  );
}

/** Providers that do not require an API key (local servers, key-optional). */
export const KEYLESS_PROVIDERS: readonly ProviderId[] = [
  "lmstudio",
  "mlx",
  "ollama",
  "openai-compatible",
] as const;

export function providerNeedsKey(id: ProviderId): boolean {
  return !KEYLESS_PROVIDERS.includes(id);
}

/** True for providers that accept an API key — required *or* optional.
 *  Used by Settings to decide whether to render a key card at all. */
export function providerSupportsKey(id: ProviderId): boolean {
  if (providerNeedsKey(id)) return true;
  const p = getProvider(id);
  return !!p.keyOptional;
}

export const LMSTUDIO_DEFAULT_BASE_URL = "http://localhost:1234/v1";
export const MLX_DEFAULT_BASE_URL = "http://127.0.0.1:8080/v1";
export const OLLAMA_DEFAULT_BASE_URL = "http://localhost:11434/v1";
export const OPENAI_COMPATIBLE_DEFAULT_BASE_URL = "";
export const MAX_AGENT_STEPS = 24;
export const TERMINAL_BUFFER_LINES = 300;

/** Per-surface caps on the agentic read loop (how many tool-calling steps the
 *  model may take before it's forced to produce its final answer). The
 *  Generator gets the most room because it traces across many files; confidence
 *  now follows call chains into implementations (not just call sites), so it
 *  needs headroom to stay accurate without dragging on. */
export const SURFACE_STEP_CAPS = {
  generator: 24,
  suiteChat: 12,
  // Commit Review runs two stages: a generous agentic investigation pass that
  // traces blast radius across the tree, then a lean skeptical verify pass.
  commitReviewInvestigate: 28,
  commitReviewVerify: 12,
  confidence: 18,
} as const;

/** Extra steps granted when resuming a run that exhausted its step cap —
 *  paired with a "finish now" nudge, so a looping run converges instead of
 *  burning another full budget. */
export const RESUME_TOPUP_STEPS = 8;

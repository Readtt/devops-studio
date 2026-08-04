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
  /** Model rejects sampling params (`temperature`, `top_p`, `top_k`) outright:
   *  the API removed them, so sending one is a hard 400 — not a field the
   *  provider quietly ignores. Set it for frontier tiers even when a provider
   *  SDK already strips the param; see `supportsTemperature` for why we don't
   *  delegate that call. */
  rejectsSamplingParams?: boolean;
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
    rejectsSamplingParams: true,
  },
  {
    id: "claude-sonnet-5",
    provider: "anthropic",
    label: "Claude Sonnet 5",
    hint: "Balanced",
    description: "Frontier Sonnet with a 1M-token context window.",
    capabilities: { intelligence: 5, speed: 4, cost: 3 },
    tags: ["vision", "tools", "coding"],
    // Sonnet 5 is NOT a reasoning-tagged model, so before this flag existed the
    // runner sent it `temperature: 0` and every Anthropic surface 400'd with
    // "`temperature` is deprecated for this model" — and this is the default
    // model, so BYOK Anthropic users hit it on their first run.
    rejectsSamplingParams: true,
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
  //
  // Gateway routes ride @ai-sdk/openai-compatible, which forwards our request
  // body verbatim — none of the per-model sampling-param stripping the native
  // Anthropic/OpenAI SDKs do applies here. So every frontier route that drops
  // `temperature` upstream must say so itself.
  {
    id: "anthropic/claude-sonnet-5",
    provider: "openrouter",
    label: "Claude Sonnet 5",
    hint: "OpenRouter",
    description: "Frontier Sonnet via OpenRouter.",
    capabilities: { intelligence: 5, speed: 4, cost: 3 },
    tags: ["vision", "tools", "coding"],
    rejectsSamplingParams: true,
  },
  {
    id: "anthropic/claude-opus-5",
    provider: "openrouter",
    label: "Claude Opus 5",
    hint: "OpenRouter",
    description: "Anthropic flagship via OpenRouter.",
    capabilities: { intelligence: 5, speed: 2, cost: 1 },
    tags: ["vision", "reasoning", "tools", "coding"],
    rejectsSamplingParams: true,
  },
  {
    id: "openai/gpt-5.5",
    provider: "openrouter",
    label: "GPT-5.5",
    hint: "OpenRouter",
    description: "OpenAI flagship via OpenRouter.",
    capabilities: { intelligence: 5, speed: 3, cost: 1 },
    tags: ["vision", "reasoning", "tools", "coding"],
    rejectsSamplingParams: true,
  },
  {
    id: "openai/gpt-5.4-mini",
    provider: "openrouter",
    label: "GPT-5.4 mini",
    hint: "OpenRouter",
    description: "Snappy GPT via OpenRouter.",
    capabilities: { intelligence: 4, speed: 4, cost: 4 },
    tags: ["vision", "tools"],
    rejectsSamplingParams: true,
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

/** Whether it's safe to send `temperature` to a model.
 *
 *  Two families refuse it: reasoning models (above), and frontier tiers where
 *  the API REMOVED sampling params — Anthropic's Claude 5 answers
 *  "`temperature` is deprecated for this model" with a 400, OpenAI's GPT-5 tier
 *  accepts only the default. Those carry `rejectsSamplingParams`.
 *
 *  This decision deliberately lives in front of every provider rather than being
 *  delegated to the provider SDKs. Each SDK keeps its own per-model capability
 *  table and strips the param for models it recognizes, but that table ships a
 *  release behind every model launch — an @ai-sdk/anthropic that predated Claude
 *  5 classified it as an unknown model and forwarded `temperature` straight
 *  through, which is exactly how the default model came to 400 on every run. And
 *  gateway/local routes (OpenRouter, custom OpenAI-compatible endpoints, LM
 *  Studio) have no such table at all: they forward whatever we send.
 *
 *  Unknown ids (custom endpoint / local server) return true — they're
 *  overwhelmingly plain chat models that want a temperature, and the runner's
 *  one-shot retry covers the rare one that doesn't. */
export function supportsTemperature(id: ModelId | string): boolean {
  try {
    const m = getModel(id as ModelId);
    return !m.rejectsSamplingParams && !(m.tags?.includes("reasoning") ?? false);
  } catch {
    return true;
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

/** Per-model OUTPUT-token policy, decided here — not delegated to the provider
 *  SDKs. Same doctrine as `supportsTemperature`, one field over: with no
 *  explicit `maxOutputTokens`, @ai-sdk/anthropic fills in its own per-model
 *  table (3.0.104 resolves claude-opus-5 / claude-sonnet-5 to the full 128k
 *  ceiling, unknown non-Claude ids to 4096), which means the number changes
 *  whenever the SDK table does — silently, a release behind every model launch.
 *  Gateway/local transports have no table at all and forward whatever we send.
 *
 *  `cap` is what every request asks for. It has to clear the largest legitimate
 *  answer on ANY surface — a 10-case DraftBatch with steps and bugs is ~4k–15k
 *  text tokens — PLUS the adaptive-thinking phase Claude 5 runs by default,
 *  which bills against the SAME max_tokens budget (that's how a run ends
 *  `finish: length` with an empty answer: the thinking spent it first). 64k is
 *  Anthropic's own floor guidance for high-effort agentic work and halves what
 *  a runaway thinking spiral can burn in one step versus the 128k default the
 *  SDK was applying. Haiku doesn't think unless asked, so half that is still
 *  ~2x its largest legitimate answer.
 *
 *  `ceiling` is the model's hard max, held in reserve deliberately: it is the
 *  headroom a resume-after-truncation retries with (see resumePolicy), which
 *  only exists because `cap` sits below it.
 *
 *  Per-MODEL, not per-surface, on purpose. Answer sizes differ by surface, but
 *  the failure this bounds — a thinking/narration spiral — is a property of the
 *  model, and a per-surface cap tight enough to matter would create a NEW
 *  truncation failure on the multiplied path (bulk Confidence runs once per
 *  case). Per-surface COST is already governed by SURFACE_TOKEN_BUDGETS.
 *
 *  Absent entry ⇒ send nothing and let the endpoint decide — exactly today's
 *  behavior for OpenRouter's non-Anthropic routes, custom OpenAI-compatible
 *  endpoints, LM Studio, MLX and Ollama. Never invent a cap for a model we
 *  don't know. The OpenRouter Claude routes are listed because they are the
 *  same upstream models reached through a transport that forwards our body
 *  verbatim — the same reasoning that put `rejectsSamplingParams` on them. */
export const MODEL_OUTPUT_LIMITS: Record<
  string,
  { cap: number; ceiling: number }
> = {
  "claude-opus-5": { cap: 64_000, ceiling: 128_000 },
  "claude-sonnet-5": { cap: 64_000, ceiling: 128_000 },
  "claude-haiku-4-5": { cap: 32_000, ceiling: 64_000 },
  "anthropic/claude-opus-5": { cap: 64_000, ceiling: 128_000 },
  "anthropic/claude-sonnet-5": { cap: 64_000, ceiling: 128_000 },
};

/** The output cap every request for this model asks for, or undefined to send
 *  nothing and let the endpoint decide (unknown / local / custom models). */
export function getModelOutputCap(id: string): number | undefined {
  return MODEL_OUTPUT_LIMITS[id]?.cap;
}

/** The model's hard output ceiling, when we know it. Only consulted by the
 *  truncation-resume path — ordinary runs ask for `cap`. */
export function getModelOutputCeiling(id: string): number | undefined {
  return MODEL_OUTPUT_LIMITS[id]?.ceiling;
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

/** Per-surface ceilings on the agentic read loop (how many tool-calling steps
 *  the model may take before it's forced to produce its final answer).
 *
 *  These are RUNAWAY GUARDS, not the budget — {@link SURFACE_TOKEN_BUDGETS} is
 *  what a run is actually rationed by, and what the UI shows. A step ceiling
 *  still catches the two things a token budget can't see: a loop that spends
 *  almost nothing per step, and an endpoint that reports no usage at all. See
 *  runBudget.ts.
 *
 *  The two surfaces users actually hit the ceiling on — Generator and Commit
 *  Review's investigate pass — are raised accordingly, so a run of many cheap
 *  steps is no longer cut off short of its answer. The lean surfaces keep their
 *  ceilings: Suite Chat and verify are interactive/short by design, and
 *  confidence runs ONCE PER CASE in bulk suite scoring, where a higher ceiling
 *  multiplies by the case count into the app's largest cost path. */
export const SURFACE_STEP_CAPS = {
  generator: 40,
  suiteChat: 12,
  /** Review-pane "Ask a follow-up" chat (qaChatRun). Same tool set and shape as
   *  Suite Chat; it previously fell through to MAX_AGENT_STEPS with no entry
   *  here at all, so its budget was an accident rather than a decision. */
  draftChat: 12,
  // Commit Review runs two stages: a generous agentic investigation pass that
  // traces blast radius across the tree, then a lean skeptical verify pass.
  commitReviewInvestigate: 40,
  commitReviewVerify: 12,
  confidence: 18,
} as const;

/** Per-surface TOKEN budget for ONE agentic call — the primary control, summed
 *  across the call's steps (see runBudget.ts for spend-vs-occupancy).
 *
 *  Every step re-sends the whole conversation, so the spend of an N-step loop
 *  grows with N², not N: a 24-step run whose prompt climbs from 10k to 60k costs
 *  roughly 800k tokens in total, and the run that prompted this work — one that
 *  walked into a 1M-token window — cost several million. These numbers are set
 *  where a HEALTHY run of that surface never reaches them and a runaway does, so
 *  a budget stop means something is wrong rather than "this spec was large".
 *  Same posture as eviction: structurally inert on ordinary work.
 *
 *  Confidence is deliberately the tightest per call. It is invoked once per case
 *  (× up to 5 runs) in bulk suite scoring, so it is the only surface here whose
 *  ceiling multiplies by a list length — a 50-case suite pays this 250 times. */
export const SURFACE_TOKEN_BUDGETS = {
  generator: 2_500_000,
  suiteChat: 1_000_000,
  draftChat: 1_000_000,
  commitReviewInvestigate: 2_500_000,
  commitReviewVerify: 1_000_000,
  confidence: 600_000,
} as const;

/** Fallback budget for a tool-bearing call whose caller named no surface. Every
 *  live surface passes its own; this exists so a future one can't be born
 *  unbudgeted the way qaChatRun was born uncapped. */
export const DEFAULT_TOKEN_BUDGET = 1_000_000;

/** Tokens granted when resuming a run that exhausted its budget — paired with a
 *  "finish now" nudge, so a looping run converges instead of spending another
 *  full budget the same way.
 *
 *  Denominated in tokens rather than the 8 extra STEPS this replaces, and the
 *  swap tightens the grant rather than loosening it: a resume replays the whole
 *  transcript, so 8 more steps against a 150k-token transcript was licence to
 *  spend well over a million tokens re-reading it. This is ~3 such steps, and
 *  many more cheap ones — bounded in the unit that costs money instead of the
 *  one that doesn't. */
export const RESUME_TOPUP_TOKENS = 500_000;

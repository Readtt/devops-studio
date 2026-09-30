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
  /** Claude "preserved thinking": the API checks every replayed thinking block
   *  against the conversation prefix it was produced under, and rejects the
   *  request when that prefix changed. See `preservesThinking`. */
  preservesThinking?: boolean;

  // ── Set only on models discovered from a provider's live list ────────────
  // Curated entries keep these decisions in the side tables below, where the
  // release guard (config.test.ts) can check them.

  /** The id sent to the provider, when it differs from `id`. */
  apiId?: string;
  /** Came from the provider's live model list rather than this file. */
  discovered?: true;
  /** Epoch ms the provider says the model was created; orders newest first. */
  createdAt?: number;
  contextWindow?: number;
  outputLimits?: { cap: number; ceiling: number };
  pricing?: ModelPricing;
};

export const MODELS = [
  // ── OpenAI ────────────────────────────────────────────────────────────────
  //
  // The whole GPT-5 tier accepts only the default temperature, so every entry
  // here carries the flag — including the three that aren't `reasoning`-tagged.
  // Today @ai-sdk/openai happens to strip the param for us (it classes any id
  // starting `gpt-5` as a reasoning model), so the wire request is unchanged
  // either way; the flag is what stops that being load-bearing. Leaving it off
  // meant the same upstream model was flagged on its OpenRouter route and not
  // on its native one — one prefix rule in someone else's release away from the
  // 400 that flag exists to prevent.
  //
  // GPT-6 is where that stopped being hypothetical: @ai-sdk/openai before
  // 3.0.109 classed only `gpt-5*` and the o-series as reasoning models, so it
  // forwarded `temperature` to every gpt-6 id, and Astra and 6.1 Sol refuse it.
  {
    id: "gpt-6-astra",
    provider: "openai",
    label: "GPT-6 Astra",
    hint: "Flagship",
    description: "OpenAI's most capable model.",
    capabilities: { intelligence: 5, speed: 2, cost: 1 },
    tags: ["vision", "reasoning", "tools", "coding"],
    rejectsSamplingParams: true,
  },
  {
    id: "gpt-6.1-sol",
    provider: "openai",
    label: "GPT-6.1 Sol",
    hint: "Balanced",
    description: "Near-Astra quality at a fifth of the price.",
    capabilities: { intelligence: 5, speed: 4, cost: 3 },
    tags: ["vision", "reasoning", "tools", "coding"],
    rejectsSamplingParams: true,
  },
  {
    id: "gpt-6-luna",
    provider: "openai",
    label: "GPT-6 Luna",
    hint: "Fastest",
    description: "Cheapest GPT-6, for quick high-volume work.",
    capabilities: { intelligence: 4, speed: 5, cost: 5 },
    tags: ["vision", "reasoning", "tools"],
    rejectsSamplingParams: true,
  },
  {
    id: "gpt-5.5",
    provider: "openai",
    label: "GPT-5.5",
    hint: "Previous",
    description: "Previous flagship for reasoning and code.",
    capabilities: { intelligence: 5, speed: 3, cost: 1 },
    tags: ["vision", "reasoning", "tools", "coding"],
    rejectsSamplingParams: true,
  },
  {
    id: "gpt-5.4-mini",
    provider: "openai",
    label: "GPT-5.4 mini",
    hint: "Fast",
    description: "Snappy default at low cost.",
    capabilities: { intelligence: 4, speed: 4, cost: 4 },
    tags: ["vision", "tools"],
    rejectsSamplingParams: true,
  },
  {
    id: "gpt-5.4-nano",
    provider: "openai",
    label: "GPT-5.4 nano",
    hint: "Tiny",
    description: "Tiny and instant — great for autocomplete.",
    capabilities: { intelligence: 3, speed: 5, cost: 5 },
    tags: ["vision", "tools"],
    rejectsSamplingParams: true,
  },
  {
    id: "gpt-5.3-codex",
    provider: "openai",
    label: "GPT-5.3 Codex",
    hint: "Coding",
    description: "Tuned for code and tool use.",
    capabilities: { intelligence: 4, speed: 4, cost: 3 },
    tags: ["tools", "coding"],
    rejectsSamplingParams: true,
  },

  // ── Anthropic ─────────────────────────────────────────────────────────────
  //
  // The 5.1 / 5.5 generation also checks replayed thinking against the
  // conversation it came from (`preservesThinking`), which is the one request-
  // shape change over Claude 5 this app would otherwise trip.
  {
    id: "claude-fable-5-1",
    provider: "anthropic",
    label: "Claude Fable 5.1",
    hint: "Frontier",
    description: "Anthropic's most capable model, for the hardest work.",
    capabilities: { intelligence: 5, speed: 1, cost: 1 },
    tags: ["vision", "reasoning", "tools", "coding"],
    rejectsSamplingParams: true,
    preservesThinking: true,
  },
  {
    id: "claude-opus-5-5",
    provider: "anthropic",
    label: "Claude Opus 5.5",
    hint: "Best",
    description: "Anthropic's flagship for deep reasoning and agentic work.",
    capabilities: { intelligence: 5, speed: 2, cost: 2 },
    tags: ["vision", "reasoning", "tools", "coding"],
    rejectsSamplingParams: true,
    preservesThinking: true,
  },
  {
    id: "claude-sonnet-5-5",
    provider: "anthropic",
    label: "Claude Sonnet 5.5",
    hint: "Newest",
    description: "Newest Sonnet — near-Opus quality, 1M-token context.",
    capabilities: { intelligence: 5, speed: 4, cost: 3 },
    tags: ["vision", "tools", "coding"],
    rejectsSamplingParams: true,
    preservesThinking: true,
  },
  {
    id: "claude-opus-5",
    provider: "anthropic",
    label: "Claude Opus 5",
    hint: "Previous",
    description: "Previous Opus for deep reasoning and agentic work.",
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
  //
  // Every Gemini 3.x model takes no temperature from us. Google: "keep
  // temperature at its default value of 1.0 … setting it below 1.0 may lead to
  // … looping or degraded performance" — and we were sending 0 to 3 Flash,
  // which wasn't tagged as the thinking model it is. From 3.6 Flash on the
  // param is ignored, and Google says a future generation will 400 on it.
  {
    id: "gemini-3.1-pro-preview",
    provider: "google",
    label: "Gemini 3.1 Pro",
    hint: "Flagship",
    description: "Strong reasoning, 1M context.",
    capabilities: { intelligence: 5, speed: 3, cost: 2 },
    tags: ["vision", "reasoning", "tools", "coding"],
    rejectsSamplingParams: true,
  },
  {
    id: "gemini-3.8-flash",
    provider: "google",
    label: "Gemini 3.8 Flash",
    hint: "Fast",
    description: "Google's newest Flash — fast multimodal, 1M context.",
    capabilities: { intelligence: 4, speed: 5, cost: 4 },
    tags: ["vision", "reasoning", "tools", "coding"],
    rejectsSamplingParams: true,
  },
  {
    id: "gemini-3-flash-preview",
    provider: "google",
    label: "Gemini 3 Flash",
    hint: "Previous",
    description: "Earlier Flash preview, 1M context.",
    capabilities: { intelligence: 4, speed: 5, cost: 4 },
    tags: ["vision", "reasoning", "tools"],
    rejectsSamplingParams: true,
  },

  // ── xAI ───────────────────────────────────────────────────────────────────
  //
  // `grok-4-fast-reasoning` was retired 2026-05-15; xAI now silently serves
  // that slug with grok-4.3 at low effort, so it's gone rather than kept as a
  // label for a model the user wouldn't be getting.
  {
    id: "grok-4.7",
    provider: "xai",
    label: "Grok 4.7",
    hint: "Flagship",
    description: "xAI's most capable model, strong at code.",
    capabilities: { intelligence: 5, speed: 3, cost: 3 },
    tags: ["vision", "reasoning", "tools", "coding"],
  },
  {
    id: "grok-4.3",
    provider: "xai",
    label: "Grok 4.3",
    hint: "Fast",
    description: "Fast and cheap, strong at tool calls.",
    capabilities: { intelligence: 4, speed: 4, cost: 4 },
    tags: ["vision", "reasoning", "tools"],
  },
  {
    id: "grok-4.20-reasoning",
    provider: "xai",
    label: "Grok 4.20 Reasoning",
    hint: "Reasoning",
    description: "Frontier reasoning with extended thinking.",
    capabilities: { intelligence: 5, speed: 2, cost: 4 },
    tags: ["vision", "reasoning", "tools", "coding"],
  },
  {
    id: "grok-4.20-non-reasoning",
    provider: "xai",
    label: "Grok 4.20",
    hint: "Quick",
    description: "Grok 4.20 without reasoning, for chat and tools.",
    capabilities: { intelligence: 4, speed: 4, cost: 4 },
    tags: ["vision", "tools"],
  },

  // ── DeepSeek ──────────────────────────────────────────────────────────────
  //
  // DeepSeek retired `deepseek-reasoner` and `deepseek-chat` (2026-07-24) and
  // renamed V4 Flash to `deepseek-flash` (V4.1). Both current models think by
  // default, where temperature "has no effect".
  {
    id: "deepseek-flash",
    provider: "deepseek",
    label: "DeepSeek V4.1 Flash",
    hint: "Fast",
    description: "Newest DeepSeek — beats V4 Pro at a fraction of the price.",
    capabilities: { intelligence: 5, speed: 4, cost: 5 },
    tags: ["vision", "reasoning", "tools", "coding"],
  },
  {
    id: "deepseek-v4-pro",
    provider: "deepseek",
    label: "DeepSeek V4 Pro",
    hint: "Best",
    description: "Strong open-weight code model.",
    capabilities: { intelligence: 5, speed: 3, cost: 4 },
    tags: ["reasoning", "tools", "coding"],
  },

  // ── Mistral ────────────────────────────────────────────────────────────────
  //
  // Medium 3.5 replaced Medium 3.1, Magistral and Devstral 2 as the flagship;
  // Large 3 is the cheaper open-weight MoE.
  {
    id: "mistral-medium-latest",
    provider: "mistral",
    label: "Mistral Medium 3.5",
    hint: "Flagship",
    description: "Mistral's flagship — vision and reasoning, 256K context.",
    capabilities: { intelligence: 5, speed: 3, cost: 3 },
    tags: ["vision", "tools", "coding"],
  },
  {
    id: "mistral-large-latest",
    provider: "mistral",
    label: "Mistral Large 3",
    hint: "Open",
    description: "Open-weight Large 3 — cheap, 256K context.",
    capabilities: { intelligence: 4, speed: 4, cost: 4 },
    tags: ["vision", "tools", "coding"],
  },
  {
    id: "codestral-latest",
    provider: "mistral",
    label: "Codestral",
    hint: "Code",
    description: "Purpose-built coding model from Mistral.",
    capabilities: { intelligence: 4, speed: 4, cost: 5 },
    tags: ["coding"],
  },

  // ── Cerebras (autocomplete-tier) ──────────────────────────────────────────
  //
  // Cerebras deprecated llama-3.3-70b and qwen-3-32b; its shared inference now
  // serves just these two.
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
    id: "qwen-3.8-27b",
    provider: "cerebras",
    label: "Qwen 3.8 27B",
    hint: "Fast",
    description: "Qwen's latest small model, with vision.",
    capabilities: { intelligence: 4, speed: 5, cost: 3 },
    tags: ["vision", "tools", "coding"],
  },

  // ── Groq (autocomplete-tier) ──────────────────────────────────────────────
  //
  // Groq shut down deepseek-r1-distill-llama-70b (2025-10-02) and took
  // llama-3.3-70b-versatile off its free and developer tiers (2026-08-16).
  {
    id: "openai/gpt-oss-120b",
    provider: "groq",
    label: "GPT-OSS 120B",
    hint: "Fast",
    description: "OpenAI's open-weight flagship on Groq LPU.",
    capabilities: { intelligence: 4, speed: 5, cost: 5 },
    tags: ["tools", "coding"],
  },
  {
    id: "openai/gpt-oss-20b",
    provider: "groq",
    label: "GPT-OSS 20B",
    hint: "Ultra-fast",
    description: "Sub-second responses on Groq LPU.",
    capabilities: { intelligence: 3, speed: 5, cost: 5 },
    tags: ["tools", "coding"],
  },

  // ── OpenRouter (gateway — curated cross-provider routes) ──────────────────
  //
  // Gateway routes ride @ai-sdk/openai-compatible, which forwards our request
  // body verbatim — none of the per-model sampling-param stripping the native
  // Anthropic/OpenAI SDKs do applies here. So every frontier route that drops
  // `temperature` upstream must say so itself. (OpenRouter's own
  // `supported_parameters` can't be trusted for this: it lists `temperature`
  // for Claude Opus 5.5 because one of its hosts, Azure, accepts it.)
  //
  // OpenRouter ids spell versions with dots (`claude-opus-5.5`) where the
  // native APIs use hyphens (`claude-opus-5-5`).
  {
    id: "anthropic/claude-sonnet-5.5",
    provider: "openrouter",
    label: "Claude Sonnet 5.5",
    hint: "OpenRouter",
    description: "Newest Sonnet via OpenRouter.",
    capabilities: { intelligence: 5, speed: 4, cost: 3 },
    tags: ["vision", "tools", "coding"],
    rejectsSamplingParams: true,
    preservesThinking: true,
  },
  {
    id: "anthropic/claude-opus-5.5",
    provider: "openrouter",
    label: "Claude Opus 5.5",
    hint: "OpenRouter",
    description: "Anthropic flagship via OpenRouter.",
    capabilities: { intelligence: 5, speed: 2, cost: 2 },
    tags: ["vision", "reasoning", "tools", "coding"],
    rejectsSamplingParams: true,
    preservesThinking: true,
  },
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
    description: "Previous Anthropic flagship via OpenRouter.",
    capabilities: { intelligence: 5, speed: 2, cost: 1 },
    tags: ["vision", "reasoning", "tools", "coding"],
    rejectsSamplingParams: true,
  },
  {
    id: "openai/gpt-6.1-sol",
    provider: "openrouter",
    label: "GPT-6.1 Sol",
    hint: "OpenRouter",
    description: "OpenAI's balanced GPT-6 via OpenRouter.",
    capabilities: { intelligence: 5, speed: 4, cost: 3 },
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
    rejectsSamplingParams: true,
  },
  {
    id: "x-ai/grok-4.7",
    provider: "openrouter",
    label: "Grok 4.7",
    hint: "OpenRouter",
    description: "xAI flagship via OpenRouter.",
    capabilities: { intelligence: 5, speed: 3, cost: 3 },
    tags: ["vision", "reasoning", "tools", "coding"],
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
    id: "meta-llama/llama-4-scout",
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
    id: "qwen/qwen3-coder",
    provider: "openrouter",
    label: "Qwen 3 Coder",
    hint: "OpenRouter",
    description: "Qwen tuned for code.",
    capabilities: { intelligence: 4, speed: 4, cost: 5 },
    tags: ["tools", "coding"],
  },
  {
    id: "mistralai/mistral-large-2512",
    provider: "openrouter",
    label: "Mistral Large 3",
    hint: "OpenRouter",
    description: "EU-hosted general-purpose flagship.",
    capabilities: { intelligence: 4, speed: 4, cost: 4 },
    tags: ["vision", "tools", "coding"],
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

/** An id from the curated list above. */
export type CatalogModelId = (typeof MODELS)[number]["id"];

/** Any model the app can run: a curated id, or a discovered one
 *  (`<provider>:<apiId>`, see {@link discoveredModelId}). */
export type ModelId = string;

// ── Discovered models ───────────────────────────────────────────────────────
//
// New models reach the picker without a release: each connected provider's own
// `/models` endpoint is read with the user's key (modelDiscovery.ts) and every
// listing becomes a ModelInfo here. The request-shaping decisions for them
// live in `modelInfoFromListing`, below, for the same reason the curated ones
// live in this file: a provider SDK's model table ships a release behind every
// launch, and a model this app has never seen is by definition past it.

/** Providers whose `/models` endpoint says what the user's key can call. The
 *  local servers and the custom endpoint have their own model-id settings. */
export const DISCOVERABLE_PROVIDERS = [
  "anthropic",
  "openai",
  "google",
  "xai",
  "deepseek",
  "mistral",
  "groq",
  "cerebras",
  "openrouter",
] as const satisfies readonly ProviderId[];

export type DiscoverableProvider = (typeof DISCOVERABLE_PROVIDERS)[number];

export function isDiscoverableProvider(p: string): p is DiscoverableProvider {
  return (DISCOVERABLE_PROVIDERS as readonly string[]).includes(p);
}

/** One model as a provider's list describes it. Only the ids are guaranteed:
 *  OpenAI publishes nothing else, OpenRouter publishes nearly everything. */
export type ModelListing = {
  provider: DiscoverableProvider;
  apiId: string;
  label?: string;
  /** Other ids the provider answers to for this model (xAI, Mistral). */
  aliases?: string[];
  /** Epoch ms. */
  createdAt?: number;
  /** Epoch ms the provider stops serving it (OpenRouter). */
  expiresAt?: number;
  contextWindow?: number;
  maxOutputTokens?: number;
  vision?: boolean;
  /** Anthropic: whether the model takes `thinking: {type: "adaptive"}`. */
  adaptiveThinking?: boolean;
  pricing?: ModelPricing;
};

/** Registry id of a discovered model. Curated ids never contain `:`, so the
 *  two can't collide — and a saved discovered id still resolves (from the id
 *  alone) on a launch where the provider's list hasn't loaded yet. */
export function discoveredModelId(
  provider: DiscoverableProvider,
  apiId: string,
): ModelId {
  return `${provider}:${apiId}`;
}

export function parseDiscoveredModelId(
  id: string,
): { provider: DiscoverableProvider; apiId: string } | null {
  const i = id.indexOf(":");
  if (i <= 0) return null;
  const provider = id.slice(0, i);
  const apiId = id.slice(i + 1);
  if (!apiId.trim() || !isDiscoverableProvider(provider)) return null;
  return { provider, apiId };
}

const CURATED_BY_ID: ReadonlyMap<string, ModelInfo> = new Map(
  MODELS.map((m) => [m.id, m as ModelInfo]),
);
let discovered: ReadonlyMap<string, ModelInfo> = new Map();
const synthesized = new Map<string, ModelInfo>();

/** Replace this window's discovered models — called whenever the persisted
 *  model catalogue changes (settings/preferences.ts). */
export function setDiscoveredModels(models: readonly ModelInfo[]): void {
  discovered = new Map(models.map((m) => [m.id, m]));
}

export function listDiscoveredModels(): readonly ModelInfo[] {
  return [...discovered.values()];
}

/** The curated model a provider lists as `apiId` — under its own id or a
 *  dated snapshot of it — or undefined. Same provider only: Groq's and
 *  OpenRouter's `openai/gpt-oss-120b` are two different routes. */
function curatedListedAs(provider: ProviderId, apiId: string): ModelInfo | undefined {
  const m = CURATED_BY_ID.get(apiId) ?? CURATED_BY_ID.get(withoutDateStamp(apiId));
  return m && m.provider === provider ? m : undefined;
}

/** The id a model is filed under. A discovered id for a model that has since
 *  been curated — `openai:gpt-6-sol`, saved while it was only on OpenAI's
 *  list, once a release adds `gpt-6-sol` to MODELS — is that curated entry,
 *  with its vetted decisions and its place in the picker. Without this the
 *  saved pick would degrade to a copy built from the id alone the day its
 *  model got curated. */
export function canonicalModelId(id: ModelId): ModelId {
  if (CURATED_BY_ID.has(id)) return id;
  const parsed = parseDiscoveredModelId(id);
  return (parsed && curatedListedAs(parsed.provider, parsed.apiId)?.id) ?? id;
}

/** A model that isn't curated: its live listing when this window has one,
 *  else what the id alone implies. Undefined for curated and unknown ids. */
function uncatalogued(id: string): ModelInfo | undefined {
  if (CURATED_BY_ID.has(canonicalModelId(id))) return undefined;
  const live = discovered.get(id);
  if (live) return live;
  const parsed = parseDiscoveredModelId(id);
  if (!parsed) return undefined;
  let m = synthesized.get(id);
  if (!m) {
    m = modelInfoFromListing(parsed);
    synthesized.set(id, m);
  }
  return m;
}

export function getModel(id: ModelId): ModelInfo {
  const m = findModel(id);
  if (!m) throw new Error(`Unknown model: ${id}`);
  return m;
}

/** `getModel` for an id that may not resolve: undefined instead of a throw. */
export function findModel(id: ModelId | null | undefined): ModelInfo | undefined {
  if (!id) return undefined;
  return CURATED_BY_ID.get(canonicalModelId(id)) ?? uncatalogued(id);
}

/** The id a model is called by on the wire. */
export function apiModelId(id: ModelId): string {
  const m = getModel(id);
  return m.apiId ?? m.id;
}

/** Anthropic's own API, or an Anthropic model through OpenRouter. */
function isClaudeRoute(provider: ProviderId, apiId: string): boolean {
  return (
    provider === "anthropic" ||
    (provider === "openrouter" && apiId.startsWith("anthropic/"))
  );
}

/** `[major, minor]` of a Claude id — `claude-opus-5-5`, `claude-sonnet-5.5`,
 *  `claude-fable-5-1-20260901` — or null. The minor is one or two digits so a
 *  date stamp (`claude-opus-5-20260101`) never reads as a version. */
function claudeVersion(apiId: string): [number, number] | null {
  const m = /claude-(?:opus|sonnet|haiku|fable|mythos)-(\d+)(?:[.-](\d{1,2}))?(?=$|\D)/.exec(
    apiId,
  );
  return m ? [Number(m[1]), m[2] ? Number(m[2]) : 0] : null;
}

/** Output ceiling for a Claude id the listing gave no number for — only ever
 *  reached for an id synthesized before its provider's list loaded, since
 *  Anthropic's and OpenRouter's lists both carry one. Every Claude 5 model
 *  takes 128k; below that the safe floor is 32k (Opus 4.1's limit). */
function claudeFallbackCeiling(apiId: string): number {
  const v = claudeVersion(apiId);
  if (v && v[0] >= 5) return 128_000;
  return /haiku-4/.test(apiId) ? 64_000 : 32_000;
}

const ACRONYMS = new Set(["gpt", "oss", "glm", "qwq", "ai", "vl", "moe"]);

/** A readable name for an id nobody labelled (OpenAI, Groq and Cerebras list
 *  bare ids): `gpt-6.2-sol` → "GPT-6.2 Sol", `gpt-oss-120b` → "GPT-OSS 120B". */
export function prettifyModelId(apiId: string): string {
  const bare = apiId.includes("/") ? apiId.slice(apiId.lastIndexOf("/") + 1) : apiId;
  const words = bare
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => {
      const lower = w.toLowerCase();
      if (ACRONYMS.has(lower)) return lower.toUpperCase();
      if (/^\d+(\.\d+)?[a-z]$/.test(lower)) return lower.toUpperCase();
      if (/^v\d/.test(lower)) return lower.toUpperCase();
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    });
  return words
    .join(" ")
    .replace(/^GPT OSS\b/, "GPT-OSS")
    .replace(/^GPT (\d)/, "GPT-$1");
}

/** One word for the picker, from the id's own vocabulary. Heuristic by nature;
 *  "New" when the id says nothing, which for a model this build doesn't know
 *  is usually true. */
function inferHint(apiId: string): string {
  const id = apiId.toLowerCase();
  if (id.includes("non-reasoning")) return "Quick";
  const words = new Set(id.split(/[^a-z0-9.]+/));
  const has = (...ws: string[]) => ws.some((w) => words.has(w));
  if (has("nano", "lite", "luna", "haiku", "mini", "flash", "instant", "small")) {
    return "Fast";
  }
  if (has("codex", "coder", "codestral", "devstral", "code")) return "Coding";
  if (has("reasoning", "reasoner", "thinking", "r1")) return "Reasoning";
  if (has("opus", "pro", "max", "large", "ultra", "astra", "fable", "mythos")) {
    return "Flagship";
  }
  if (has("sonnet", "medium", "sol", "terra")) return "Balanced";
  return "New";
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    // Floor, so GPT-6's 1,050,000 reads "1M" rather than "1.1M".
    const m = Math.floor(n / 100_000) / 10;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  return `${Math.round(n / 1_000)}K`;
}

function describeListing(l: Partial<ModelListing>, providerLabel: string): string {
  const source =
    l.provider === "openrouter"
      ? "Via OpenRouter"
      : `From your ${providerLabel} account`;
  return l.contextWindow
    ? `${source} · ${formatTokens(l.contextWindow)} context`
    : source;
}

/** Every decision for a model this build has never seen. Deliberately
 *  conservative — each default below is the one that can't produce a 400:
 *
 *  - **No temperature, ever.** Every API accepts its absence; frontier tiers
 *    (Claude 4.7+, GPT-5+, Gemini 3) refuse or degrade on its presence, and a
 *    model new enough to be missing from this file is overwhelmingly frontier.
 *    Provider metadata can't overrule this: OpenRouter lists `temperature` for
 *    Claude Opus 5.5 because one of its hosts accepts it.
 *  - **An explicit output cap for Claude routes only**, from the listing's own
 *    ceiling: @ai-sdk/anthropic invents one for an id it doesn't know, and the
 *    upstream API demands one. Same shape as the curated caps — half the
 *    ceiling, at most 64k, so a truncation resume has headroom to raise into.
 *    Every other provider gets nothing sent, as before.
 *  - **Preserved thinking** for Claude past 5.0, the generation that checks it.
 *  - Context, vision and price only when the listing states them; otherwise the
 *    long-standing defaults (128k window, text-only, no cost shown).
 *  - Tool calling assumed: OpenRouter's list is filtered to routes that take
 *    tools, and every other provider's chat models do. */
export function modelInfoFromListing(
  l: Pick<ModelListing, "provider" | "apiId"> & Partial<ModelListing>,
): ModelInfo {
  const claude = isClaudeRoute(l.provider, l.apiId);
  const version = claude ? claudeVersion(l.apiId) : null;
  const ceiling = claude
    ? l.maxOutputTokens && l.maxOutputTokens > 0
      ? l.maxOutputTokens
      : claudeFallbackCeiling(l.apiId)
    : undefined;
  return {
    id: discoveredModelId(l.provider, l.apiId),
    apiId: l.apiId,
    provider: l.provider,
    label: l.label?.trim() || prettifyModelId(l.apiId),
    hint: inferHint(l.apiId),
    description: describeListing(l, getProvider(l.provider).label),
    capabilities: { intelligence: 3, speed: 3, cost: 3 },
    tags: l.vision ? ["vision", "tools"] : ["tools"],
    rejectsSamplingParams: true,
    // The version says which generation checks the prefix; Anthropic's own
    // list says whether this model takes the adaptive `thinking` config the
    // binding rides on, and a model that doesn't would 400 every request.
    preservesThinking:
      version !== null &&
      (version[0] > 5 || (version[0] === 5 && version[1] >= 1)) &&
      l.adaptiveThinking !== false,
    discovered: true,
    ...(l.createdAt ? { createdAt: l.createdAt } : {}),
    ...(l.contextWindow ? { contextWindow: l.contextWindow } : {}),
    ...(ceiling
      ? {
          outputLimits: {
            cap: Math.min(64_000, Math.floor(ceiling / 2)),
            ceiling,
          },
        }
      : {}),
    ...(l.pricing ? { pricing: l.pricing } : {}),
  };
}

/** `claude-haiku-4-5-20251001` → `claude-haiku-4-5`; `gpt-5.5-2026-04-23` →
 *  `gpt-5.5`. Only for matching a listing against the curated list. */
function withoutDateStamp(apiId: string): string {
  return apiId.replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, "");
}

/** One provider's slice of the persisted catalogue. */
export type ProviderCatalog = {
  /** When a refresh last ran, success or not — the staleness clock. */
  checkedAt: number;
  /** When the list last came back. Absent until the first success. */
  fetchedAt?: number;
  /** The last good list — kept through a failed refresh. */
  models: ModelListing[];
  /** Why the last refresh failed, when it did. */
  error?: string;
};

/** What every connected provider last said it serves, persisted (preference
 *  `modelCatalog`) so both windows share it and a launch doesn't wait on the
 *  network to show a model the user picked yesterday. */
export type ModelCatalog = Partial<Record<DiscoverableProvider, ProviderCatalog>>;

const asFinite = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

function normalizeListing(
  provider: DiscoverableProvider,
  raw: unknown,
): ModelListing | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.apiId !== "string" || !r.apiId.trim()) return null;
  const p = r.pricing as Record<string, unknown> | undefined;
  const input = asFinite(p?.input);
  const output = asFinite(p?.output);
  const cacheRead = asFinite(p?.cacheRead);
  const aliases = Array.isArray(r.aliases)
    ? r.aliases.filter((a): a is string => typeof a === "string" && !!a.trim())
    : [];
  return {
    provider,
    apiId: r.apiId,
    ...(typeof r.label === "string" ? { label: r.label } : {}),
    ...(aliases.length ? { aliases } : {}),
    ...(asFinite(r.createdAt) ? { createdAt: r.createdAt as number } : {}),
    ...(asFinite(r.expiresAt) ? { expiresAt: r.expiresAt as number } : {}),
    ...(asFinite(r.contextWindow) ? { contextWindow: r.contextWindow as number } : {}),
    ...(asFinite(r.maxOutputTokens)
      ? { maxOutputTokens: r.maxOutputTokens as number }
      : {}),
    ...(typeof r.vision === "boolean" ? { vision: r.vision } : {}),
    ...(typeof r.adaptiveThinking === "boolean"
      ? { adaptiveThinking: r.adaptiveThinking }
      : {}),
    ...(input !== undefined && output !== undefined
      ? { pricing: { input, output, ...(cacheRead !== undefined ? { cacheRead } : {}) } }
      : {}),
  };
}

/** The persisted catalogue, re-validated on load: a hand-edited or
 *  half-written settings file costs its bad entries, never the launch. */
export function normalizeModelCatalog(raw: unknown): ModelCatalog {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: ModelCatalog = {};
  for (const [provider, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!isDiscoverableProvider(provider)) continue;
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const checkedAt = asFinite(e.checkedAt);
    if (checkedAt === undefined) continue;
    const models = Array.isArray(e.models)
      ? e.models.flatMap((m) => normalizeListing(provider, m) ?? [])
      : [];
    out[provider] = {
      checkedAt,
      models,
      ...(asFinite(e.fetchedAt) ? { fetchedAt: e.fetchedAt as number } : {}),
      ...(typeof e.error === "string" ? { error: e.error } : {}),
    };
  }
  return out;
}

const discoveredByCatalog = new WeakMap<ModelCatalog, ModelInfo[]>();

/** The discovered models a catalogue offers, computed once per catalogue
 *  object — the picker asks on every render, and OpenRouter alone lists
 *  hundreds. Providers in `DISCOVERABLE_PROVIDERS` order. */
export function discoveredModelsForCatalog(catalog: ModelCatalog): ModelInfo[] {
  let models = discoveredByCatalog.get(catalog);
  if (!models) {
    models = discoveredModelsFrom(
      DISCOVERABLE_PROVIDERS.flatMap((p) => catalog[p]?.models ?? []),
    );
    discoveredByCatalog.set(catalog, models);
  }
  return models;
}

/** The discovered models worth offering: every listing, minus the ones that
 *  are a curated model under the same id, a dated snapshot of it, or an alias
 *  of it (curated wins — it carries vetted decisions; xAI lists Grok 4.20 as
 *  `grok-4.20-0309-reasoning` with the curated `grok-4.20-reasoning` as an
 *  alias), minus routes past their expiry date, minus repeats. */
export function discoveredModelsFrom(
  listings: readonly ModelListing[],
  now: number = Date.now(),
): ModelInfo[] {
  const seen = new Set<string>();
  const out: ModelInfo[] = [];
  for (const l of listings) {
    const key = `${l.provider}:${l.apiId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (l.expiresAt !== undefined && l.expiresAt <= now) continue;
    if ([l.apiId, ...(l.aliases ?? [])].some((id) => curatedListedAs(l.provider, id))) {
      continue;
    }
    out.push(modelInfoFromListing(l));
  }
  return out;
}

/** Curated ids removed because the provider shut the model down, mapped to the
 *  same provider's successor. A saved default pointing at one moves to its
 *  successor rather than to DEFAULT_MODEL_ID — which is an Anthropic model, and
 *  a Groq-only or DeepSeek-only user has no key for it. */
export const RETIRED_MODEL_REPLACEMENTS: Readonly<Record<string, string>> = {
  "grok-4-fast-reasoning": "grok-4.3",
  "deepseek-v4-flash": "deepseek-flash",
  "deepseek-reasoner": "deepseek-v4-pro",
  "llama3.3-70b": "gpt-oss-120b",
  "qwen-3-32b": "qwen-3.8-27b",
  "llama-3.3-70b-versatile": "openai/gpt-oss-120b",
  "deepseek-r1-distill-llama-70b": "openai/gpt-oss-120b",
  "x-ai/grok-4.20-reasoning": "x-ai/grok-4.7",
  "deepseek/deepseek-reasoner": "deepseek/deepseek-v4-pro",
  "meta-llama/llama-4-scout-17b-16e-instruct": "meta-llama/llama-4-scout",
  "qwen/qwen3-max": "qwen/qwen3-coder",
  "mistralai/mistral-large-latest": "mistralai/mistral-large-2512",
};

/** A persisted id, carried past a retirement when the model has a successor,
 *  and onto the curated entry when a discovered model has since been curated. */
export function migrateModelId(id: string): string {
  return canonicalModelId(RETIRED_MODEL_REPLACEMENTS[id] ?? id);
}

/** A persisted model id made safe for state that renders: migrated, or null
 *  when nothing resolves it. Every restore of a saved id goes through here —
 *  `getModel` throws on an unknown id, the pickers and panes call it during
 *  render, and a throw there takes the whole window down on every launch that
 *  rehydrates the tab. */
export function restoreModelId(id: string | null | undefined): ModelId | null {
  if (!id) return null;
  const current = migrateModelId(id);
  return isKnownModelId(current) ? current : null;
}

/** Whether `id` names a model `getModel` can resolve: a curated one, or a
 *  well-formed discovered one. Used to sanitize persisted selections
 *  (default/favorites/recents, checkpoints, chat threads) after a model is
 *  retired — a stale id would otherwise crash `getModel` at the picker/runner.
 *
 *  A discovered id is accepted on its shape alone, not on being in this
 *  window's list: a saved default mustn't reset on a launch where the provider
 *  hasn't answered yet (or is down). If the model is really gone, the provider
 *  says so on the first run — the same answer a retired curated model gave. */
export function isKnownModelId(id: string): id is ModelId {
  return (
    CURATED_BY_ID.has(id) ||
    discovered.has(id) ||
    parseDiscoveredModelId(id) !== null
  );
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

/** Whether requests to this model must tolerate edited history — Claude's
 *  "preserved thinking" (Opus 5.5, Sonnet 5.5, Fable 5.1).
 *
 *  Those models bind every thinking block to the exact conversation prefix it
 *  was produced under, and a replayed block whose prefix changed is a 400 —
 *  enforced by default for Anthropic accounts created on or after 2026-08-31,
 *  so it is the NEW users who hit it first. This app edits history mid-run on
 *  purpose: tool-result eviction rewrites old results in place, an installed
 *  summary replaces older turns, and a resume replays a transcript banked
 *  without its request-only nudge. Each of those would invalidate every later
 *  thinking block.
 *
 *  So the runner asks the API to DROP invalidated blocks instead of failing
 *  the request (`prefix_mismatch_behavior: "drop_block"`). What that costs,
 *  stated plainly: the API drops the first mismatched block AND every thinking
 *  block after it, on every later request that carries the edited history —
 *  after an eviction the model continues without its earlier reasoning — and
 *  setting the field also turns the check on for accounts created before
 *  2026-08-31, which would otherwise have been sent the stale blocks. Dropped
 *  blocks are unbilled. The alternative is a run that dies on its first step
 *  after an eviction, for every new account. Only the native Anthropic
 *  transport replays signed thinking blocks, so only it acts on this. */
export function preservesThinking(id: ModelId | string): boolean {
  try {
    return getModel(id as ModelId).preservesThinking === true;
  } catch {
    return false;
  }
}

export const DEFAULT_MODEL_ID: CatalogModelId = "claude-sonnet-5";

/** Approximate context window (in tokens) per model. Used for the
 *  context-usage indicator in the AI mini-window header. Conservative
 *  estimates — actual provider limits may shift. */
export const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  "gpt-6-astra": 1_050_000,
  "gpt-6.1-sol": 1_050_000,
  "gpt-6-luna": 1_050_000,
  "gpt-5.5": 1_050_000,
  "gpt-5.4-mini": 400_000,
  "gpt-5.4-nano": 400_000,
  "gpt-5.3-codex": 400_000,
  "claude-fable-5-1": 1_000_000,
  "claude-opus-5-5": 1_000_000,
  "claude-sonnet-5-5": 1_000_000,
  "claude-opus-5": 1_000_000,
  "claude-sonnet-5": 1_000_000,
  "claude-haiku-4-5": 200_000,
  "gemini-3.1-pro-preview": 1_000_000,
  "gemini-3.8-flash": 1_000_000,
  "gemini-3-flash-preview": 1_000_000,
  "grok-4.7": 500_000,
  "grok-4.3": 1_000_000,
  "grok-4.20-reasoning": 1_000_000,
  "grok-4.20-non-reasoning": 1_000_000,
  "deepseek-flash": 1_000_000,
  "deepseek-v4-pro": 1_000_000,
  "gpt-oss-120b": 128_000,
  // The free tier's window; paid keys get 128k, but a free-tier run that
  // trusts 128k overflows at 64k.
  "qwen-3.8-27b": 65_536,
  "openai/gpt-oss-120b": 128_000,
  "openai/gpt-oss-20b": 128_000,
  "anthropic/claude-sonnet-5.5": 1_000_000,
  "anthropic/claude-opus-5.5": 1_000_000,
  "anthropic/claude-opus-5": 1_000_000,
  "anthropic/claude-sonnet-5": 1_000_000,
  "openai/gpt-6.1-sol": 1_050_000,
  "openai/gpt-5.5": 1_050_000,
  "openai/gpt-5.4-mini": 400_000,
  "google/gemini-3.1-pro-preview": 1_000_000,
  "x-ai/grok-4.7": 500_000,
  "deepseek/deepseek-v4-pro": 1_000_000,
  "meta-llama/llama-4-scout": 1_000_000,
  "meta-llama/llama-4-maverick": 1_000_000,
  "moonshotai/kimi-k2.5": 256_000,
  "qwen/qwen3-coder": 256_000,
  "mistralai/mistral-large-2512": 256_000,
  "z-ai/glm-4.6": 200_000,
  "openai-compatible-custom": 128_000,
  "lmstudio-local": 32_000,
  "mlx-local": 32_000,
  "ollama-local": 32_000,
  "mistral-medium-latest": 256_000,
  "mistral-large-latest": 256_000,
  // Mistral's docs page says 128k where its API card said 256k; the smaller
  // one can't overflow.
  "codestral-latest": 128_000,
};

export function getModelContextLimit(
  modelId: string | undefined,
  compatOverride?: number,
): number {
  if (!modelId) return 128_000;
  if (modelId === "openai-compatible-custom" && compatOverride)
    return compatOverride;
  return (
    MODEL_CONTEXT_LIMITS[canonicalModelId(modelId)] ??
    uncatalogued(modelId)?.contextWindow ??
    128_000
  );
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
  "claude-fable-5-1": { cap: 64_000, ceiling: 128_000 },
  "claude-opus-5-5": { cap: 64_000, ceiling: 128_000 },
  "claude-sonnet-5-5": { cap: 64_000, ceiling: 128_000 },
  "claude-opus-5": { cap: 64_000, ceiling: 128_000 },
  "claude-sonnet-5": { cap: 64_000, ceiling: 128_000 },
  "claude-haiku-4-5": { cap: 32_000, ceiling: 64_000 },
  "anthropic/claude-sonnet-5.5": { cap: 64_000, ceiling: 128_000 },
  "anthropic/claude-opus-5.5": { cap: 64_000, ceiling: 128_000 },
  "anthropic/claude-opus-5": { cap: 64_000, ceiling: 128_000 },
  "anthropic/claude-sonnet-5": { cap: 64_000, ceiling: 128_000 },
};

/** The output cap every request for this model asks for, or undefined to send
 *  nothing and let the endpoint decide (unknown / local / custom models). */
export function getModelOutputCap(id: string): number | undefined {
  return (
    MODEL_OUTPUT_LIMITS[canonicalModelId(id)]?.cap ??
    uncatalogued(id)?.outputLimits?.cap
  );
}

/** The model's hard output ceiling, when we know it. Only consulted by the
 *  truncation-resume path — ordinary runs ask for `cap`. */
export function getModelOutputCeiling(id: string): number | undefined {
  return (
    MODEL_OUTPUT_LIMITS[canonicalModelId(id)]?.ceiling ??
    uncatalogued(id)?.outputLimits?.ceiling
  );
}

export type ModelPricing = {
  input: number;
  output: number;
  cacheRead?: number;
};

/** $ per 1M tokens, from each provider's pricing page (2026-09-29). Where a
 *  provider charges more past a prompt-length threshold, this is the price
 *  below it. */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  "gpt-6-astra": { input: 10, output: 50, cacheRead: 1 },
  "gpt-6.1-sol": { input: 2, output: 10, cacheRead: 0.1 },
  "gpt-6-luna": { input: 0.1, output: 0.5, cacheRead: 0.01 },
  "gpt-5.5": { input: 5, output: 30, cacheRead: 0.5 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5, cacheRead: 0.075 },
  "gpt-5.4-nano": { input: 0.2, output: 1.25, cacheRead: 0.02 },
  "gpt-5.3-codex": { input: 1.75, output: 14, cacheRead: 0.175 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1 },
  "gemini-3.1-pro-preview": { input: 2, output: 12, cacheRead: 0.2 },
  // Introductory until 2026-12-31, then double.
  "gemini-3.8-flash": { input: 0.75, output: 3.75, cacheRead: 0.075 },
  "gemini-3-flash-preview": { input: 0.5, output: 3, cacheRead: 0.05 },
  "grok-4.7": { input: 2, output: 6, cacheRead: 0.5 },
  "grok-4.3": { input: 1.25, output: 2.5, cacheRead: 0.2 },
  "grok-4.20-reasoning": { input: 1.25, output: 2.5, cacheRead: 0.2 },
  "grok-4.20-non-reasoning": { input: 1.25, output: 2.5, cacheRead: 0.2 },
  // Off-peak; DeepSeek doubles these 01:00–04:00 and 06:00–10:00 UTC on
  // weekdays.
  "deepseek-flash": { input: 0.15, output: 0.6, cacheRead: 0.003 },
  "deepseek-v4-pro": { input: 0.66, output: 1.98, cacheRead: 0.022 },
  "mistral-medium-latest": { input: 1.5, output: 7.5, cacheRead: 0.15 },
  "mistral-large-latest": { input: 0.5, output: 1.5, cacheRead: 0.05 },
  "codestral-latest": { input: 0.3, output: 0.9, cacheRead: 0.03 },
};

export function estimateCost(
  modelId: string | undefined,
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number },
): number | null {
  if (!modelId) return null;
  const p =
    MODEL_PRICING[canonicalModelId(modelId)] ?? uncatalogued(modelId)?.pricing;
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

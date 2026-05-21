// AI engine selector + types.
//
// The Claude Agent SDK proper is Node-only and can't run in the Tauri
// webview, so the "claude-agent-sdk" engine here is actually driven by the
// installed `claude` CLI via the Rust commands in `src/modules/claude.rs`.
// The CLI exposes the same agent loop, model set, and authentication paths
// (Pro/Max OAuth via `claude setup-token`, or `ANTHROPIC_API_KEY`).

import type { ModelId } from "@/modules/ai/config";
import { getModel } from "@/modules/ai/config";
import { usePreferencesStore } from "@/modules/settings/preferences";

export type AiEngine = "vercel-ai-sdk" | "claude-agent-sdk";
export type ClaudeAuthMode = "max-oauth" | "api-key";

export type EngineSelection = {
  engine: AiEngine;
  /** True when the SDK path will actually be used at runtime. False during
   *  the Phase 5A scaffolding window (no SDK plumbing yet). */
  active: boolean;
  /** Set when `engine === "claude-agent-sdk"` so the engine knows how to
   *  authenticate. */
  authMode?: ClaudeAuthMode;
};

/** Whether the Rust claude_* subprocess driver is wired up. Set to false
 *  to force the Vercel AI SDK fallback without touching user prefs. */
const CLAUDE_AGENT_SDK_AVAILABLE = true;

/**
 * Pick the engine to use for a given model.
 *
 * Rules:
 *   - If the user explicitly picked the Claude Code engine in Settings, use
 *     it — the engine is the contract, not the model. Whether the active
 *     model id maps to an Anthropic model just decides which CLI `--model`
 *     flag we pass (callers substitute a sensible Anthropic default when the
 *     selection isn't anthropic — see `resolveClaudeModelId` below).
 *   - Otherwise use the Vercel AI SDK.
 *
 * The previous version of this function silently fell back to the Vercel
 * path when the selected model wasn't anthropic — which meant a user who
 * had Claude connected but had a default OpenAI model selected got the
 * misleading "No API key configured for openai" error. Engine choice and
 * model choice are independent now.
 */
export function selectEngine(modelId: ModelId | string): EngineSelection {
  const prefs = usePreferencesStore.getState();
  const preferred = prefs.aiEngine ?? "vercel-ai-sdk";
  const authMode = prefs.claudeAuthMode ?? "api-key";

  if (preferred === "claude-agent-sdk" && CLAUDE_AGENT_SDK_AVAILABLE) {
    return { engine: "claude-agent-sdk", active: true, authMode };
  }

  // User picked Claude Code but the runtime path is intentionally disabled
  // (e.g. during scaffolding) — return the choice as-is and let the caller
  // decide whether to fall back or surface a "not ready" hint.
  if (preferred === "claude-agent-sdk") {
    return { engine: "claude-agent-sdk", active: false, authMode };
  }

  // Keep modelId around for callers that want to log the resolved selection.
  void modelId;

  return { engine: "vercel-ai-sdk", active: true };
}

/** Default Anthropic model the Claude CLI should drive when the user's
 *  globally-selected model isn't an anthropic one. We pick Sonnet 4.6 as a
 *  balance of cost / quality / speed — the Generator's prompt isn't long
 *  enough to need Opus and we don't want bills sneaking up on free-tier
 *  users who never explicitly opted into the flagship. */
const DEFAULT_CLAUDE_MODEL = "claude-sonnet-4-6";

/** Resolve the model id we should pass to the Claude CLI. If the user has
 *  an Anthropic model selected we honor it; otherwise we fall back to a
 *  safe default so the CLI doesn't choke on a `gpt-…` id it can't run. */
export function resolveClaudeModelId(modelId: ModelId | string): string {
  return safeProvider(modelId) === "anthropic"
    ? modelId
    : DEFAULT_CLAUDE_MODEL;
}

function safeProvider(modelId: string): string | null {
  try {
    return getModel(modelId as ModelId).provider;
  } catch {
    return null;
  }
}

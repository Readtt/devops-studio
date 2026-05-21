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
 *   - If the user explicitly picked the Vercel AI engine in Settings, use it.
 *   - If they picked Claude Code AND the model is an Anthropic one AND the
 *     SDK path is wired up — use it.
 *   - Otherwise fall back to Vercel AI SDK.
 */
export function selectEngine(modelId: ModelId | string): EngineSelection {
  const prefs = usePreferencesStore.getState();
  const preferred = prefs.aiEngine ?? "vercel-ai-sdk";
  const authMode = prefs.claudeAuthMode ?? "api-key";

  const provider = safeProvider(modelId);
  const isAnthropic = provider === "anthropic";

  if (preferred === "claude-agent-sdk" && isAnthropic && CLAUDE_AGENT_SDK_AVAILABLE) {
    return { engine: "claude-agent-sdk", active: true, authMode };
  }

  // User picked Claude Code but its runtime path isn't ready yet — return
  // the choice as-is but flag `active: false` so the UI can show a "scaffolding"
  // hint and the Generator silently falls back to the Vercel path.
  if (preferred === "claude-agent-sdk") {
    return { engine: "claude-agent-sdk", active: false, authMode };
  }

  return { engine: "vercel-ai-sdk", active: true };
}

function safeProvider(modelId: string): string | null {
  try {
    return getModel(modelId as ModelId).provider;
  } catch {
    return null;
  }
}

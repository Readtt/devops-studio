// Thin TS wrapper around the Rust `claude_*` commands. Mirrors the SDK
// surface we actually need: probe + one-shot query.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type ClaudeProbe = {
  path: string;
  version: string;
};

export type ClaudeError =
  | { kind: "not-installed" }
  | { kind: "non-zero-exit"; code: number | null; stderrExcerpt: string }
  | { kind: "spawn-failed"; message: string }
  | { kind: "cancelled" };

export type ClaudeQueryInput = {
  /** Stable id (e.g. UUID) the caller chooses. Used for the event channel
   *  and to look the run up later for cancellation. */
  runId: string;
  prompt: string;
  systemPrompt?: string;
  cwd?: string;
  model?: string;
  maxTurns?: number;
  /** "default" | "bypassPermissions" | "plan" — see the CLI's --permission-mode. */
  permissionMode?: "default" | "bypassPermissions" | "plan";
  /** Extra env vars merged into the child. Typical use: ANTHROPIC_API_KEY. */
  env?: Record<string, string>;
};

export type ClaudeQueryResult = {
  text: string;
  exitCode: number | null;
};

/** Per-line stream-json event from the CLI. Shape varies by `type` — we keep
 *  it loose so the renderer can do progressive rendering without us having
 *  to bake in a full event schema (Anthropic changes it occasionally). */
export type ClaudeEvent = Record<string, unknown> & {
  type?: string;
};

export async function probeClaude(): Promise<ClaudeProbe | null> {
  try {
    return await invoke<ClaudeProbe>("claude_probe");
  } catch (e) {
    if (isNotInstalled(e)) return null;
    // Any other failure (permissions, bad version output) — re-throw so the
    // UI can show why detection failed instead of silently saying "not
    // installed".
    throw e;
  }
}

export type ClaudeSetupTokenLine = {
  stream: "stdout" | "stderr";
  line: string;
};

/** Run `claude setup-token` and stream every output line through `onLine` as
 *  it arrives. Resolves with the full stdout when the CLI exits, or rejects
 *  with a ClaudeError. The listener is detached on settle. */
export async function setupClaudeToken(
  onLine?: (line: ClaudeSetupTokenLine) => void,
): Promise<string> {
  let unlisten: UnlistenFn | null = null;
  if (onLine) {
    unlisten = await listen<ClaudeSetupTokenLine>(
      "claude:setup-token:line",
      (e) => onLine(e.payload),
    );
  }
  try {
    return await invoke<string>("claude_setup_token");
  } finally {
    if (unlisten) unlisten();
  }
}

/** Extract the first `https://...` URL from a line of CLI output, if any.
 *  Useful for promoting the device-code URL into a clickable link. */
export function extractAuthUrl(line: string): string | null {
  const match = line.match(/https:\/\/[^\s'"<>)]+/);
  return match ? match[0] : null;
}

/** Run a one-shot query. If `onEvent` is provided, every NDJSON event the
 *  CLI emits is forwarded to it; the listener is detached on settle. */
export async function runClaudeQuery(
  input: ClaudeQueryInput,
  onEvent?: (event: ClaudeEvent) => void,
): Promise<ClaudeQueryResult> {
  let unlisten: UnlistenFn | null = null;
  if (onEvent) {
    unlisten = await listen<ClaudeEvent>(`claude:event:${input.runId}`, (e) =>
      onEvent(e.payload),
    );
  }
  try {
    return await invoke<ClaudeQueryResult>("claude_run_query", { input });
  } finally {
    if (unlisten) unlisten();
  }
}

export function isNotInstalled(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "kind" in (err as Record<string, unknown>) &&
    (err as { kind: unknown }).kind === "not-installed"
  );
}

export function claudeErrorMessage(err: unknown): string {
  if (!err) return "";
  if (typeof err !== "object" || !("kind" in (err as Record<string, unknown>))) {
    return String(err);
  }
  const e = err as ClaudeError;
  switch (e.kind) {
    case "not-installed":
      return "Claude Code CLI not found on PATH. Install it from claude.ai/code, then click Detect again.";
    case "non-zero-exit":
      return `Claude exited with code ${e.code ?? "?"}: ${e.stderrExcerpt.trim().split("\n").pop() ?? ""}`;
    case "spawn-failed":
      return `Could not spawn claude: ${e.message}`;
    case "cancelled":
      return "Run cancelled.";
  }
}

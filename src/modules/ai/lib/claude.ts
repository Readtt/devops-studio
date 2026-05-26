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
  | { kind: "cancelled" }
  | { kind: "non-zero-exit"; code: number | null; stderrExcerpt: string }
  | { kind: "api-error"; message: string; httpStatus: number | null }
  | { kind: "spawn-failed"; message: string };

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
  /** Restrict the CLI to a fixed set of built-in tools. Maps to the CLI's
   *  `--tools` flag (which actually constrains the available tool surface),
   *  not `--allowedTools` (which only pre-approves permission prompts and is
   *  bypassed by `permissionMode: "bypassPermissions"`). The Rust backend
   *  refuses to spawn if any tool here isn't in its read-only set. */
  allowedTools?: string[];
  /** Run in `--bare` mode — skip hooks, plugin sync, LSP, auto memory, and
   *  CLAUDE.md auto-discovery. Anthropic's headless docs recommend this for
   *  scripted/SDK callers; otherwise a failing SessionStart hook in the
   *  user's `~/.claude` aborts the run with a silent non-zero exit. Requires
   *  API-key auth — OAuth/keychain reads are skipped in bare mode. */
  bare?: boolean;
  /** Extra env vars merged into the child. Typical use: ANTHROPIC_API_KEY. */
  env?: Record<string, string>;
  /** Image attachments sent as real vision input. When present the CLI is
   *  driven with `--input-format stream-json` and the prompt is framed as a
   *  user message with base64 image blocks. `dataBase64` is the raw payload
   *  (no `data:` URL prefix). */
  images?: { mediaType: string; dataBase64: string }[];
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

/** Break out of a stuck `claude setup-token` flow — sends SIGTERM/taskkill
 *  to the child if it's still running. Used by the "I've authorized" recheck
 *  affordance when the CLI didn't exit on its own after the browser flow. */
export async function cancelSetupClaudeToken(): Promise<void> {
  return invoke<void>("claude_cancel_setup_token");
}

/** Cancel an in-flight `runClaudeQuery` by its runId. The Rust side notifies
 *  the run task, which kills the child and returns ClaudeError.kind ===
 *  "cancelled". Safe to call even if the run already finished — no-op. */
export async function cancelClaudeRun(runId: string): Promise<void> {
  return invoke<void>("claude_cancel_run", { runId });
}

export function isCancelledError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "kind" in (err as Record<string, unknown>) &&
    (err as { kind: unknown }).kind === "cancelled"
  );
}

export type AuthStatus = {
  authenticated: boolean;
  /** Raw stdout/stderr from `claude auth status`, surfaced for diagnostics. */
  raw: string;
};

/** Run `claude auth status` to verify whether the CLI has stored credentials.
 *  Use this — not probeClaude — to decide if the user is connected. probe
 *  just checks that the binary exists. */
export async function checkClaudeAuth(): Promise<AuthStatus> {
  return invoke<AuthStatus>("claude_check_auth");
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
    case "non-zero-exit": {
      const code = e.code ?? "?";
      const detail = summarizeStderr(e.stderrExcerpt);
      // Auth-related stderr — surface a targeted hint, since "not logged
      // in" usually means bare-mode-on + OAuth (incompatible) rather than
      // an actual auth problem the user needs to fix.
      const lower = detail.toLowerCase();
      if (
        lower.includes("not logged in") ||
        lower.includes("not authenticated") ||
        lower.includes("invalid api key") ||
        lower.includes("no api key")
      ) {
        return `Claude isn't picking up your credentials: ${detail}. If you're on Max OAuth, open Settings → Models and either switch to "Anthropic API key" or turn off "Run Claude in isolation" — isolation skips the CLI's keychain read, which Max OAuth depends on.`;
      }
      if (detail) return `Claude exited with code ${code}: ${detail}`;
      // Empty stderr is the classic "something pre-flight crashed" signal:
      // a SessionStart hook, an MCP server, or the CLI itself dying before
      // it could write a diagnostic. The activity log usually has a
      // hook:<name> red row when a hook is the culprit.
      return `Claude exited with code ${code} with no stderr. Most common causes: (1) a failing SessionStart hook in ~/.claude — enable "Run Claude in isolation" in Settings → Models to bypass it (API-key auth only). (2) An MCP server or plugin crashing during startup. Check the activity log above for hook:<name> entries to find the culprit.`;
    }
    case "api-error": {
      const status = e.httpStatus != null ? ` (HTTP ${e.httpStatus})` : "";
      return `Claude API error${status}: ${e.message}`;
    }
    case "spawn-failed":
      return `Could not spawn claude: ${e.message}`;
    case "cancelled":
      return "Run cancelled.";
  }
}

/** Distill the CLI's stderr into a single human-readable sentence. The old
 *  formatter grabbed only the last non-empty line, which lost the actual
 *  error message when the CLI followed it with a blank line or an ANSI reset.
 *  We strip ANSI escapes, drop empty / whitespace-only lines, and keep the
 *  first meaningful line — that's almost always the "Error: …" the user
 *  needs to see. If the buffer is still useful past that, we append the next
 *  line for context. */
function summarizeStderr(raw: string): string {
  if (!raw) return "";
  // Strip CSI ANSI escapes (\x1b[…m and similar) that some CLI builds emit on
  // Windows even when stdout isn't a TTY. Falls back to original on a regex
  // engine that doesn't accept the control-char class.
  const stripped = raw
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "");
  const lines = stripped
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return "";
  const first = lines[0];
  const second = lines[1];
  const joined = second ? `${first} — ${second}` : first;
  return joined.length > 280 ? `${joined.slice(0, 280)}…` : joined;
}

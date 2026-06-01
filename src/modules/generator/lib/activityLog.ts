// Structured per-step activity emitted by the analyst run engines. The UI
// renders this as a streaming log so the user can see what the agent is
// actually doing (which files it read, what it searched for, what the model
// thought) instead of staring at a single "tool: X" label that flickers.

export type ActivityKind = "thinking" | "tool" | "output" | "error";

export type ActivityEntry = {
  /** Stable id for React keys and pairing tool_use → tool_result events. */
  id: string;
  /** Milliseconds since the run started (UI renders as +1.2s). */
  ts: number;
  kind: ActivityKind;
  /** Canonical tool name from the engine (e.g. "Read", "Grep"). */
  toolName?: string;
  /** One-line description of what the tool was invoked with. */
  inputSummary?: string;
  /** Short excerpt of the tool result, truncated for display. */
  outputSummary?: string;
  /** Full result text — populated when the entry has a long output the user
   *  can expand. We cap this at ~4KB so the log can't balloon on huge reads. */
  outputFull?: string;
  /** Wall-clock duration of the tool call, if known. */
  durationMs?: number;
  /** Error string when kind === "error". */
  error?: string;
};

const OUTPUT_SUMMARY_MAX = 200;
const OUTPUT_FULL_MAX = 4_096;

let counter = 0;

export function newActivityId(): string {
  counter++;
  return `act-${Date.now().toString(36)}-${counter.toString(36)}`;
}

/** Trim long strings for inline display; preserve enough to be useful but
 *  prevent a single tool call from filling the screen. */
export function clampOutputSummary(s: string): string {
  if (s.length <= OUTPUT_SUMMARY_MAX) return s;
  return s.slice(0, OUTPUT_SUMMARY_MAX - 1) + "…";
}

export function clampOutputFull(s: string): string {
  if (s.length <= OUTPUT_FULL_MAX) return s;
  return s.slice(0, OUTPUT_FULL_MAX - 1) + "…";
}

/** Best-effort human label for a tool call given its raw input object.
 *  Different tool names use different field shapes; we cover the common ones
 *  and fall back to the tool name alone so the log still says something. */
export function summarizeToolInput(
  toolName: string,
  input: Record<string, unknown> | undefined,
): string {
  if (!input) return toolName;
  const get = (k: string): string | undefined => {
    const v = input[k];
    return typeof v === "string" ? v : undefined;
  };
  const name = toolName.toLowerCase();

  if (name === "read" || name === "read_file") {
    return get("file_path") ?? get("path") ?? toolName;
  }
  if (name === "glob") {
    const pattern = get("pattern") ?? "";
    const path = get("path");
    return path ? `${pattern} (in ${path})` : pattern || toolName;
  }
  if (name === "grep") {
    const pattern = get("pattern") ?? "";
    const path = get("path");
    const glob = get("glob");
    const suffix = glob ?? path;
    return suffix ? `${pattern} (${suffix})` : pattern || toolName;
  }
  // Generic fallback — pick the first string-valued key that looks like a path
  // or query, otherwise just say the tool name.
  for (const k of ["file_path", "path", "pattern", "query", "command"]) {
    const v = get(k);
    if (v) return v;
  }
  return toolName;
}

/** Convert one Vercel AI SDK `streamText`/`generateText` step into activity
 *  entries — one per tool call, paired with its result by toolCallId. Returns
 *  a single "thinking" entry when the step ran no tools so the log still has a
 *  breadcrumb. Mirrors the generator analyze path so chats and the generator
 *  surface tool activity identically. */
export function stepToActivity(
  step: {
    toolCalls?: Array<{ toolCallId?: string; toolName?: string; input?: unknown }>;
    toolResults?: Array<{ toolCallId?: string; output?: unknown }>;
  },
  startMs: number,
): ActivityEntry[] {
  const calls = step.toolCalls ?? [];
  const results = step.toolResults ?? [];
  if (calls.length === 0) {
    return [{ id: newActivityId(), ts: Date.now() - startMs, kind: "thinking" }];
  }
  return calls.map((call) => {
    const match = results.find((r) => r.toolCallId === call.toolCallId);
    const raw = match ? stringifyResult(match.output) : undefined;
    const toolName = call.toolName ?? "tool";
    return {
      // Key by toolCallId so a live "tool-call" event (emitted from the
      // streaming onChunk handler) and this step-finish event upsert into the
      // SAME row instead of duplicating. Falls back to a fresh id when the SDK
      // didn't surface a call id.
      id: call.toolCallId ?? newActivityId(),
      ts: Date.now() - startMs,
      kind: "tool" as const,
      toolName,
      inputSummary: summarizeToolInput(
        toolName,
        (call.input ?? {}) as Record<string, unknown>,
      ),
      outputSummary: raw ? clampOutputSummary(raw) : undefined,
      outputFull: raw ? clampOutputFull(raw) : undefined,
    };
  });
}

export function stringifyResult(output: unknown): string {
  if (output == null) return "";
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

/** Compact label for the spinner caption — most recent thing the agent did. */
export function entryToLabel(entry: ActivityEntry): string {
  if (entry.kind === "tool" && entry.toolName) {
    return entry.inputSummary
      ? `${entry.toolName}: ${entry.inputSummary}`
      : entry.toolName;
  }
  if (entry.kind === "error") return entry.error ?? "Error";
  if (entry.kind === "output") return "Reading result…";
  return "Thinking…";
}

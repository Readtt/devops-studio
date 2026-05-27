// Shared tool-activity extraction for the Claude CLI NDJSON event stream.
// Pairs tool_use blocks with their later tool_result blocks (matched by
// tool_use_id) so each emitted ActivityEntry carries both the input and the
// result the agent saw. Used by the generator analyze path AND every chat
// surface (suite chat, code review, generator Ask) so tool calls render
// consistently instead of the model going silent while it works.

import type { ClaudeEvent } from "@/modules/ai/lib/claude";
import {
  clampOutputFull,
  clampOutputSummary,
  newActivityId,
  summarizeToolInput,
  type ActivityEntry,
} from "@/modules/generator/lib/activityLog";

type PendingTool = {
  activityId: string;
  toolName: string;
  startedAt: number;
};

export class ClaudeActivityTracker {
  private pending = new Map<string, PendingTool>();

  constructor(
    private readonly start: number,
    private readonly emit: ((e: ActivityEntry) => void) | undefined,
    /** When false, skip "thinking" breadcrumbs (assistant turns with no tool).
     *  Chats only want tool/error rows; the generator log wants thinking too. */
    private readonly emitThinking = true,
  ) {}

  consume(event: ClaudeEvent): void {
    if (!this.emit) return;
    if (event.type === "assistant") {
      const msg = event.message as
        | { content?: Array<Record<string, unknown>> }
        | undefined;
      const content = msg?.content ?? [];
      let sawTool = false;
      for (const block of content) {
        if (block && (block as { type?: string }).type === "tool_use") {
          sawTool = true;
          this.openToolUse(block);
        }
      }
      if (!sawTool && this.emitThinking) {
        this.emit({
          id: newActivityId(),
          ts: Date.now() - this.start,
          kind: "thinking",
        });
      }
      return;
    }
    if (event.type === "user") {
      const msg = event.message as
        | { content?: Array<Record<string, unknown>> }
        | undefined;
      for (const block of msg?.content ?? []) {
        if (block && (block as { type?: string }).type === "tool_result") {
          this.closeToolResult(block);
        }
      }
      return;
    }
    if (event.type === "system") {
      this.consumeSystem(event);
      return;
    }
    if (event.type === "result" && event.is_error === true) {
      const detail =
        typeof event.result === "string" ? event.result : "Run failed.";
      this.emit({
        id: newActivityId(),
        ts: Date.now() - this.start,
        kind: "error",
        toolName: "result",
        inputSummary: detail,
        error: detail,
      });
    }
  }

  /** System events carry the things that used to fail silently: failing
   *  SessionStart hooks (whose stderr never reaches our pipe) and retried API
   *  calls. We log the failure-worthy ones so the user has a paper trail when
   *  a run "just exits". */
  private consumeSystem(event: ClaudeEvent): void {
    if (!this.emit) return;
    const subtype = typeof event.subtype === "string" ? event.subtype : "";
    if (subtype === "hook_response") {
      const exit = typeof event.exit_code === "number" ? event.exit_code : 0;
      const outcome = typeof event.outcome === "string" ? event.outcome : "";
      const hookName =
        typeof event.hook_name === "string" ? event.hook_name : "hook";
      if (exit !== 0 || outcome === "failure") {
        const stderr = typeof event.stderr === "string" ? event.stderr : "";
        const stdout = typeof event.stdout === "string" ? event.stdout : "";
        const message = stderr.trim() || stdout.trim() || `hook exited ${exit}`;
        this.emit({
          id: newActivityId(),
          ts: Date.now() - this.start,
          kind: "error",
          toolName: `hook:${hookName}`,
          inputSummary: message.slice(0, 200),
          error: message,
        });
      }
      return;
    }
    if (subtype === "api_retry") {
      const attempt = typeof event.attempt === "number" ? event.attempt : "?";
      const maxRetries =
        typeof event.max_retries === "number" ? event.max_retries : "?";
      const category = typeof event.error === "string" ? event.error : "retry";
      this.emit({
        id: newActivityId(),
        ts: Date.now() - this.start,
        kind: "thinking",
        inputSummary: `api retry ${attempt}/${maxRetries} — ${category}`,
      });
    }
  }

  private openToolUse(block: Record<string, unknown>): void {
    if (!this.emit) return;
    const toolName = typeof block.name === "string" ? block.name : "tool";
    const id = typeof block.id === "string" ? block.id : `local-${newActivityId()}`;
    const input = (block.input ?? {}) as Record<string, unknown>;
    const activityId = newActivityId();
    this.pending.set(id, { activityId, toolName, startedAt: Date.now() });
    this.emit({
      id: activityId,
      ts: Date.now() - this.start,
      kind: "tool",
      toolName,
      inputSummary: summarizeToolInput(toolName, input),
    });
  }

  private closeToolResult(block: Record<string, unknown>): void {
    if (!this.emit) return;
    const id = typeof block.tool_use_id === "string" ? block.tool_use_id : null;
    if (!id) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    const rawText = extractToolResultText(block.content);
    const durationMs = Date.now() - pending.startedAt;
    const isError = block.is_error === true;
    this.emit({
      id: pending.activityId,
      ts: Date.now() - this.start,
      kind: isError ? "error" : "tool",
      toolName: pending.toolName,
      outputSummary: rawText ? clampOutputSummary(rawText) : undefined,
      outputFull: rawText ? clampOutputFull(rawText) : undefined,
      durationMs,
      error: isError ? rawText.slice(0, 200) : undefined,
    });
  }
}

export function extractToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object") {
        const t = (block as { text?: unknown }).text;
        if (typeof t === "string") parts.push(t);
      } else if (typeof block === "string") {
        parts.push(block);
      }
    }
    return parts.join("\n");
  }
  return "";
}

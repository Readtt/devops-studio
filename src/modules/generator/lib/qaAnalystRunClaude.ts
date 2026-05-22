// Generator path that drives the `claude` CLI instead of the Vercel AI SDK.
// Same input/output contract as `qaAnalystRun.ts` so the calling store
// (useGenerationSession) can swap between them transparently.

import { getKey } from "@/modules/ai/lib/keyring";
import { runClaudeQuery, type ClaudeEvent } from "@/modules/ai/lib/claude";
import {
  DraftBatchLLMSchema,
  type DraftBatchLLM,
} from "./draftBatchSchema";
import { QA_ANALYST_PROMPT } from "./qaAnalystPrompt";
import type { ClaudeAuthMode } from "@/modules/settings/store";
import type { ModelId } from "@/modules/ai/config";
import type { TestCaseRef } from "@/modules/ado";
import {
  formatAttachmentBlock,
  renderTargetContext,
  type GenerationMode,
  type RunAttachment,
  type RunResult,
  type TargetContext,
} from "./qaAnalystRun";
import { renderRelatedCases, type RelatedCase } from "./relatedCases";
import {
  clampOutputFull,
  clampOutputSummary,
  newActivityId,
  summarizeToolInput,
  type ActivityEntry,
} from "./activityLog";

export type RunClaudeInput = {
  requirements: string;
  attachments: RunAttachment[];
  existingCaseTitles: Pick<TestCaseRef, "id" | "title">[];
  /** Cases from sibling suites in the same plan — see qaAnalystRun.ts. */
  relatedCases?: RelatedCase[];
  /** Plan/suite the generator will publish into — see qaAnalystRun.ts. */
  targetContext?: TargetContext | null;
  mode: GenerationMode;
  modelId: ModelId;
  /** Working directory for the CLI's built-in Read/Glob/Grep tools — the
   *  user's source dir. When null, the CLI runs at the app's cwd and the
   *  agent can't read your code. */
  sourceRoot: string | null;
  /** "max-oauth" → rely on the CLI's own stored token. "api-key" → load the
   *  Anthropic key from the keyring and pass it via env. */
  authMode: ClaudeAuthMode;
  /** When true, pass `--bare` to the CLI: skip user-installed hooks, plugins,
   *  MCP servers, and CLAUDE.md auto-discovery. Surfaces in Settings → Models
   *  as an escape hatch for users whose `~/.claude/settings.json` has a hook
   *  that silently aborts every run with code 1. */
  bareMode?: boolean;
  /** Structured per-step activity for the streaming log UI. */
  onActivity?: (entry: ActivityEntry) => void;
  /** Pre-built user prompt that replaces the auto-generated one. Used by
   *  refine() so the model sees a "follow-up against this draft" framing
   *  instead of "start from scratch". */
  userPromptOverride?: string;
  /** Called once with the run id the moment we have one. The store stashes
   *  it so an ESC press can call cancelClaudeRun(runId) and abort the
   *  in-flight subprocess instead of waiting for the model to finish. */
  onRunStart?: (runId: string) => void;
};

export async function runQaAnalystClaude(
  input: RunClaudeInput,
): Promise<RunResult> {
  const runId = newRunId();
  const env: Record<string, string> = {};
  if (input.authMode === "api-key") {
    const key = await getKey("anthropic");
    if (key) env.ANTHROPIC_API_KEY = key;
  }

  const userPrompt = input.userPromptOverride ?? buildUserPrompt(input);
  const start = Date.now();
  const tracker = new ActivityTracker(start, input.onActivity);
  // Hand the runId back to the caller before we await — that's the only
  // way ESC can race the subprocess. After this point, the store can call
  // cancelClaudeRun(runId) and the Rust side will kill the child.
  input.onRunStart?.(runId);

  const result = await runClaudeQuery(
    {
      runId,
      prompt: userPrompt,
      systemPrompt: QA_ANALYST_PROMPT,
      cwd: input.sourceRoot ?? undefined,
      model: input.modelId,
      maxTurns: 24,
      // The generator is strictly an analyst — it reads code and writes JSON
      // to stdout, nothing else. `--tools` (the actual built-in restriction
      // flag) limits the agent to the three read-only tools; the old code
      // used `--allowedTools`, which only pre-approves permission prompts and
      // is bypassed by `bypassPermissions` — meaning the model could still
      // call Bash/Write/Edit unprompted. `bypassPermissions` then lets file
      // reads inside the user's source dir proceed without a permission
      // dialog mid-run. The Rust handler refuses to spawn if this set ever
      // contains a mutating tool, so a typo can't quietly re-open the
      // surface.
      //
      // `--bare` skips user hooks / plugins / MCP / CLAUDE.md AND skips
      // the CLI's keychain reads — so it requires API-key auth to find an
      // Anthropic key. If the user is on Max OAuth, we silently fall back
      // to non-bare regardless of the toggle (the UI flags this conflict
      // separately so they're not surprised). On API-key auth, the toggle
      // controls bare mode directly.
      bare: input.bareMode === true && input.authMode === "api-key",
      permissionMode: "bypassPermissions",
      allowedTools: ["Read", "Glob", "Grep"],
      env: Object.keys(env).length > 0 ? env : undefined,
    },
    (e) => tracker.consume(e),
  );

  const text = result.text || "";
  const batch = parseBatch(text);
  return { batch, rawText: text, durationMs: Date.now() - start };
}

function newRunId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `gen-${ts}-${rand}`;
}

type PendingTool = {
  activityId: string;
  toolName: string;
  startedAt: number;
};

/** Walks the CLI's NDJSON event stream and emits structured ActivityEntry
 *  events. Pairs tool_use blocks with their later tool_result blocks (matched
 *  by tool_use_id) so each log entry has both the input and the result the
 *  agent saw. */
class ActivityTracker {
  private pending = new Map<string, PendingTool>();

  constructor(
    private readonly start: number,
    private readonly emit: ((e: ActivityEntry) => void) | undefined,
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
      if (!sawTool) {
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
    // The stream-json result event carries a top-level `is_error` flag (e.g.
    // 401 auth failures) — surface that into the activity log so the user
    // sees the actual diagnostic instead of an empty refine outcome.
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
      return;
    }
  }

  /** System events carry the things that used to fail silently: failing
   *  SessionStart hooks (whose stderr never reaches our pipe), retried API
   *  calls, and the init payload. We log the failure-worthy ones so the user
   *  has a paper trail when a refine "just exits". */
  private consumeSystem(event: ClaudeEvent): void {
    if (!this.emit) return;
    const subtype = typeof event.subtype === "string" ? event.subtype : "";
    if (subtype === "hook_response") {
      const exit = typeof event.exit_code === "number" ? event.exit_code : 0;
      const outcome =
        typeof event.outcome === "string" ? event.outcome : "";
      const hookName =
        typeof event.hook_name === "string" ? event.hook_name : "hook";
      if (exit !== 0 || outcome === "failure") {
        const stderr = typeof event.stderr === "string" ? event.stderr : "";
        const stdout = typeof event.stdout === "string" ? event.stdout : "";
        const message =
          stderr.trim() || stdout.trim() || `hook exited ${exit}`;
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
      const attempt =
        typeof event.attempt === "number" ? event.attempt : "?";
      const maxRetries =
        typeof event.max_retries === "number" ? event.max_retries : "?";
      const category =
        typeof event.error === "string" ? event.error : "retry";
      this.emit({
        id: newActivityId(),
        ts: Date.now() - this.start,
        kind: "thinking",
        inputSummary: `api retry ${attempt}/${maxRetries} — ${category}`,
      });
      return;
    }
  }

  private openToolUse(block: Record<string, unknown>): void {
    if (!this.emit) return;
    const toolName = typeof block.name === "string" ? block.name : "tool";
    const id = typeof block.id === "string" ? block.id : `local-${newActivityId()}`;
    const input = (block.input ?? {}) as Record<string, unknown>;
    const activityId = newActivityId();
    this.pending.set(id, {
      activityId,
      toolName,
      startedAt: Date.now(),
    });
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
    const id =
      typeof block.tool_use_id === "string" ? block.tool_use_id : null;
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
      // re-emit input so the UI can reconcile by id and overwrite with the
      // completed entry (the store's reducer handles dedup-by-id).
      outputSummary: rawText ? clampOutputSummary(rawText) : undefined,
      outputFull: rawText ? clampOutputFull(rawText) : undefined,
      durationMs,
      error: isError ? rawText.slice(0, 200) : undefined,
    });
  }
}

function extractToolResultText(content: unknown): string {
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

function buildUserPrompt(input: RunClaudeInput): string {
  const modeLine =
    input.mode === "happy"
      ? "Mode: happy — only generate happy-path cases."
      : input.mode === "thorough"
        ? "Mode: thorough — happy + edge cases + negative paths."
        : "Mode: bug-hunt — thorough plus flag concrete bug suggestions where warranted.";

  const existing =
    input.existingCaseTitles.length === 0
      ? "No existing cases in the target suite — generate freely."
      : "Existing case titles in this suite (do not duplicate):\n" +
        input.existingCaseTitles
          .map((c) => `  #${c.id}: ${c.title}`)
          .join("\n");

  const sourceHint = input.sourceRoot
    ? `Working directory: ${input.sourceRoot}\nUse Read / Glob / Grep to ground every case in actual code paths.`
    : "No source directory set — work from the requirements alone.";

  const attached =
    input.attachments.length === 0
      ? ""
      : "\n\nAdditional source attachments:\n\n" +
        input.attachments.map(formatAttachmentBlock).join("\n\n");

  const targetBlock = renderTargetContext(input.targetContext);
  const relatedBlock = renderRelatedCases(input.relatedCases ?? []);

  return [
    modeLine,
    "",
    targetBlock,
    sourceHint,
    "",
    "Feature requirements:",
    input.requirements.trim(),
    "",
    existing,
    relatedBlock ? "" : null,
    relatedBlock || null,
    attached,
    "",
    "Return ONLY the DraftBatch JSON — no prose, no code fences. Schema:",
    JSON.stringify(DRAFT_BATCH_SHAPE, null, 2),
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

const DRAFT_BATCH_SHAPE = {
  cases: [
    {
      title: "[Auth] When user logs in with valid TOTP then session is created",
      description: "Optional context for the tester running this case.",
      steps: [{ action: "Navigate to /login", expected: "Login form renders" }],
      tags: ["auth", "regression"],
      rationale: "Why this case exists in one sentence.",
    },
  ],
  bugs: [
    {
      title: "[Auth] SMS fallback ignores rate-limit",
      reproSteps:
        "1. Enter valid credentials. 2. Trigger SMS code 6 times in 60s. Observed: all 6 codes sent. Expected: throttled after 3.",
      severity: "2 - High",
      linkedDraftCaseIndex: 0,
      codeRefs: [
        {
          file: "src/auth/sms.ts",
          startLine: 42,
          endLine: 58,
          symbol: "sendCode",
        },
      ],
    },
  ],
};

function parseBatch(text: string): DraftBatchLLM {
  const trimmed = text.trim();
  const candidate = extractJson(trimmed);
  try {
    return DraftBatchLLMSchema.parse(JSON.parse(candidate));
  } catch {
    return { cases: [], bugs: [] };
  }
}

function extractJson(s: string): string {
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) return fence[1].trim();
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first >= 0 && last > first) return s.slice(first, last + 1);
  return s;
}

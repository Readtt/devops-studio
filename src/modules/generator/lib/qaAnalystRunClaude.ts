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
import type { GenerationMode, RunResult } from "./qaAnalystRun";

export type RunClaudeInput = {
  requirements: string;
  attachments: Array<{ path: string; content: string }>;
  existingCaseTitles: Pick<TestCaseRef, "id" | "title">[];
  mode: GenerationMode;
  modelId: ModelId;
  /** Working directory for the CLI's built-in Read/Glob/Grep tools — the
   *  user's source dir. When null, the CLI runs at the app's cwd and the
   *  agent can't read your code. */
  sourceRoot: string | null;
  /** "max-oauth" → rely on the CLI's own stored token. "api-key" → load the
   *  Anthropic key from the keyring and pass it via env. */
  authMode: ClaudeAuthMode;
  onStep?: (label: string) => void;
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

  const userPrompt = buildUserPrompt(input);
  const start = Date.now();

  const result = await runClaudeQuery(
    {
      runId,
      prompt: userPrompt,
      systemPrompt: QA_ANALYST_PROMPT,
      cwd: input.sourceRoot ?? undefined,
      model: input.modelId,
      maxTurns: 24,
      // The CLI's Read/Glob/Grep are read-only; Bash is the only mutating
      // builtin. The user picked this directory; bypass permissions so we
      // don't pop a UI dialog mid-run for every file read. The CLI still
      // refuses paths outside the configured cwd, so the blast radius is
      // capped to the source dir.
      permissionMode: "bypassPermissions",
      env: Object.keys(env).length > 0 ? env : undefined,
    },
    (e) => emitStep(e, input.onStep),
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

function emitStep(event: ClaudeEvent, onStep: RunClaudeInput["onStep"]): void {
  if (!onStep) return;
  // The CLI emits assistant-content blocks; we translate the most useful
  // ones into a human-readable step label. Anything else falls through
  // as "thinking" so the UI shows the agent is alive.
  if (event.type === "assistant") {
    const msg = event.message as { content?: Array<{ type?: string; name?: string }> } | undefined;
    const tool = msg?.content?.find?.((c) => c?.type === "tool_use");
    if (tool?.name) {
      onStep(`tool: ${tool.name}`);
      return;
    }
    onStep("thinking");
    return;
  }
  if (event.type === "tool_use") {
    const name = (event as { name?: string }).name;
    if (name) onStep(`tool: ${name}`);
  }
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
        input.attachments
          .map((a) => `--- ${a.path} ---\n${a.content}`)
          .join("\n\n");

  return [
    modeLine,
    "",
    sourceHint,
    "",
    "Feature requirements:",
    input.requirements.trim(),
    "",
    existing,
    attached,
    "",
    "Return ONLY the DraftBatch JSON — no prose, no code fences. Schema:",
    JSON.stringify(DRAFT_BATCH_SHAPE, null, 2),
  ].join("\n");
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
      reproSteps: "Step-by-step repro in plain prose.",
      severity: "2 - High",
      linkedDraftCaseIndex: 0,
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

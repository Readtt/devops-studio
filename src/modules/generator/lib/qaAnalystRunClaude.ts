// Generator path that drives the `claude` CLI instead of the Vercel AI SDK.
// Same input/output contract as `qaAnalystRun.ts` so the calling store
// (useGenerationSession) can swap between them transparently.

import { getKey } from "@/modules/ai/lib/keyring";
import { runClaudeQuery } from "@/modules/ai/lib/claude";
import { imageAttachmentToBase64 } from "@/components/chat/attachments";
import {
  collectContextImages,
  formatContextBlocks,
  type ContextBlock,
} from "@/modules/ai/lib/contextBlocks";
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
  renderChangesetsBlock,
  renderExistingCases,
  renderTargetContext,
  type ExistingCaseDetail,
  type GenerationMode,
  type RunAttachment,
  type RunResult,
  type TargetContext,
} from "./qaAnalystRun";
import { renderRelatedCases, type RelatedCase } from "./relatedCases";
import { ClaudeActivityTracker } from "@/modules/ai/lib/claudeActivity";
import type { ActivityEntry } from "./activityLog";

export type RunClaudeInput = {
  requirements: string;
  attachments: RunAttachment[];
  existingCaseTitles: Pick<TestCaseRef, "id" | "title">[];
  /** Full existing cases (with steps) for the target suite — see qaAnalystRun.ts. */
  existingCases?: ExistingCaseDetail[];
  /** Cases from sibling suites in the same plan — see qaAnalystRun.ts. */
  relatedCases?: RelatedCase[];
  /** Plan/suite the generator will publish into — see qaAnalystRun.ts. */
  targetContext?: TargetContext | null;
  /** Optional changeset / scope notes — see SCOPING in QA_ANALYST_PROMPT. */
  changesets?: string;
  mode: GenerationMode;
  modelId: ModelId;
  /** Working directory for the CLI's built-in Read/Glob/Grep tools — the
   *  user's source dir. When null, the CLI runs at the app's cwd and the
   *  agent can't read your code. */
  sourceRoot: string | null;
  /** "max-oauth" → rely on the CLI's own stored token. "api-key" → load the
   *  Anthropic key from the keyring and pass it via env. */
  authMode: ClaudeAuthMode;
  /** Structured per-step activity for the streaming log UI. */
  onActivity?: (entry: ActivityEntry) => void;
  /** Pre-built user prompt that replaces the auto-generated one. Used by
   *  refine() so the model sees a "follow-up against this draft" framing
   *  instead of "start from scratch". */
  userPromptOverride?: string;
  /** Extra context blocks (best-practices files, attached bugs) appended to
   *  the prompt and lifted into vision input. See qaAnalystRun.ts. */
  contextBlocks?: ContextBlock[];
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

  const ctxText = formatContextBlocks(input.contextBlocks ?? []);
  const basePrompt = input.userPromptOverride ?? buildUserPrompt(input);
  const userPrompt = ctxText ? `${basePrompt}\n\n${ctxText}` : basePrompt;
  // Lift image attachments into real vision blocks for the CLI's stream-json
  // input. Text attachments stay embedded in the prompt (buildUserPrompt).
  // Best-practice / bug-context images ride along the same way.
  const images = [
    ...input.attachments,
    ...collectContextImages(input.contextBlocks ?? []),
  ]
    .map(imageAttachmentToBase64)
    .filter((x): x is { mediaType: string; dataBase64: string } => x !== null);
  const start = Date.now();
  const tracker = new ClaudeActivityTracker(start, input.onActivity);
  // Hand the runId back to the caller before we await — that's the only
  // way ESC can race the subprocess. After this point, the store can call
  // cancelClaudeRun(runId) and the Rust side will kill the child.
  input.onRunStart?.(runId);

  const result = await runClaudeQuery(
    {
      runId,
      prompt: userPrompt,
      images: images.length > 0 ? images : undefined,
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
      // `--bare` skips user hooks / plugins / MCP / CLAUDE.md AND skips the
      // CLI's keychain reads. API-key runs always go bare so the user's
      // global ~/.claude config can't interfere with our structured runs;
      // OAuth (Max) runs can't be bare because they need the keychain.
      bare: input.authMode === "api-key",
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

function buildUserPrompt(input: RunClaudeInput): string {
  const modeLine =
    input.mode === "happy"
      ? "Mode: happy — only generate happy-path cases."
      : input.mode === "thorough"
        ? "Mode: thorough — happy + edge cases + negative paths."
        : "Mode: bug-hunt — thorough plus flag concrete bug suggestions where warranted.";

  const existing = renderExistingCases(input.existingCaseTitles, input.existingCases);

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
  const changesetsBlock = renderChangesetsBlock(input.changesets);

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
    changesetsBlock ? "" : null,
    changesetsBlock || null,
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

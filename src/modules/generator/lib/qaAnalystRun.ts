import { generateText, stepCountIs } from "ai";
import { getModel, type ModelId } from "@/modules/ai/config";
import { buildLanguageModel } from "@/modules/ai/lib/agent";
import type { ProviderKeys } from "@/modules/ai/lib/keyring";
import {
  DraftBatchLLMSchema,
  type DraftBatchLLM,
} from "./draftBatchSchema";
import { QA_ANALYST_PROMPT } from "./qaAnalystPrompt";
import type { TestCaseRef } from "@/modules/ado";
import {
  clampOutputFull,
  clampOutputSummary,
  newActivityId,
  summarizeToolInput,
  type ActivityEntry,
} from "./activityLog";
import { renderRelatedCases, type RelatedCase } from "./relatedCases";
import { buildUserTurn } from "@/modules/ai/lib/visionMessage";
import {
  collectContextImages,
  formatContextBlocks,
  type ContextBlock,
} from "@/modules/ai/lib/contextBlocks";

const MAX_STEPS = 12;

export type GenerationMode = "happy" | "thorough" | "bug-hunt";

/** Subset of session Attachment surface the analyst engines understand. Kept
 *  here (not imported from the store) so the lib layer doesn't depend on the
 *  React store and stays testable in isolation. */
export type RunAttachment = {
  path: string;
  content: string;
  kind?: "text" | "image" | "binary";
  mime?: string;
  sizeBytes?: number;
};

/** Target plan + suite context surfaced to the model so generated cases
 *  inherit the right area/iteration and the AI knows the suite hierarchy
 *  it's writing for — not just a dedup list of existing titles. */
export type TargetContext = {
  planId: number;
  planName: string | null;
  suiteId: number;
  suiteName: string | null;
  /** Names of ancestor suites from root → parent of current suite. Empty
   *  array when the suite is directly under the plan root. */
  suitePath: string[];
  /** Default Azure DevOps area path the plan was created under. Generated
   *  cases inherit this unless the model overrides. */
  areaPath: string | null;
  /** Default ADO iteration path for the plan. */
  iterationPath: string | null;
};

/** An existing case in the target suite, with steps, so the analyst can read
 *  what's already covered (not just titles) and generate complementary,
 *  style-matched cases. Populated from per-case fetches at analyze time. */
export type ExistingCaseDetail = {
  id: number;
  title: string;
  steps: { action: string; expected: string }[];
};

export type RunInput = {
  requirements: string;
  attachments: RunAttachment[];
  existingCaseTitles: Pick<TestCaseRef, "id" | "title">[];
  /** Full existing cases (with steps) for the target suite. When present the
   *  prompt shows these in detail instead of the bare titles list, so the
   *  model can read prior coverage and match its style. */
  existingCases?: ExistingCaseDetail[];
  /** Cases from sibling suites in the same plan, surfaced as supplementary
   *  context. May contain stale or wrong entries — the prompt explicitly
   *  flags them as lower-priority than the feature spec. */
  relatedCases?: RelatedCase[];
  /** Plan/suite the generator will publish into. The runner embeds this in
   *  the user prompt so the model knows where these cases live. */
  targetContext?: TargetContext | null;
  /** Optional changeset / scope notes the developer pasted into the input
   *  form — commit messages, PR descriptions, ADO changeset links, etc.
   *  Passed to the analyst as a scope hint to narrow coverage. See
   *  SCOPING in QA_ANALYST_PROMPT. */
  changesets?: string;
  mode: GenerationMode;
  /** Provider keys hydrated from the OS keychain (chatStore.apiKeys). */
  keys: ProviderKeys;
  modelId: ModelId;
  lmstudioBaseURL?: string;
  /** Structured per-step activity for the streaming log UI. Called for each
   *  tool call (with input + result) and for "thinking" steps without tools. */
  onActivity?: (entry: ActivityEntry) => void;
  /** Pre-built user prompt that replaces the auto-generated one. Used by
   *  refine() so the model sees a "follow-up against this draft" framing
   *  instead of "start from scratch". When set, the runner skips its own
   *  buildUserPrompt and passes this verbatim. */
  userPromptOverride?: string;
  /** Extra context blocks (best-practices files, attached bugs) appended to
   *  the prompt and lifted into vision input. Injected for both the initial
   *  and refine paths. Empty/absent ⇒ prompt unchanged. */
  contextBlocks?: ContextBlock[];
};

export type RunResult = {
  batch: DraftBatchLLM;
  rawText: string;
  durationMs: number;
};

export async function runQaAnalyst(input: RunInput): Promise<RunResult> {
  const model = getModel(input.modelId);
  const lm = await buildLanguageModel(model.provider, input.keys, model.id, {
    lmstudioBaseURL: input.lmstudioBaseURL,
  });

  const ctxText = formatContextBlocks(input.contextBlocks ?? []);
  const basePrompt = input.userPromptOverride ?? buildUserPrompt(input);
  const userPrompt = ctxText ? `${basePrompt}\n\n${ctxText}` : basePrompt;
  // Merge best-practice / bug-context images into the vision attachments so a
  // standards screenshot reaches the model the same way a dropped image does.
  const attachments = [
    ...input.attachments,
    ...collectContextImages(input.contextBlocks ?? []),
  ];
  const start = Date.now();

  // SAFETY: the analyst path runs WITHOUT tools — text-in, JSON-out. The
  // model only sees attachments we pass in `userPrompt`; it can't read or
  // mutate the user's filesystem through this path. Do NOT add a `tools`
  // field here without revisiting the read-only contract enforced in the
  // Claude CLI path (allowedTools: Read/Glob/Grep). If you need tools for a
  // different flow, build a new entrypoint instead of editing this one.
  const result = await generateText({
    model: lm,
    system: QA_ANALYST_PROMPT,
    ...buildUserTurn(userPrompt, attachments),
    stopWhen: stepCountIs(MAX_STEPS),
    onStepFinish: (step) => {
      const onActivity = input.onActivity;
      if (!onActivity) return;
      const calls = step.toolCalls ?? [];
      const results = step.toolResults ?? [];
      if (calls.length === 0) {
        // No tool — record the model's thinking step so the log has a
        // breadcrumb even when nothing observable happened.
        onActivity({
          id: newActivityId(),
          ts: Date.now() - start,
          kind: "thinking",
        });
        return;
      }
      for (const call of calls) {
        const matching = results.find(
          (r) => (r as { toolCallId?: string }).toolCallId === call.toolCallId,
        );
        const rawResult = matching
          ? stringifyResult((matching as { output?: unknown }).output)
          : undefined;
        onActivity({
          id: newActivityId(),
          ts: Date.now() - start,
          kind: "tool",
          toolName: call.toolName,
          inputSummary: summarizeToolInput(
            call.toolName,
            (call.input ?? {}) as Record<string, unknown>,
          ),
          outputSummary: rawResult ? clampOutputSummary(rawResult) : undefined,
          outputFull: rawResult ? clampOutputFull(rawResult) : undefined,
        });
      }
    },
  });

  const text = result.text || "";
  const batch = parseBatch(text);
  return { batch, rawText: text, durationMs: Date.now() - start };
}

function buildUserPrompt(input: RunInput): string {
  const modeLine =
    input.mode === "happy"
      ? "Mode: happy — only generate happy-path cases."
      : input.mode === "thorough"
        ? "Mode: thorough — happy + edge cases + negative paths."
        : "Mode: bug-hunt — thorough plus flag concrete bug suggestions where warranted.";

  const existing = renderExistingCases(input.existingCaseTitles, input.existingCases);

  const attached =
    input.attachments.length === 0
      ? ""
      : "\n\nSource code attached for grounding:\n\n" +
        input.attachments.map(formatAttachmentBlock).join("\n\n");

  const targetBlock = renderTargetContext(input.targetContext);
  const relatedBlock = renderRelatedCases(input.relatedCases ?? []);
  const changesetsBlock = renderChangesetsBlock(input.changesets);

  return [
    modeLine,
    "",
    targetBlock,
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
    "Return ONLY the DraftBatch JSON. Schema:",
    JSON.stringify(DRAFT_BATCH_SHAPE, null, 2),
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

const MAX_EXISTING_DETAIL = 20;
const MAX_EXISTING_STEP_LINES = 8;

/** Render the "existing cases in this suite" block. When full case details
 *  (with steps) are available, show up to MAX_EXISTING_DETAIL of them with
 *  their steps so the model reads prior coverage and matches its style; the
 *  rest fall back to titles-only so the dedup list stays complete. Without
 *  details, renders the bare titles list. */
export function renderExistingCases(
  titles: { id: number; title: string }[],
  details?: ExistingCaseDetail[],
): string {
  if ((details?.length ?? 0) === 0 && titles.length === 0) {
    return "No existing cases in the target suite — generate freely.";
  }
  if (details && details.length > 0) {
    const shown = details.slice(0, MAX_EXISTING_DETAIL);
    const lines: string[] = [
      "EXISTING CASES already in this suite — do NOT duplicate these. Read their",
      "steps to see what's covered, match their style and granularity, and",
      "generate cases that COMPLEMENT (not repeat) this coverage:",
    ];
    for (const c of shown) {
      lines.push("");
      lines.push(`#${c.id}: ${c.title}`);
      const steps = c.steps.slice(0, MAX_EXISTING_STEP_LINES);
      for (let i = 0; i < steps.length; i++) {
        lines.push(`  ${i + 1}. ${oneLine(steps[i].action)} → ${oneLine(steps[i].expected)}`);
      }
      if (c.steps.length > steps.length) {
        lines.push(`  … (+${c.steps.length - steps.length} more steps)`);
      }
    }
    if (details.length > shown.length) {
      lines.push("");
      lines.push(
        `Plus ${details.length - shown.length} more existing case(s) — titles only:`,
      );
      for (const c of details.slice(MAX_EXISTING_DETAIL)) {
        lines.push(`  #${c.id}: ${c.title}`);
      }
    }
    return lines.join("\n");
  }
  return (
    "Existing case titles in this suite (do not duplicate):\n" +
    titles.map((c) => `  #${c.id}: ${c.title}`).join("\n")
  );
}

function oneLine(s: string, cap = 200): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > cap ? `${flat.slice(0, cap - 1)}…` : flat;
}

/** Render the CHANGESETS / SCOPE NOTES block. Empty when the user didn't
 *  paste any — the prompt then proceeds without scoping guidance, which is
 *  the right behavior for a "generate from spec alone" run. */
export function renderChangesetsBlock(input?: string | null): string {
  const trimmed = (input ?? "").trim();
  if (trimmed.length === 0) return "";
  return [
    "CHANGESETS / SCOPE NOTES — the developer pasted these as a hint about",
    "what actually changed. Use them to scope coverage per the SCOPING rule.",
    "Treat them as POSSIBLY INCOMPLETE.",
    "",
    trimmed,
  ].join("\n");
}

/** Build the TARGET CONTEXT block embedded near the top of the user prompt.
 *  Returns an empty string when no context is available — the prompt then
 *  proceeds without it. */
export function renderTargetContext(
  ctx: TargetContext | null | undefined,
): string {
  if (!ctx) return "";
  const planLine = ctx.planName
    ? `- Plan: ${ctx.planName} (#${ctx.planId})`
    : `- Plan: #${ctx.planId}`;
  const suiteWithPath = ctx.suitePath.length > 0
    ? `${ctx.suitePath.join(" › ")} › ${ctx.suiteName ?? `#${ctx.suiteId}`}`
    : ctx.suiteName ?? `#${ctx.suiteId}`;
  const suiteLine = `- Suite: ${suiteWithPath} (#${ctx.suiteId})`;
  const areaLine = ctx.areaPath
    ? `- Default area path: ${ctx.areaPath}`
    : null;
  const iterLine = ctx.iterationPath
    ? `- Default iteration path: ${ctx.iterationPath}`
    : null;
  return [
    "TARGET CONTEXT — these are the test plan and suite the cases will be",
    "published into. Cases inherit the default area / iteration unless your",
    "draft overrides them explicitly.",
    planLine,
    suiteLine,
    areaLine,
    iterLine,
    "",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

/** Schema-shape hint embedded in the prompt — keeps the model honest. */
const DRAFT_BATCH_SHAPE = {
  cases: [
    {
      title: "[Auth] When user logs in with valid TOTP then session is created",
      description: "Optional context for the tester running this case.",
      steps: [
        {
          action: "Navigate to /login",
          expected: "Login form renders",
        },
      ],
      tags: ["auth", "regression"],
      rationale:
        "Why this case exists in one sentence — shown to reviewers.",
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
    // Be permissive — return an empty batch rather than crashing the UI.
    return { cases: [], bugs: [] };
  }
}

/** Render one attachment for inclusion in the user prompt. Text attachments
 *  embed their content directly; images and binaries embed a metadata-only
 *  placeholder so the model knows they exist (true multimodal passthrough is
 *  a follow-up that has to switch the engines to the messages API). */
export function formatAttachmentBlock(a: RunAttachment): string {
  const kind = a.kind ?? "text";
  if (kind === "image") {
    const mime = a.mime ?? "image";
    const bytes = a.sizeBytes != null ? `, ${a.sizeBytes} bytes` : "";
    return `--- ${a.path} ---\n[user-attached image: ${mime}${bytes}]`;
  }
  if (kind === "binary") {
    const mime = a.mime ?? "application/octet-stream";
    const bytes = a.sizeBytes != null ? `, ${a.sizeBytes} bytes` : "";
    return `--- ${a.path} ---\n[user-attached binary: ${mime}${bytes}]`;
  }
  return `--- ${a.path} ---\n${a.content}`;
}

function stringifyResult(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Strip code fences / preamble if the model didn't fully obey the rules. */
function extractJson(s: string): string {
  // Remove ```json … ``` fences.
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) return fence[1].trim();
  // Take from the first { to the last } if there's surrounding prose.
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first >= 0 && last > first) return s.slice(first, last + 1);
  return s;
}

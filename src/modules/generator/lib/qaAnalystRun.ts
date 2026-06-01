import { SURFACE_STEP_CAPS, type ModelId } from "@/modules/ai/config";
import type { ProviderKeys } from "@/modules/ai/lib/keyring";
import { runTask } from "@/modules/ai/lib/taskRunner";
import { buildSuiteChatTools } from "@/modules/test-plans/lib/suiteChatTools";
import {
  DraftBatchLLMSchema,
  clampBugLinks,
  salvageDraftBatch,
  type DraftBatchLLM,
} from "./draftBatchSchema";
import { QA_ANALYST_PROMPT } from "./qaAnalystPrompt";
import type { TestCaseRef } from "@/modules/ado";
import type { ActivityEntry } from "./activityLog";
import { renderRelatedCases, type RelatedCase } from "./relatedCases";
import {
  collectContextImages,
  formatContextBlocks,
  type ContextBlock,
} from "@/modules/ai/lib/contextBlocks";

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
  /** When set (global code-search toggle on + a source dir), the analyzer gets
   *  read-only Read/Glob/Grep tools so it can trace the spec against real code
   *  — deeper, code-grounded cases. null ⇒ tool-less (spec + attachments only). */
  sourceRoot?: string | null;
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

  // Read-only source tools when code search is on — the analyzer can trace the
  // spec across real files instead of guessing from the prompt alone. SAFETY:
  // these are READ-ONLY (read_file / list_files / grep); the runner never
  // injects write/edit/bash tools.
  const tools = buildSuiteChatTools(input.sourceRoot ?? null);

  // Schema-validated, temperature-0 structured output via the shared runner.
  // With tools the runner uses experimental_output (schema still enforced);
  // tool-less it uses generateObject.
  const r = await runTask({
    modelId: input.modelId,
    keys: input.keys,
    local: { lmstudioBaseURL: input.lmstudioBaseURL },
    systemPrompt: QA_ANALYST_PROMPT,
    prompt: userPrompt,
    attachments,
    tools: tools ?? null,
    temperature: 0,
    maxSteps: SURFACE_STEP_CAPS.generator,
    schema: DraftBatchLLMSchema,
    onToolEvent: input.onActivity,
  });

  // Prefer the strictly-validated object; if the model produced a batch that
  // didn't fully validate, salvage the valid cases/bugs from the raw text
  // (partial-batch acceptance) instead of dropping everything. Then null out
  // any bug→case links that point past the end of the cases array.
  const batch = clampBugLinks(r.ok ? r.object : salvageDraftBatch(r.text));
  return { batch, rawText: r.text, durationMs: Date.now() - start };
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

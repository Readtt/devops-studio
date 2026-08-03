import {
  SURFACE_STEP_CAPS,
  SURFACE_TOKEN_BUDGETS,
  type ModelId,
} from "@/modules/ai/config";
import type { ProviderKeys } from "@/modules/ai/lib/keyring";
import type { BudgetLimit } from "@/modules/ai/lib/runBudget";
import {
  runTask,
  streamTask,
  type TaskCheckpoint,
  type TaskUsage,
} from "@/modules/ai/lib/taskRunner";
import type { ModelMessage } from "ai";
import type { LocalProviderConfig } from "@/modules/ai/lib/agent";
import { buildSuiteChatTools } from "@/modules/test-plans/lib/suiteChatTools";
import {
  DraftBatchLLMSchema,
  clampBugLinks,
  salvageDraftBatch,
  type DraftBatchLLM,
} from "./draftBatchSchema";
import { QA_ANALYST_PROMPT } from "./qaAnalystPrompt";
import {
  isQuerySuite,
  renderRequirementBlock,
  type SuiteType,
  type TargetRequirement,
  type TestCaseRef,
} from "@/modules/ado";
import type { ActivityEntry } from "./activityLog";
import { renderRelatedCases, type RelatedCase } from "./relatedCases";
import {
  clipPromptText,
  collectContextImages,
  formatContextBlocks,
  type ContextBlock,
} from "@/modules/ai/lib/contextBlocks";

/** Legacy single-axis mode. Kept only so old saved drafts / history rows
 *  (which persisted this) still load — see {@link modeToAxes}. New code uses
 *  the two independent axes below. */
export type GenerationMode = "happy" | "thorough" | "bug-hunt";

/** Coverage depth — how wide the generated cases go. Orthogonal to bug
 *  suggestions (see RunInput.suggestBugs); the old combined "mode" picker
 *  squashed these two decisions into one, which is why it was split. */
export type Coverage = "happy" | "full";

/** Map a legacy 3-value mode onto the two-axis model so old saved drafts and
 *  history rows still load. Unknown / absent ⇒ the new default (full + bugs). */
export function modeToAxes(mode: string | null | undefined): {
  coverage: Coverage;
  suggestBugs: boolean;
} {
  switch (mode) {
    case "happy":
      return { coverage: "happy", suggestBugs: false };
    case "thorough":
      return { coverage: "full", suggestBugs: false };
    case "bug-hunt":
      return { coverage: "full", suggestBugs: true };
    default:
      return { coverage: "full", suggestBugs: true };
  }
}

/** Short human label for a (coverage, suggestBugs) pair — shown on history
 *  rows and the run preview. */
export function describeGeneration(
  coverage: Coverage,
  suggestBugs: boolean,
): string {
  const base = coverage === "happy" ? "Happy path" : "Full coverage";
  return suggestBugs ? `${base} + bug hunt` : base;
}

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
  /** Normalized suite type, so the prompt can name what kind of suite this is
   *  instead of letting the model draft into a target it can't publish to.
   *  Optional: older callers and fixtures predate it. */
  suiteType?: SuiteType;
  /** The work item a requirement-based suite tracks — non-null only for that
   *  suite type. Resolved fresh on every analyze, never persisted. */
  requirement?: TargetRequirement | null;
  /** Id of the tracked work item, straight off the suite ref. Carried
   *  separately from `requirement` because the body fetch can fail — and when
   *  it does we still want to tell the model which requirement it's blind to
   *  rather than silently dropping the whole block. */
  requirementId?: number | null;
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
  /** Coverage depth for the generated cases. */
  coverage: Coverage;
  /** Whether to also flag concrete bug suggestions. Independent of coverage. */
  suggestBugs: boolean;
  /** Provider keys hydrated from the OS keychain (chatStore.apiKeys). */
  keys: ProviderKeys;
  modelId: ModelId;
  /** Local-provider config (base URLs + model ids) so a local model resolves. */
  local?: LocalProviderConfig;
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
  /** User's freeform "Custom instructions" from Settings — appended to the
   *  system prompt on every surface. Empty/absent ⇒ base prompt unchanged. */
  customInstructions?: string;
  /** Abort handle threaded into the shared runner — cancelling actually stops
   *  the provider request (and billing), it doesn't just discard the result. */
  signal?: AbortSignal;
};

export type RunResult = {
  batch: DraftBatchLLM;
  rawText: string;
  durationMs: number;
  /** Whether the model returned a schema-valid batch. False when the runner
   *  had to salvage from raw text or the response was empty — callers use this
   *  to tell "the model genuinely found nothing" apart from "the response
   *  couldn't be read", which need different user-facing guidance. */
  ok: boolean;
  /** When `ok` is false: `empty` ⇒ the provider returned no usable text (common
   *  with OpenAI-compatible endpoints lacking JSON mode); `schema_violation` ⇒
   *  text came back but didn't match the expected shape; `step_cap` ⇒ the
   *  agentic loop ran into a run budget before writing its answer. */
  reason?: "schema_violation" | "empty" | "step_cap";
  /** Which budget guard bound the loop, when one did — tokens (the ration) or
   *  steps (the runaway ceiling). Lets the error panel name the right one
   *  instead of always blaming steps. */
  limit?: BudgetLimit;
  /** Agentic steps this call completed. Drives the checkpoint's cumulative
   *  step count. */
  stepsUsed?: number;
  /** Token usage this call accrued, when the provider reported it. */
  usage?: TaskUsage;
};

/** Everything the model call needs, with prompt assembly already done. Split
 *  out from execution so a run can be checkpointed BEFORE the provider is
 *  touched — and re-executed later from the persisted copy without re-running
 *  the ADO prefetch that produced it. */
export type PreparedAnalystRun = {
  modelId: ModelId;
  /** Fully assembled user turn: buildUserPrompt (or the refine override) plus
   *  any context blocks. */
  userPrompt: string;
  /** Session attachments merged with context-block images — the exact vision
   *  set the request carries. */
  attachments: RunAttachment[];
  sourceRoot: string | null;
  customInstructions?: string;
};

/** Pure prompt assembly — no keys, no network, no tool construction. */
export function prepareQaAnalystRun(input: RunInput): PreparedAnalystRun {
  const ctxText = formatContextBlocks(input.contextBlocks ?? []);
  const basePrompt = input.userPromptOverride ?? buildUserPrompt(input);
  const userPrompt = ctxText ? `${basePrompt}\n\n${ctxText}` : basePrompt;
  return {
    modelId: input.modelId,
    userPrompt,
    // Merge best-practice / bug-context images into the vision attachments so a
    // standards screenshot reaches the model the same way a dropped image does.
    attachments: [
      ...input.attachments,
      ...collectContextImages(input.contextBlocks ?? []),
    ],
    sourceRoot: input.sourceRoot ?? null,
    customInstructions: input.customInstructions,
  };
}

export type ExecuteAnalystOptions = {
  /** Provider keys hydrated from the OS keychain. Never persisted. */
  keys: ProviderKeys;
  local?: LocalProviderConfig;
  /** Runaway step ceiling. Defaults to SURFACE_STEP_CAPS.generator. */
  maxSteps?: number;
  /** Tokens this call may spend — the primary budget. Defaults to
   *  SURFACE_TOKEN_BUDGETS.generator; a resume passes a smaller top-up. */
  tokenBudget?: number;
  onActivity?: (e: ActivityEntry) => void;
  /** Fired after each completed agentic step so the caller can persist a
   *  resume point. Tool-bearing path only (tool-less runs are single-shot). */
  onCheckpoint?: (cp: TaskCheckpoint) => void;
  /** Liveness only — fires on the tool-bearing (streaming) path. */
  onText?: (delta: string) => void;
  /** Continuation transcript from an earlier attempt at this same run. */
  resumeMessages?: ModelMessage[];
  signal?: AbortSignal;
};

const NO_OP_TEXT = () => {};

export async function executeQaAnalystRun(
  prepared: PreparedAnalystRun,
  opts: ExecuteAnalystOptions,
): Promise<RunResult> {
  const start = Date.now();

  // Read-only source tools when code search is on — the analyzer can trace the
  // spec across real files instead of guessing from the prompt alone. SAFETY:
  // these are READ-ONLY (read_file / list_files / grep); the runner never
  // injects write/edit/bash tools.
  const tools = buildSuiteChatTools(prepared.sourceRoot);

  // Schema-validated, temperature-0 structured output via the shared runner.
  // With tools the runner runs the agentic read loop then validates the
  // model's final text against the schema; tool-less it uses generateObject.
  // Either way DraftBatchLLMSchema is enforced — which is why the
  // salvageDraftBatch fallback below exists for the validate-the-text path.
  const task = {
    modelId: prepared.modelId,
    keys: opts.keys,
    local: opts.local ?? {},
    systemPrompt: QA_ANALYST_PROMPT,
    customInstructions: prepared.customInstructions,
    prompt: prepared.userPrompt,
    attachments: prepared.attachments,
    tools: tools ?? null,
    temperature: 0,
    maxSteps: opts.maxSteps ?? SURFACE_STEP_CAPS.generator,
    tokenBudget: opts.tokenBudget ?? SURFACE_TOKEN_BUDGETS.generator,
    schema: DraftBatchLLMSchema,
    onToolEvent: opts.onActivity,
    onCheckpoint: opts.onCheckpoint,
    resumeMessages: opts.resumeMessages,
    signal: opts.signal,
  };
  // Stream only the tool-bearing path: it gets live text for the "still
  // writing" readout plus the runner's trailing-error salvage. The tool-less
  // path stays on runTask so schema+no-tools keeps hitting generateObject
  // (SDK-native JSON mode) — streaming it would regress OpenAI-compatible
  // endpoints that only produce a valid batch through structured output.
  const r = tools
    ? await streamTask({ ...task, onText: opts.onText ?? NO_OP_TEXT })
    : await runTask(task);

  // Prefer the strictly-validated object; if the model produced a batch that
  // didn't fully validate, salvage the valid cases/bugs from the raw text
  // (partial-batch acceptance) instead of dropping everything. Then null out
  // any bug→case links that point past the end of the cases array.
  const batch = clampBugLinks(r.ok ? r.object : salvageDraftBatch(r.text));
  return {
    batch,
    rawText: r.text,
    durationMs: Date.now() - start,
    ok: r.ok,
    reason: r.ok ? undefined : r.reason,
    limit: r.limit,
    stepsUsed: r.stepsUsed,
    usage: r.usage,
  };
}

export async function runQaAnalyst(input: RunInput): Promise<RunResult> {
  return executeQaAnalystRun(prepareQaAnalystRun(input), {
    keys: input.keys,
    local: input.local,
    onActivity: input.onActivity,
    signal: input.signal,
  });
}

function buildUserPrompt(input: RunInput): string {
  const coverageLine =
    input.coverage === "happy"
      ? "Coverage: happy path only — generate the main successful flows."
      : "Coverage: full — happy paths, edge cases, and negative / error paths.";
  const bugsLine = input.suggestBugs
    ? "Bug suggestions: ON — also flag concrete defect risks where the spec or readable code reveals a real bug (with codeRefs)."
    : "Bug suggestions: OFF — generate test cases only; do not propose bugs.";

  const existing = renderExistingCases(input.existingCaseTitles, input.existingCases);

  const attached =
    input.attachments.length === 0
      ? ""
      : "\n\nSource code attached for grounding:\n\n" +
        renderAttachmentBlocks(input.attachments);

  const targetBlock = renderTargetContext(input.targetContext);
  const relatedBlock = renderRelatedCases(input.relatedCases ?? []);
  const changesetsBlock = renderChangesetsBlock(input.changesets);

  return [
    coverageLine,
    bugsLine,
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
  // A query-based suite can't take hand-added cases at all. Say so rather than
  // letting the model draft confidently into an unpublishable target.
  const queryNote = isQuerySuite(ctx)
    ? "- NOTE: this is a query-based suite; Azure DevOps fills it from a work-item query and will not accept new cases."
    : null;
  const requirementBlock = renderRequirementBlock(ctx.requirement, {
    unresolvedId: ctx.requirementId ?? null,
  });
  return [
    "TARGET CONTEXT — these are the test plan and suite the cases will be",
    "published into. Cases inherit the default area / iteration unless your",
    "draft overrides them explicitly.",
    planLine,
    suiteLine,
    areaLine,
    iterLine,
    queryNote,
    requirementBlock ? `\n${requirementBlock}` : null,
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

/** Generous ceiling on the TOTAL text inlined from attachments in one run.
 *
 *  Dragging files in is the app's core workflow, so a dropped file that gets
 *  silently shortened means generating tests against code we never showed the
 *  model — invisible, and exactly the failure the feature exists to prevent.
 *  Ingest already caps each file at 200 KB but nothing caps the COUNT, so ~20
 *  files is a megabyte before a single tool runs. 400 KB is ~100k tokens, well
 *  past any normal drop, and the pre-run ContextMeter itemises attachments so
 *  the weight is visible before the request goes out.
 *
 *  When it does bite, no attachment is dropped: every one keeps its header and
 *  a truncated file says so by name, so the model knows what it is missing. */
export const ATTACHMENT_TEXT_BUDGET = 400 * 1024;

/** Render every attachment for the user prompt, spending a shared text budget
 *  in order. */
export function renderAttachmentBlocks(attachments: RunAttachment[]): string {
  let remaining = ATTACHMENT_TEXT_BUDGET;
  return attachments
    .map((a) => {
      if ((a.kind ?? "text") !== "text") return formatAttachmentBlock(a);
      const budget = Math.max(0, remaining);
      remaining -= a.content.length;
      if (a.content.length <= budget) return formatAttachmentBlock(a);
      const kept = clipPromptText(a.content, budget);
      const cut = a.content.length - kept.length;
      return (
        `--- ${a.path} ---\n${kept}\n` +
        `[TRUNCATED — ${cut} more characters of "${a.path}" were not included; this run's ` +
        `attachment budget of ${ATTACHMENT_TEXT_BUDGET} characters ran out. Read the file ` +
        `from the source directory if it lives there, or say what you're missing.]`
      );
    })
    .join("\n\n");
}

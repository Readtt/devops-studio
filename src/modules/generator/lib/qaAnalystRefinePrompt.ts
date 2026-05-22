// Builds the "follow-up" prompt the analyst sees on a refine call. The engine
// runs with the same system prompt, attachments, and tool access as the first
// pass — only the user-prompt body changes so the model knows it's iterating
// on a draft instead of starting fresh.
//
// The model receives:
//   1. The original requirements (still ground truth).
//   2. The CURRENT draft batch (kept + skipped cases/bugs) as JSON.
//   3. The user's follow-up instruction.
//   4. Instructions to return a FULL replacement batch — additive or
//      transformative as the instruction dictates.

import type { ReviewedBug, ReviewedCase } from "./draftBatchSchema";
import {
  renderChangesetsBlock,
  renderTargetContext,
  formatAttachmentBlock,
  type GenerationMode,
  type RunAttachment,
  type TargetContext,
} from "./qaAnalystRun";
import { renderRelatedCases, type RelatedCase } from "./relatedCases";
import { DraftBatchLLMSchema } from "./draftBatchSchema";

export type RefinePromptInput = {
  /** Original spec the first generation was anchored against. */
  requirements: string;
  attachments: RunAttachment[];
  mode: GenerationMode;
  targetContext?: TargetContext | null;
  relatedCases?: RelatedCase[];
  /** Cases the user has decided to keep — what they actually want to live
   *  with after the refine. Skipped cases are surfaced separately so the
   *  model knows the user's prior signal but doesn't think they're still
   *  in scope. */
  keptCases: ReviewedCase[];
  skippedCases: ReviewedCase[];
  keptBugs: ReviewedBug[];
  skippedBugs: ReviewedBug[];
  /** Same scope hint passed to the first-pass analyst. Stays in the refine
   *  prompt so the model keeps narrowing instead of fanning back out into
   *  full coverage on a follow-up. */
  changesets?: string;
  /** What the user asked for, verbatim. */
  instruction: string;
};

export function buildRefineUserPrompt(input: RefinePromptInput): string {
  const modeLine =
    input.mode === "happy"
      ? "Mode: happy — keep happy-path scope unless the follow-up expands it."
      : input.mode === "thorough"
        ? "Mode: thorough — happy + edge cases + negative paths, refined per the follow-up."
        : "Mode: bug-hunt — thorough plus actionable bug flags. Apply the follow-up.";

  const targetBlock = renderTargetContext(input.targetContext);
  const relatedBlock = renderRelatedCases(input.relatedCases ?? []);
  const changesetsBlock = renderChangesetsBlock(input.changesets);

  const currentBatch = {
    cases: input.keptCases.map(stripUiOnly),
    bugs: input.keptBugs.map(stripUiOnly),
  };
  const skippedBatch = {
    cases: input.skippedCases.map((c) => ({
      title: c.title,
      rationale: c.rationale,
    })),
    bugs: input.skippedBugs.map((b) => ({
      title: b.title,
      severity: b.severity,
    })),
  };

  const attached =
    input.attachments.length === 0
      ? ""
      : "\n\nSource code attached for grounding:\n\n" +
        input.attachments.map(formatAttachmentBlock).join("\n\n");

  return [
    modeLine,
    "",
    "MODE: REFINE — you are iterating on a draft batch the user is reviewing.",
    "Return a FULL, replacement DraftBatch JSON. Keep what still fits, edit",
    "what needs polish, add what the user asked for, drop what no longer",
    "applies. Do NOT include any case the user already decided to skip below.",
    "If the follow-up names a smoke-test or a specific step you can verify",
    "against the attached / readable source, do that verification and surface",
    "concrete bugs with codeRefs.",
    "",
    targetBlock,
    "Original feature requirements (ground truth):",
    input.requirements.trim() || "(no original spec — refine purely from the follow-up below)",
    "",
    relatedBlock || null,
    relatedBlock ? "" : null,
    changesetsBlock || null,
    changesetsBlock ? "" : null,
    "Current draft (kept by the user — your starting point):",
    "```json",
    JSON.stringify(currentBatch, null, 2),
    "```",
    skippedBatch.cases.length > 0 || skippedBatch.bugs.length > 0
      ? [
          "",
          "Already-rejected items (the user skipped these — do not regenerate):",
          "```json",
          JSON.stringify(skippedBatch, null, 2),
          "```",
        ].join("\n")
      : null,
    "",
    "USER FOLLOW-UP INSTRUCTION:",
    `"""${input.instruction.trim()}"""`,
    attached,
    "",
    "Return ONLY the DraftBatch JSON — no prose, no code fences. Schema:",
    JSON.stringify(REFINE_BATCH_SHAPE, null, 2),
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

/** Drop UI-only fields (uid, decision, similarMatches) before serializing so
 *  the model doesn't see internal state. The schema doesn't require these
 *  on input — the engine re-wraps the parsed batch into ReviewedCase/Bug. */
function stripUiOnly(
  item: ReviewedCase | ReviewedBug,
): Record<string, unknown> {
  const { uid: _uid, decision: _decision, ...rest } = item as ReviewedCase & {
    similarMatches?: unknown;
  };
  const cleaned = rest as Record<string, unknown>;
  delete cleaned.similarMatches;
  return cleaned;
}

// Lightweight shape hint for the refine output. Mirrors DRAFT_BATCH_SHAPE in
// qaAnalystRun.ts but trimmed — the schema parser is the real contract; this
// is just a reminder for the model. Referenced here so a schema change at
// least makes the prompt break loudly via TS.
const REFINE_BATCH_SHAPE = {
  cases: [
    {
      title: "[Area] When {action} then {result}",
      description: "Optional reviewer-facing context.",
      steps: [{ action: "…", expected: "…" }],
      tags: ["…"],
      rationale: "Why this case is in the refined batch.",
      sourceLinks: [],
    },
  ],
  bugs: [
    {
      title: "[Area] {symptom}",
      // reproSteps MUST use the labeled sections enforced by the system
      // prompt: PRECONDITION / STEPS TO REPRODUCE / EXPECTED RESULT /
      // ACTUAL RESULT / ENVIRONMENT — separated by blank lines.
      reproSteps:
        "PRECONDITION:\n…\n\nSTEPS TO REPRODUCE:\n1. …\n2. …\n\nEXPECTED RESULT:\n…\n\nACTUAL RESULT:\n…\n\nENVIRONMENT:\nn/a",
      severity: "1 - Critical | 2 - High | 3 - Medium | 4 - Low",
      linkedDraftCaseIndex: 0,
      codeRefs: [
        { file: "src/…", startLine: 1, endLine: 1, symbol: "…" },
      ],
    },
  ],
};

// Keep the schema import live so an accidental rename of DraftBatchLLMSchema
// surfaces as a TS error in this file too — refine and analyze must speak
// the same schema or the parser will silently drop the result.
void DraftBatchLLMSchema;

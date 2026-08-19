import { z } from "zod";
import {
  completeItemsOfTruncatedArray,
  extractJsonBlock,
} from "@/modules/ai/lib/extractJson";
import type { ExecutionOutcome } from "@/modules/ado";
import type { ConfidenceVerdict } from "@/modules/test-plans/lib/confidence";

export const TestStepDraftSchema = z.object({
  action: z.string().min(1),
  expected: z.string().min(1),
});

export const DraftSourceLinkSchema = z.object({
  /** @deprecated The repo now comes from `filePath`'s `<repo>/…` prefix, and
   *  the prompt no longer asks for this — but drafts generated before that
   *  change still carry it, and it is the fallback when a path arrives with no
   *  prefix. REQUIRED until the prompts stopped asking: a required field the
   *  model was told to omit fails `DraftCaseLLMSchema`, and a case that fails
   *  it is dropped by the salvager with only a console.error. */
  repoName: z.string().nullable().optional(),
  /** Optional repo id; if absent we fall back to the resolved repo name. */
  repoId: z.string().nullable().optional(),
  /** `<repo>/<path within repo>`, as the read tools reported it. */
  filePath: z.string(),
  symbol: z.string().nullable().optional(),
  lineRange: z
    .object({ start: z.number().int(), end: z.number().int() })
    .nullable()
    .optional(),
});
export type DraftSourceLink = z.infer<typeof DraftSourceLinkSchema>;

export const DraftCaseLLMSchema = z.object({
  title: z.string().min(8).max(160),
  description: z.string().default(""),
  steps: z.array(TestStepDraftSchema).min(1).max(12),
  tags: z.array(z.string()).default([]),
  areaPath: z.string().nullable().optional(),
  iterationPath: z.string().nullable().optional(),
  rationale: z.string().default(""),
  /** Links to attached source files. The publisher persists these in the
   *  description's source-links block (Phase 7). */
  sourceLinks: z.array(DraftSourceLinkSchema).default([]),
});

/** Code anchor a bug-suggestion model can emit when it grounded the bug in
 *  actual source. Mirrors the existing CodeLink shape used by cases so the
 *  publish path can format both through the shared HTML emitter. */
export const DraftBugCodeRefSchema = z.object({
  /** `<repo>/<path within repo>`, as the read tools reported it. */
  file: z.string().min(1),
  startLine: z.number().int().nonnegative(),
  endLine: z.number().int().nonnegative().nullable().optional(),
  /** Optional human-readable anchor inside the file, e.g. "LoginController.Authenticate". */
  symbol: z.string().nullable().optional(),
});
export type DraftBugCodeRef = z.infer<typeof DraftBugCodeRefSchema>;

export const DraftBugLLMSchema = z.object({
  title: z.string().min(8).max(160),
  reproSteps: z.string().min(1),
  severity: z.enum(["1 - Critical", "2 - High", "3 - Medium", "4 - Low"]),
  /** Index into DraftBatch.cases that this bug attaches to, if any. */
  linkedDraftCaseIndex: z.number().int().nonnegative().nullable().optional(),
  /** Source anchors the analyst found while investigating. Embedded as a
   *  parseable HTML comment block on the published bug's reproSteps so the
   *  client can later render them as clickable code-viewer chips. */
  codeRefs: z.array(DraftBugCodeRefSchema).default([]),
});

export const DraftBatchLLMSchema = z.object({
  cases: z.array(DraftCaseLLMSchema).default([]),
  bugs: z.array(DraftBugLLMSchema).default([]),
});

export type TestStepDraft = z.infer<typeof TestStepDraftSchema>;
export type DraftCaseLLM = z.infer<typeof DraftCaseLLMSchema>;
export type DraftBugLLM = z.infer<typeof DraftBugLLMSchema>;
export type DraftBatchLLM = z.infer<typeof DraftBatchLLMSchema>;

export type SimilarMatch = {
  caseId: number;
  title: string;
  score: number;
};

/** Per-case UI state in the review phase. */
export type ReviewedCase = DraftCaseLLM & {
  /** Stable id within this session. */
  uid: string;
  /** Inclusion decision from the reviewer. */
  decision: "keep" | "skip";
  /** Existing cases with high title similarity (Jaro-Winkler ≥ 0.85). */
  similarMatches: SimilarMatch[];
  /** Run outcome the reviewer picked for this case. Recorded against the
   *  case's test point right after publish. Excludes "Active" — undefined
   *  means "leave unset / not run". */
  desiredOutcome?: Exclude<ExecutionOutcome, "Active">;
  /** AI confidence verdict for this draft case. Persists in the draft payload
   *  so it survives reopening a run from generation history. */
  verdict?: ConfidenceVerdict;
  /** True when `desiredOutcome` was set automatically from the confidence
   *  verdict rather than chosen by the reviewer. A manual pick clears it so a
   *  later re-evaluation can't stomp the reviewer's choice. */
  outcomeAuto?: boolean;
  /** When set, publish UPDATES this existing ADO case (title + steps +
   *  description) in place instead of creating a new one — chosen by the
   *  reviewer from a strong similarity match. */
  updateTargetCaseId?: number | null;
};

export type ReviewedBug = DraftBugLLM & {
  uid: string;
  decision: "keep" | "skip";
  /** ADO identity (unique name / email) the published bug is assigned to. Set
   *  via the review-phase developer picker; undefined leaves it unassigned. */
  assignedTo?: string | null;
};

/** Pull the JSON object out of a (possibly fenced/prose-wrapped) model
 *  response. Re-exported from the shared helper so the generator keeps one
 *  import name; the slicing logic lives in one place now. */
export const extractBatchJson = extractJsonBlock;

/** Parse a model batch response into a validated DraftBatch. Permissive by
 *  design — an unparseable/invalid response yields an empty batch rather than
 *  crashing the review UI — but it now logs the failure so "the model
 *  generated nothing" can be distinguished from "the model returned malformed
 *  JSON" when debugging. */
export function parseDraftBatch(text: string): DraftBatchLLM {
  const candidate = extractBatchJson(text.trim());
  try {
    return DraftBatchLLMSchema.parse(JSON.parse(candidate));
  } catch (e) {
    console.warn("[generator] could not parse model batch response:", e);
    return { cases: [], bugs: [] };
  }
}

/** Lenient fallback used when strict whole-batch validation fails: pull the
 *  JSON out of the (possibly fenced/prose-wrapped) text, then `safeParse` each
 *  case/bug INDIVIDUALLY — keeping every valid item and dropping only the
 *  malformed ones (logged by index). One bad case no longer zeroes the whole
 *  batch. A batch cut off mid-structure (`finish: length`) doesn't JSON.parse
 *  at all, so that path walks the arrays element-by-element instead — the
 *  complete cases that arrived before the cut are kept, and only the object
 *  the cut landed in is lost. Never throws; returns an empty batch when
 *  nothing parses. */
export function salvageDraftBatch(text: string): DraftBatchLLM {
  const candidate = extractBatchJson(text.trim());
  let obj: unknown;
  try {
    obj = JSON.parse(candidate);
  } catch {
    // Scan the RAW text, not `candidate`: extractJsonBlock needs a closing
    // fence / closing brace to slice well, and truncated output has neither.
    // The scanner keys on `"cases": [` itself, so leading prose or an
    // unterminated fence in front of it doesn't matter.
    return {
      cases: salvageItems(
        completeItemsOfTruncatedArray(text, "cases"),
        DraftCaseLLMSchema,
        "case",
      ),
      bugs: salvageItems(
        completeItemsOfTruncatedArray(text, "bugs"),
        DraftBugLLMSchema,
        "bug",
      ),
    };
  }
  if (!obj || typeof obj !== "object") return { cases: [], bugs: [] };
  const rec = obj as { cases?: unknown; bugs?: unknown };
  return {
    cases: salvageItems(rec.cases, DraftCaseLLMSchema, "case"),
    bugs: salvageItems(rec.bugs, DraftBugLLMSchema, "bug"),
  };
}

function salvageItems<T>(
  value: unknown,
  schema: z.ZodType<T>,
  label: string,
): T[] {
  if (!Array.isArray(value)) return [];
  const out: T[] = [];
  const dropped: number[] = [];
  value.forEach((item, i) => {
    const r = schema.safeParse(item);
    if (r.success) out.push(r.data);
    else dropped.push(i);
  });
  if (dropped.length > 0) {
    console.error(
      `[generator] dropped ${dropped.length} invalid ${label}(s) at index ${dropped.join(", ")}`,
    );
  }
  return out;
}

/** Null out any `linkedDraftCaseIndex` that points outside the cases array — a
 *  bug linked to a non-existent draft case would otherwise mis-attach (or
 *  crash) at publish time. Logs each dropped link. */
export function clampBugLinks(batch: DraftBatchLLM): DraftBatchLLM {
  const n = batch.cases.length;
  let dropped = 0;
  const bugs = batch.bugs.map((b) => {
    const idx = b.linkedDraftCaseIndex;
    if (idx != null && (idx < 0 || idx >= n)) {
      dropped++;
      return { ...b, linkedDraftCaseIndex: null };
    }
    return b;
  });
  if (dropped > 0) {
    console.error(
      `[generator] dropped ${dropped} out-of-range bug→case link(s) (cases: ${n})`,
    );
  }
  return { cases: batch.cases, bugs };
}

// What a refine changed, and how that history is told to the model.
//
// The pairing half was lifted out of RefineChangesPanel, which rendered it for
// the user and was the only thing that knew it. The review pane shows a "Last
// refine" diff and a round-by-round thinking history; none of it reached the
// model, so every follow-up re-argued from a draft with no account of how it
// got that way. Same computation, two consumers now: the panel and the prompts.
//
// Cases and bugs are paired by TITLE. A refine rebuilds the whole batch, so
// array position means nothing across a round, and a renamed item reads as one
// removed plus one added — honest rather than guessed.

import type { ReviewedBug, ReviewedCase } from "./draftBatchSchema";
import type { RefineRound } from "./history";

/** Title comparison key. Exported because the panel matches restored items
 *  against the live draft with the same rule the pairing uses. */
export const norm = (s: string) => s.trim().toLowerCase();

function stepsChanged(a: ReviewedCase, b: ReviewedCase): boolean {
  if (a.steps.length !== b.steps.length) return true;
  for (let i = 0; i < a.steps.length; i++) {
    if (a.steps[i].action !== b.steps[i].action) return true;
    if (a.steps[i].expected !== b.steps[i].expected) return true;
  }
  return false;
}

export function caseFieldChanges(a: ReviewedCase, b: ReviewedCase) {
  // Serialized rather than joined on a separator. The version this was lifted
  // from joined on a literal NUL byte — correct (no tag can contain one, so
  // ["a b"] and ["a","b"] stay distinct) and invisible, but it made ripgrep
  // classify the whole file as binary, so every grep-backed search in the repo
  // skipped it without saying so. JSON gives the same distinctness in text.
  const tagsKey = (c: ReviewedCase) =>
    JSON.stringify([...(c.tags ?? [])].sort());
  return {
    description: a.description !== b.description,
    steps: stepsChanged(a, b),
    rationale: (a.rationale ?? "") !== (b.rationale ?? ""),
    tags: tagsKey(a) !== tagsKey(b),
    areaPath: (a.areaPath ?? "") !== (b.areaPath ?? ""),
    iterationPath: (a.iterationPath ?? "") !== (b.iterationPath ?? ""),
  };
}

function caseChanged(a: ReviewedCase, b: ReviewedCase): boolean {
  const ch = caseFieldChanges(a, b);
  return (
    ch.description ||
    ch.steps ||
    ch.rationale ||
    ch.tags ||
    ch.areaPath ||
    ch.iterationPath
  );
}

export function pairCases(before: ReviewedCase[], after: ReviewedCase[]) {
  const pool = new Map<string, ReviewedCase[]>();
  for (const item of before) {
    const k = norm(item.title);
    const arr = pool.get(k);
    if (arr) arr.push(item);
    else pool.set(k, [item]);
  }
  const added: ReviewedCase[] = [];
  const modified: { before: ReviewedCase; after: ReviewedCase }[] = [];
  for (const a of after) {
    const prev = pool.get(norm(a.title))?.shift();
    if (!prev) added.push(a);
    else if (caseChanged(prev, a)) modified.push({ before: prev, after: a });
  }
  const removed: ReviewedCase[] = [];
  for (const arr of pool.values()) removed.push(...arr);
  return { added, removed, modified };
}

/** The bug's parent case title, resolved through the cases array it indexes.
 *  We compare parents by TITLE (not raw index) because a refine rebuilds the
 *  cases array — the same index can point at a different case before/after. */
export function parentTitleOf(
  bug: ReviewedBug,
  cs: ReviewedCase[],
): string | null {
  const i = bug.linkedDraftCaseIndex;
  return i != null && i >= 0 && i < cs.length ? cs[i].title : null;
}

/** Re-point a snapshot bug's parent link at the LIVE cases array before
 *  restoring it — the index it carried referenced the snapshot's array, which
 *  the refine has since rebuilt. Matches the parent by title; nulls the link
 *  when that case no longer exists in the current draft. */
export function relinkForCurrent(
  bug: ReviewedBug,
  snapshotCases: ReviewedCase[],
  currentCases: ReviewedCase[],
): ReviewedBug {
  const parentTitle = parentTitleOf(bug, snapshotCases);
  if (parentTitle == null) return { ...bug, linkedDraftCaseIndex: null };
  const i = currentCases.findIndex((c) => norm(c.title) === norm(parentTitle));
  return { ...bug, linkedDraftCaseIndex: i >= 0 ? i : null };
}

export type BugMod = {
  before: ReviewedBug;
  after: ReviewedBug;
  beforeParentTitle: string | null;
  afterParentTitle: string | null;
};

export function pairBugs(
  before: ReviewedBug[],
  after: ReviewedBug[],
  beforeCases: ReviewedCase[],
  afterCases: ReviewedCase[],
) {
  const pool = new Map<string, ReviewedBug[]>();
  for (const item of before) {
    const k = norm(item.title);
    const arr = pool.get(k);
    if (arr) arr.push(item);
    else pool.set(k, [item]);
  }
  const added: ReviewedBug[] = [];
  const modified: BugMod[] = [];
  for (const a of after) {
    const prev = pool.get(norm(a.title))?.shift();
    if (!prev) {
      added.push(a);
      continue;
    }
    const beforeParentTitle = parentTitleOf(prev, beforeCases);
    const afterParentTitle = parentTitleOf(a, afterCases);
    // Catch the small-but-real changes a refine can make: a re-link to a
    // different parent case, or a change to the grounded code refs — not just
    // the repro text and severity.
    const relinked =
      norm(beforeParentTitle ?? "") !== norm(afterParentTitle ?? "");
    const codeRefsChanged =
      JSON.stringify(prev.codeRefs ?? []) !== JSON.stringify(a.codeRefs ?? []);
    if (
      prev.reproSteps !== a.reproSteps ||
      prev.severity !== a.severity ||
      relinked ||
      codeRefsChanged
    ) {
      modified.push({
        before: prev,
        after: a,
        beforeParentTitle,
        afterParentTitle,
      });
    }
  }
  const removed: ReviewedBug[] = [];
  for (const arr of pool.values()) removed.push(...arr);
  return { added, removed, modified };
}

// --- The model-facing block -------------------------------------------------

/** Rounds shown to the model. Older ones matter less and every round costs
 *  tokens on a prompt that is rebuilt each time anyway. */
const MAX_ROUNDS_IN_PROMPT = 8;
/** Per-instruction clamp. A preset chip pastes a paragraph; the gist is enough
 *  for the model to know it was already asked. */
const MAX_INSTRUCTION_CHARS = 240;

function clamp(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function titleList(titles: string[], max = 4): string {
  const shown = titles.slice(0, max).map((t) => `"${clamp(t, 90)}"`);
  const rest = titles.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} (+${rest} more)` : shown.join(", ");
}

/** What the most recent round actually did to the batch, from the undo
 *  snapshot the store keeps for the "Last refine" panel. Counts alone ("7 → 7
 *  cases") hide a round that reworked every case without changing how many
 *  there are, which is the most common kind of follow-up there is. */
function renderLastChanges(
  snapshot: { cases: ReviewedCase[]; bugs: ReviewedBug[] } | null | undefined,
  cases: ReviewedCase[],
  bugs: ReviewedBug[],
): string[] {
  if (!snapshot) return [];
  const c = pairCases(snapshot.cases, cases);
  const b = pairBugs(snapshot.bugs, bugs, snapshot.cases, cases);
  const bits: string[] = [];
  if (c.added.length)
    bits.push(`added cases ${titleList(c.added.map((x) => x.title))}`);
  if (c.removed.length)
    bits.push(`removed cases ${titleList(c.removed.map((x) => x.title))}`);
  if (c.modified.length)
    bits.push(`reworked cases ${titleList(c.modified.map((x) => x.after.title))}`);
  if (b.added.length)
    bits.push(`added bugs ${titleList(b.added.map((x) => x.title))}`);
  if (b.removed.length)
    bits.push(`removed bugs ${titleList(b.removed.map((x) => x.title))}`);
  if (b.modified.length)
    bits.push(`reworked bugs ${titleList(b.modified.map((x) => x.after.title))}`);
  return bits.length > 0 ? [`    changed: ${bits.join("; ")}`] : [];
}

export type RefineHistoryInput = {
  rounds: RefineRound[];
  /** The batch as it stood before the most recent round — the store's undo
   *  point, which is exactly the "before" side of the Last refine diff. */
  lastSnapshot?: { cases: ReviewedCase[]; bugs: ReviewedBug[] } | null;
  cases: ReviewedCase[];
  bugs: ReviewedBug[];
};

/** The review pane's follow-up history, rendered for the model.
 *
 *  The user can see all of this on screen — a list of past follow-ups, a
 *  per-round thinking log, and a diff of what the last one changed — and
 *  reported that "none of this gets passed to the model". It wasn't: every
 *  round arrived as the spec, the current draft, and one new instruction, so a
 *  follow-up meaning "no, not like that" had nothing to be relative to, and a
 *  round could cheerfully undo the round before it.
 *
 *  Returns "" when there is no history, so a first refine sends exactly what it
 *  sends today. */
export function renderRefineHistory(input: RefineHistoryInput): string {
  const rounds = input.rounds.slice(-MAX_ROUNDS_IN_PROMPT);
  if (rounds.length === 0) return "";

  const dropped = input.rounds.length - rounds.length;
  const lines: string[] = [
    "REFINE HISTORY (what this draft has already been asked for, oldest first)",
  ];
  if (dropped > 0) {
    lines.push(
      `  (${dropped} earlier round${dropped === 1 ? "" : "s"} omitted)`,
    );
  }
  rounds.forEach((r, i) => {
    const ordinal = dropped + i + 1;
    lines.push(
      `  Round ${ordinal}: "${clamp(r.instruction, MAX_INSTRUCTION_CHARS)}"`,
    );
    const outcome =
      r.outcome === "ok"
        ? `${r.beforeCases} → ${r.afterCases} cases, ${r.beforeBugs} → ${r.afterBugs} bugs`
        : r.outcome === "empty"
          ? "returned nothing — the draft was left as it was"
          : `failed — the draft was left as it was${
              r.error ? ` (${clamp(r.error, 120)})` : ""
            }`;
    lines.push(`    ${outcome}`);
    // Only the newest round has a snapshot to diff against; earlier ones are
    // summarized by their counts, which is all that survives on the round.
    if (i === rounds.length - 1 && r.outcome === "ok") {
      lines.push(
        ...renderLastChanges(input.lastSnapshot, input.cases, input.bugs),
      );
    }
  });
  lines.push(
    "",
    "Treat this as decisions already made. Do not redo what an earlier round",
    "did, and do not quietly revert it — only the new follow-up below can",
    "change an earlier one's outcome, and only where it says so.",
  );
  return lines.join("\n");
}

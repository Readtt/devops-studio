import type { ExecutionOutcome } from "@/modules/ado";
import type { ConfidenceVerdict } from "@/modules/test-plans/lib/confidence";
import { outcomeFromVerdict } from "./confidenceOutcome";
import type { ReviewedBug, ReviewedCase } from "./draftBatchSchema";

/**
 * The run outcome a case should default to, given whether it has a kept bug
 * attached and its confidence verdict.
 *
 * A filed bug is concrete evidence the test failed, so it **outweighs** a
 * verdict-predicted Pass — a case with an attached bug defaults to Failed even
 * if the model thought it would pass. Without a bug we fall back to the verdict
 * (the existing auto-outcome), and to nothing when neither is decisive.
 */
export function autoOutcomeForCase(
  hasKeptBug: boolean,
  verdict?: ConfidenceVerdict,
): Exclude<ExecutionOutcome, "Active"> | null {
  if (hasKeptBug) return "Failed";
  // outcomeFromVerdict unconditionally reads verdict.predictedOutcome, so the
  // undefined guard here is required, not cosmetic.
  if (!verdict) return null;
  return outcomeFromVerdict(verdict);
}

/**
 * Recompute the auto-managed run outcome for every case from the current
 * cases + bugs. Run this after any change to a bug's keep/skip decision, its
 * parent link, or a case's verdict.
 *
 * Rules:
 * - A case "has a kept bug" when some bug with `decision === "keep"` points at
 *   its index via `linkedDraftCaseIndex`. This mirrors the
 *   `linkedKeptBugsByCaseIndex` grouping the review UI uses, so the picker and
 *   the `PassedWithBugWarning` always agree. `linkedDraftCaseIndex` indexes the
 *   full cases array, so position `i` is the correct key.
 * - Only "auto-managed" cases are touched: those with no outcome yet, or whose
 *   outcome was itself auto-set (`outcomeAuto === true`). A manual pick
 *   (`outcomeAuto === false` with a defined outcome) is never overwritten.
 * - When the auto outcome resolves to nothing (no bug, no decisive verdict) an
 *   auto case is cleared back to unset.
 *
 * Returns the SAME `cases` array reference when nothing changed, so callers
 * (and React) don't see a spurious update on every unrelated bug toggle.
 */
export function reconcileAutoOutcomes(
  cases: ReviewedCase[],
  bugs: ReviewedBug[],
): ReviewedCase[] {
  let changed = false;
  const next = cases.map((c, i) => {
    const hasKeptBug = bugs.some(
      (b) => b.decision === "keep" && b.linkedDraftCaseIndex === i,
    );
    const isAutoManaged =
      c.desiredOutcome === undefined || c.outcomeAuto === true;
    if (!isAutoManaged) return c;

    const auto = autoOutcomeForCase(hasKeptBug, c.verdict);
    if (auto === null) {
      // Already clear — leave the object identity untouched.
      if (c.desiredOutcome === undefined && !c.outcomeAuto) return c;
      changed = true;
      return { ...c, desiredOutcome: undefined, outcomeAuto: false };
    }
    if (c.desiredOutcome === auto && c.outcomeAuto === true) return c;
    changed = true;
    return { ...c, desiredOutcome: auto, outcomeAuto: true };
  });
  return changed ? next : cases;
}

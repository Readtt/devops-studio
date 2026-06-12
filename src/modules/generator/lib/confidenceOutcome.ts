import type { ExecutionOutcome } from "@/modules/ado";
import type { ConfidenceVerdict } from "@/modules/test-plans/lib/confidence";

/** Confidence threshold (0–100) at/above which a predicted Pass auto-marks the
 *  case Passed. Below it we leave the outcome unset so a human decides. */
export const AUTO_PASS_THRESHOLD = 80;

/**
 * Map a confidence verdict to the run outcome it implies, or `null` when the
 * verdict isn't decisive enough to auto-set one.
 *
 * - `Pass` only auto-passes at high confidence (>= AUTO_PASS_THRESHOLD) — a
 *   shaky pass prediction shouldn't silently flip a case to Passed.
 * - `Fail` / `Blocked` map directly regardless of likelihood: a predicted
 *   failure is worth surfacing even when the model is only moderately sure, so
 *   the reviewer notices and looks.
 * - `Unknown` (and a low-confidence Pass) return null — leave it to the human.
 */
export function outcomeFromVerdict(
  verdict: ConfidenceVerdict,
): Exclude<ExecutionOutcome, "Active"> | null {
  switch (verdict.predictedOutcome) {
    case "Pass":
      return verdict.passLikelihood >= AUTO_PASS_THRESHOLD ? "Passed" : null;
    case "Fail":
      return "Failed";
    case "Blocked":
      return "Blocked";
    default:
      return null;
  }
}

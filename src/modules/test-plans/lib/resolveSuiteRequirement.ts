// Resolve the work item a suite tracks, for surfaces that hold a plan/suite id
// but not the suite object.
//
// The generator and Suite Chat both already have the SuiteRef in hand from
// their own listSuites call, so they resolve inline. Confidence doesn't — it's
// driven from a case tab and from a bulk runner that only carry ids — and
// without this it was the one AI surface grading a requirement-bound case with
// no idea what the requirement said.

import {
  getBug,
  isRequirementSuite,
  listSuites,
  toTargetRequirement,
  type TargetRequirement,
} from "@/modules/ado";

export type SuiteRequirement = {
  /** Null when the suite isn't requirement-based, or the body fetch failed. */
  requirement: TargetRequirement | null;
  /** Tracked work-item id. Non-null for a requirement suite even when the body
   *  fetch failed, so the prompt can name what it couldn't read. */
  requirementId: number | null;
};

const EMPTY: SuiteRequirement = { requirement: null, requirementId: null };

/**
 * Best-effort: every failure degrades to "no requirement" rather than breaking
 * the caller's run. A confidence verdict without the requirement is worse than
 * one with it, but far better than no verdict at all.
 */
export async function resolveSuiteRequirement(
  planId: number | null | undefined,
  suiteId: number | null | undefined,
): Promise<SuiteRequirement> {
  if (planId == null || suiteId == null) return EMPTY;
  try {
    const suites = await listSuites(planId);
    const suite = suites.find((s) => s.id === suiteId);
    if (!suite || !isRequirementSuite(suite) || suite.requirementId == null) {
      return EMPTY;
    }
    const requirementId = suite.requirementId;
    const requirement = await getBug(requirementId)
      .then(toTargetRequirement)
      .catch(() => null);
    return { requirement, requirementId };
  } catch {
    return EMPTY;
  }
}

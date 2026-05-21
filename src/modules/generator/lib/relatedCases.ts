// Cross-suite case lookups. Used by the QA analyst to surface case titles
// from neighboring suites in the same plan as low-priority context — the
// model can spot patterns ("the existing Login suite has a TOTP fallback
// case so we should mirror it") without treating the sibling cases as
// gospel. The spec / feature requirements still take precedence.

import { listSuiteCases, listSuites, type SuiteRef } from "@/modules/ado";

export type RelatedCase = {
  id: number;
  title: string;
  suiteName: string;
  suiteId: number;
};

type Budget = {
  /** How many sibling suites to read from. */
  suites: number;
  /** How many cases to pull from each suite. */
  casesPerSuite: number;
  /** Hard cap on the total list. Cheap insurance against very large plans. */
  totalCases: number;
};

const DEFAULT_BUDGET: Budget = { suites: 8, casesPerSuite: 5, totalCases: 30 };

/**
 * Fetch case titles from suites *adjacent* to the target — true siblings
 * (sharing a parent) come first, then everything else ordered by suite id.
 * Reads are parallelized inside the budget so a plan with 50 suites doesn't
 * stall the analyze step on a sequential chain of ADO round-trips.
 *
 * Non-fatal by design: ADO read failures are swallowed per-suite so a single
 * permission hiccup can't take the whole context block down.
 */
export async function fetchRelatedCaseTitles(
  planId: number,
  targetSuiteId: number,
  budget: Budget = DEFAULT_BUDGET,
): Promise<RelatedCase[]> {
  let suites: SuiteRef[];
  try {
    suites = await listSuites(planId);
  } catch {
    return [];
  }
  const target = suites.find((s) => s.id === targetSuiteId);
  const targetParent = target?.parentSuiteId ?? null;
  const candidates = suites
    .filter((s) => s.id !== targetSuiteId)
    .sort((a, b) => {
      const aSib = a.parentSuiteId === targetParent ? 0 : 1;
      const bSib = b.parentSuiteId === targetParent ? 0 : 1;
      if (aSib !== bSib) return aSib - bSib;
      return a.id - b.id;
    })
    .slice(0, budget.suites);

  if (candidates.length === 0) return [];

  const fetched = await Promise.all(
    candidates.map(async (s) => {
      try {
        const cases = await listSuiteCases(planId, s.id);
        return {
          suite: s,
          cases: cases.slice(0, budget.casesPerSuite),
        };
      } catch {
        return null;
      }
    }),
  );

  const out: RelatedCase[] = [];
  for (const item of fetched) {
    if (!item) continue;
    for (const c of item.cases) {
      if (out.length >= budget.totalCases) break;
      out.push({
        id: c.id,
        title: c.title,
        suiteName: item.suite.name,
        suiteId: item.suite.id,
      });
    }
    if (out.length >= budget.totalCases) break;
  }
  return out;
}

/** Format the related-case list as a prompt block. Returns "" when empty so
 *  callers can drop it cleanly. The header explicitly downgrades these to
 *  reference material — the spec is still ground truth. */
export function renderRelatedCases(related: RelatedCase[]): string {
  if (related.length === 0) return "";
  const grouped = new Map<number, { suiteName: string; cases: RelatedCase[] }>();
  for (const r of related) {
    const bucket = grouped.get(r.suiteId);
    if (bucket) bucket.cases.push(r);
    else grouped.set(r.suiteId, { suiteName: r.suiteName, cases: [r] });
  }
  const body = Array.from(grouped.values())
    .map((g) => {
      const head = `  [${g.suiteName}]`;
      const items = g.cases.map((c) => `    #${c.id}: ${c.title}`).join("\n");
      return `${head}\n${items}`;
    })
    .join("\n");
  return [
    "RELATED TEST CASES — read for pattern awareness only.",
    "These come from neighboring suites in the same plan. They may be",
    "outdated or wrong, and they do NOT override the feature spec below.",
    "Use them to: stay consistent with existing naming, avoid silent",
    "coverage gaps, and notice when the spec extends an existing surface.",
    "If the spec contradicts a related case, follow the spec.",
    "",
    body,
  ].join("\n");
}

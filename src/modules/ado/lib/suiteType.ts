// Suite-type vocabulary shared by every surface that touches a suite: the
// plans tree, the generator, Suite Chat, workspace search, and the command
// palette. It lives in `modules/ado` rather than `modules/test-plans` because
// all of those import from here already.
//
// Azure DevOps has three suite types and they are NOT interchangeable:
//   - static        — an explicit list of cases. What this app assumed forever.
//   - requirement   — bound to a backlog work item. Cases added to it are
//                     auto-linked "Tested By"; that link is the ONLY way ADO
//                     does requirement traceability.
//   - query/dynamic — filled by a WIQL query and strictly READ-ONLY. ADO
//                     rejects manual add and remove.

/** Every value ADO's `TestSuiteType` can take, plus our own `unknown`. */
export const SUITE_TYPES = [
  "none",
  "dynamicTestSuite",
  "staticTestSuite",
  "requirementTestSuite",
  "unknown",
] as const;
export type SuiteType = (typeof SUITE_TYPES)[number];

type SuiteTypeLike = { suiteType?: SuiteType | string | null };

/**
 * The ONE case-insensitive comparison in the codebase.
 *
 * Reads come back camelCase (`requirementTestSuite`) but our creates send
 * PascalCase (`StaticTestSuite`) and ADO accepts both. Rust normalizes on
 * ingest, but persisted generator drafts and history rows can still carry a raw
 * ADO string, so every consumer routes through here rather than comparing
 * strings directly.
 */
export function normalizeSuiteType(raw: string | null | undefined): SuiteType {
  const s = (raw ?? "").trim().toLowerCase();
  for (const t of SUITE_TYPES) {
    if (t.toLowerCase() === s) return t;
  }
  return "unknown";
}

function typeOf(s: SuiteTypeLike): SuiteType {
  return normalizeSuiteType(s.suiteType);
}

export function isStaticSuite(s: SuiteTypeLike): boolean {
  return typeOf(s) === "staticTestSuite";
}
export function isRequirementSuite(s: SuiteTypeLike): boolean {
  return typeOf(s) === "requirementTestSuite";
}
export function isQuerySuite(s: SuiteTypeLike): boolean {
  return typeOf(s) === "dynamicTestSuite";
}

export type SuiteCapabilities = {
  /** Publish, generate, or chat-create cases into it. False for query suites —
   *  ADO rejects manual add on a dynamic suite with an opaque server error. */
  canAddCases: boolean;
  canRemoveCases: boolean;
  /** Create a child suite under it. ADO only nests under static suites. */
  canNestSuites: boolean;
  /** PATCH the name. ADO derives a requirement suite's name from its work item. */
  canRename: boolean;
  /** Micro-badge text for the tree, or null when the type needs no marking. */
  badge: "REQ" | "QUERY" | null;
  /** Human label for prose. */
  label: string;
};

const STATIC_CAPS: SuiteCapabilities = {
  canAddCases: true,
  canRemoveCases: true,
  canNestSuites: true,
  canRename: true,
  badge: null,
  label: "Static",
};

/**
 * What Azure DevOps permits on a suite of this type.
 *
 * One table, read by the tree's context menu, the generator's target picker,
 * Suite Chat, the command palette, and the test-plans store — so a wrong
 * assumption about ADO is a one-line fix in one file instead of a hunt through
 * five. `canAddCases: false` for query suites is documented and certain;
 * `canNestSuites` / `canRename` for requirement suites are inferred from ADO's
 * own UI, not from the REST contract.
 *
 * `unknown` and `none` are PERMISSIVE on purpose: a suite type we failed to
 * parse degrades to the app's previous behaviour rather than locking the user
 * out of a suite they can actually use. Never gate on ignorance.
 */
export function suiteCapabilities(s: SuiteTypeLike): SuiteCapabilities {
  switch (typeOf(s)) {
    case "requirementTestSuite":
      return {
        canAddCases: true,
        canRemoveCases: true,
        canNestSuites: false,
        canRename: false,
        badge: "REQ",
        label: "Requirement-based",
      };
    case "dynamicTestSuite":
      return {
        canAddCases: false,
        canRemoveCases: false,
        canNestSuites: false,
        canRename: true,
        badge: "QUERY",
        label: "Query-based",
      };
    default:
      return STATIC_CAPS;
  }
}

/** Why an action is unavailable on this suite, phrased for a disabled
 *  context-menu item. `null` when the action is allowed. */
export function suiteRestriction(
  s: SuiteTypeLike & { requirementId?: number | null },
  action: "addCases" | "removeCases" | "nestSuites" | "rename",
): string | null {
  const caps = suiteCapabilities(s);
  if (action === "addCases" && !caps.canAddCases) {
    return "Query-based suites are filled by their work-item query — Azure DevOps doesn't allow adding cases by hand.";
  }
  if (action === "removeCases" && !caps.canRemoveCases) {
    return "Query-based suites are filled by their work-item query — a case leaves only when it stops matching the query.";
  }
  if (action === "nestSuites" && !caps.canNestSuites) {
    return "Azure DevOps only allows child suites under static suites.";
  }
  if (action === "rename" && !caps.canRename) {
    const ref = s.requirementId != null ? `#${s.requirementId}` : "its work item";
    return `Azure DevOps names this suite after requirement ${ref}. Rename the work item instead.`;
  }
  return null;
}

// The REQ / QUERY micro-badge, shared by every surface that lists a suite:
// the plans tree, the generator's target chip, the command palette, and the
// generation-history rows.
//
// It exists as one component because the badge had already been hand-rolled in
// three places with the same colours and the same 9.5px mono treatment — a
// fourth copy in History is how a palette drifts.

import { cn } from "@/lib/utils";
import { suiteCapabilities, type SuiteType } from "@/modules/ado";

export function SuiteTypeBadge({
  suiteType,
  requirementId,
  queryString,
  className,
}: {
  suiteType?: SuiteType | string | null;
  /** Shown in the tooltip for a requirement suite, when known. */
  requirementId?: number | null;
  /** WIQL behind a query suite. Worth surfacing: it's the only place a user
   *  can discover what fills the suite — ADO shows it nowhere in a list view. */
  queryString?: string | null;
  className?: string;
}) {
  const badge = suiteCapabilities({ suiteType }).badge;
  if (!badge) return null;

  const q = queryString?.trim();
  const title =
    badge === "REQ"
      ? `Requirement-based suite — tracks work item ${
          requirementId != null ? `#${requirementId}` : "in Azure DevOps"
        }. Cases published here link back as "Tested By".`
      : q
        ? `Query-based suite — read-only, filled by:\n${
            q.length > 200 ? `${q.slice(0, 200)}…` : q
          }`
        : "Query-based suite — Azure DevOps fills it from a work-item query. Read-only.";

  return (
    <span
      // Native `title` rather than a Radix Tooltip: the tree's copy of this
      // badge sits inside a ContextMenuTrigger and the two portals fight.
      // Keeping one implementation means keeping the constraint.
      title={title}
      className={cn(
        "shrink-0 font-mono text-[9.5px] font-semibold uppercase tracking-wider",
        badge === "REQ"
          ? "text-sky-600/85 dark:text-sky-400/85"
          : "text-violet-600/85 dark:text-violet-400/85",
        className,
      )}
    >
      {badge}
    </span>
  );
}

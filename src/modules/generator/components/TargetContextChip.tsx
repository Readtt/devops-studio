import { useEffect, useState } from "react";
import { listPlans, listSuites } from "@/modules/ado";
import { cn } from "@/lib/utils";
import { FolderOpenIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type Props = {
  planId: number | null;
  suiteId: number | null;
  existingCaseCount?: number | null;
  className?: string;
};

type Resolved = {
  planName: string;
  suiteName: string;
  suitePath: string[];
  areaPath: string | null;
  iterationPath: string | null;
};

/** Compact chip beside the requirements input that surfaces exactly what
 *  the analyst engines will embed in the prompt as TARGET CONTEXT — plan,
 *  parent suite path, default area path, default iteration. Lets the user
 *  catch a wrong selection before firing off a 30-second run. */
export function TargetContextChip({
  planId,
  suiteId,
  existingCaseCount,
  className,
}: Props) {
  const [resolved, setResolved] = useState<Resolved | null>(null);

  useEffect(() => {
    if (planId == null || suiteId == null) {
      setResolved(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const [plans, suites] = await Promise.all([
          listPlans(),
          listSuites(planId),
        ]);
        if (cancelled) return;
        const plan = plans.find((p) => p.id === planId);
        const suite = suites.find((s) => s.id === suiteId);
        if (!plan || !suite) {
          setResolved(null);
          return;
        }
        const byId = new Map(suites.map((s) => [s.id, s]));
        const path: string[] = [];
        let cursor = suite.parentSuiteId ?? null;
        let guard = 0;
        while (cursor != null && guard++ < 64) {
          const parent = byId.get(cursor);
          if (!parent) break;
          path.unshift(parent.name);
          cursor = parent.parentSuiteId ?? null;
        }
        setResolved({
          planName: plan.name,
          suiteName: suite.name,
          suitePath: path,
          areaPath: plan.areaPath ?? null,
          iterationPath: plan.iteration ?? null,
        });
      } catch {
        if (!cancelled) setResolved(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [planId, suiteId]);

  if (planId == null || suiteId == null) return null;

  const segments = resolved
    ? [resolved.planName, ...resolved.suitePath, resolved.suiteName]
    : [`#${planId}`, `#${suiteId}`];

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className={cn(
            // Prompt-line chip: monospaced breadcrumb with terminal-style
            // separators. Matches the project's progress strips and bug
            // code-ref chips.
            "inline-flex max-w-full items-center gap-1.5 truncate rounded-md border border-border/60 bg-card/50 px-2 py-1 font-mono text-[10.5px]",
            className,
          )}
        >
          <HugeiconsIcon
            icon={FolderOpenIcon}
            className="size-3 shrink-0 text-primary/70"
          />
          <span className="text-muted-foreground/70">target:</span>
          <span
            className="flex min-w-0 items-center truncate text-foreground/80"
            title={segments.join(" › ")}
          >
            {segments.map((seg, i) => (
              <span key={i} className="flex items-center">
                {i > 0 ? (
                  <span className="px-1 text-muted-foreground/40">›</span>
                ) : null}
                <span
                  className={cn(
                    "truncate",
                    i === segments.length - 1 && "text-primary/85",
                  )}
                >
                  {seg}
                </span>
              </span>
            ))}
          </span>
          {existingCaseCount != null && existingCaseCount > 0 ? (
            <span className="shrink-0 rounded-sm bg-foreground/[0.06] px-1 py-px text-[10px] text-muted-foreground">
              {existingCaseCount} existing
            </span>
          ) : null}
        </div>
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        variant="panel"
        className="max-w-[360px] text-[11px]"
      >
        {/* Terminal-flavored key→value sheet. Drops the editorial "sent to the
            model as …" preamble — the chip itself is already labelled "target"
            so the tooltip can just be the data. IDs are rendered next to the
            display name so reviewers can paste them into ADO if they need to
            jump out. */}
        <div className="flex flex-col">
          <div className="border-b border-border/40 px-2.5 py-1.5 font-mono text-[9.5px] uppercase tracking-wider text-muted-foreground/70">
            target context
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 px-2.5 py-2 text-[10.5px]">
            <dt className="text-muted-foreground/70">plan</dt>
            <dd className="flex min-w-0 items-baseline gap-1.5">
              <span className="truncate text-foreground/90">
                {resolved?.planName ?? `#${planId}`}
              </span>
              <span className="shrink-0 font-mono text-[9.5px] text-muted-foreground/60">
                #{planId}
              </span>
            </dd>

            <dt className="text-muted-foreground/70">suite</dt>
            <dd className="flex min-w-0 flex-wrap items-baseline gap-x-1 gap-y-0.5">
              <span className="font-mono text-foreground/85">
                {segments.join(" › ")}
              </span>
              <span className="shrink-0 font-mono text-[9.5px] text-muted-foreground/60">
                #{suiteId}
              </span>
            </dd>

            {resolved?.areaPath ? (
              <>
                <dt className="text-muted-foreground/70">area</dt>
                <dd className="truncate font-mono text-foreground/80">
                  {resolved.areaPath}
                </dd>
              </>
            ) : null}

            {resolved?.iterationPath ? (
              <>
                <dt className="text-muted-foreground/70">iteration</dt>
                <dd className="truncate font-mono text-foreground/80">
                  {resolved.iterationPath}
                </dd>
              </>
            ) : null}

            {existingCaseCount != null && existingCaseCount > 0 ? (
              <>
                <dt className="text-muted-foreground/70">cases</dt>
                <dd className="font-mono text-foreground/80">
                  {existingCaseCount} already in this suite
                </dd>
              </>
            ) : null}
          </dl>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

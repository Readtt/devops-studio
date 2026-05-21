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

  const breadcrumb = resolved
    ? [resolved.planName, ...resolved.suitePath, resolved.suiteName].join(" › ")
    : `Plan #${planId} › Suite #${suiteId}`;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className={cn(
            "inline-flex max-w-full items-center gap-1.5 truncate rounded-md border border-border/60 bg-card/50 px-2 py-1 text-[10.5px] text-muted-foreground",
            className,
          )}
        >
          <HugeiconsIcon
            icon={FolderOpenIcon}
            className="size-3 shrink-0 text-primary/70"
          />
          <span className="font-mono text-foreground/80">Context:</span>
          <span className="truncate" title={breadcrumb}>
            {breadcrumb}
          </span>
          {existingCaseCount != null && existingCaseCount > 0 ? (
            <span className="shrink-0 rounded-sm bg-foreground/[0.06] px-1 py-px font-mono text-[10px] uppercase tracking-wide">
              {existingCaseCount} existing
            </span>
          ) : null}
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-[360px] text-[11px]">
        <p className="font-medium">Sent to the model as TARGET CONTEXT:</p>
        <ul className="mt-1 flex flex-col gap-0.5 text-[10.5px]">
          <li>
            <span className="text-muted-foreground">Plan:</span>{" "}
            {resolved?.planName ?? `#${planId}`}
          </li>
          <li>
            <span className="text-muted-foreground">Suite:</span> {breadcrumb}
          </li>
          {resolved?.areaPath ? (
            <li>
              <span className="text-muted-foreground">Area path:</span>{" "}
              <span className="font-mono">{resolved.areaPath}</span>
            </li>
          ) : null}
          {resolved?.iterationPath ? (
            <li>
              <span className="text-muted-foreground">Iteration:</span>{" "}
              <span className="font-mono">{resolved.iterationPath}</span>
            </li>
          ) : null}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}

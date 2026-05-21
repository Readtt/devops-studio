import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useStaleCases } from "./hooks/useStaleCases";
import { acknowledgeCase, adoErrorMessage } from "@/modules/ado";
import { AlertCircleIcon, RefreshIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect } from "react";
import { useTestPlans } from "./hooks/useTestPlans";

type Props = {
  onOpenCase: (input: { caseId: number; title: string }) => void;
};

export function StaleQueuePanel({ onOpenCase }: Props) {
  const { initialized, configured, refreshConnection } = useTestPlans();
  const { loading, cases, lastScannedAt, error, scan, acknowledge } =
    useStaleCases();

  useEffect(() => {
    if (!initialized) {
      void refreshConnection();
    }
  }, [initialized, refreshConnection]);

  useEffect(() => {
    if (configured && lastScannedAt === null && !loading) {
      void scan();
    }
  }, [configured, lastScannedAt, loading, scan]);

  if (!initialized) {
    return <Center>Loading…</Center>;
  }
  if (!configured) {
    return (
      <Center>
        <p className="text-[12px] font-medium text-foreground/85">
          Not connected
        </p>
        <p className="mt-1 max-w-[200px] text-[11px] text-muted-foreground">
          Configure Azure DevOps in Settings before stale-detection can run.
        </p>
      </Center>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border/60 px-2 py-1.5">
        <span className="text-[11.5px] font-medium">Stale cases</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6"
              onClick={() => void scan()}
              aria-label="Refresh staleness"
            >
              <HugeiconsIcon
                icon={RefreshIcon}
                size={12}
                strokeWidth={1.75}
                className={loading ? "animate-spin" : ""}
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-[11px]">
            Rescan for cases whose linked source has changed
          </TooltipContent>
        </Tooltip>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <p className="px-3 py-2 text-[11px] text-destructive">
            {adoErrorMessage(error)}
          </p>
        ) : null}
        {!loading && cases.length === 0 ? (
          <Center>
            <HugeiconsIcon
              icon={AlertCircleIcon}
              size={18}
              strokeWidth={1.5}
              className="text-muted-foreground/60"
            />
            <p className="mt-1 text-[11.5px] font-medium text-foreground/85">
              All clear
            </p>
            <p className="mt-1 max-w-[210px] text-[11px] text-muted-foreground">
              No linked-file changes detected since the last review.
            </p>
          </Center>
        ) : null}
        <ul className="divide-y divide-border/40">
          {cases.map((c) => (
            <li key={c.caseId} className="px-2 py-2">
              <button
                type="button"
                onClick={() =>
                  onOpenCase({ caseId: c.caseId, title: `#${c.caseId}` })
                }
                className="block w-full text-left"
              >
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-[10.5px] text-muted-foreground">
                    #{c.caseId}
                  </span>
                  <span className="rounded-sm bg-amber-500/15 px-1 py-px text-[9.5px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-300">
                    {c.reason.replace(/-/g, " ")}
                  </span>
                </div>
                <p className="mt-0.5 text-[10.5px] text-muted-foreground">
                  {c.commitCount} new commit
                  {c.commitCount === 1 ? "" : "s"} touching {c.changedFiles.length} file
                  {c.changedFiles.length === 1 ? "" : "s"}.
                </p>
              </button>
              <div className="mt-1 flex gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-1.5 text-[10.5px]"
                  onClick={() => {
                    void acknowledgeCase(c.caseId);
                    acknowledge(c.caseId);
                  }}
                >
                  Acknowledge
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
      {children}
    </div>
  );
}

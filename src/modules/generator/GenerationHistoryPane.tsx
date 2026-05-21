import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { deleteRun, listRuns, type GenerationRun } from "./lib/history";
import {
  Bug01Icon,
  Cancel01Icon,
  RefreshIcon,
  TaskDone01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useState } from "react";

type Props = {
  onOpenCase: (input: { caseId: number; title: string }) => void;
  onOpenBug?: (input: { bugId: number; title: string }) => void;
};

/**
 * Sidebar pane that lists every persisted generation run with case + bug
 * counts and a quick-glance "some published, some failed" badge. Clicking
 * a published case/bug row jumps to it in the main pane.
 */
export function GenerationHistoryPane({ onOpenCase, onOpenBug }: Props) {
  const [runs, setRuns] = useState<GenerationRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await listRuns();
      setRuns(list);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onDelete = useCallback(
    async (runId: string) => {
      try {
        await deleteRun(runId);
        setRuns((curr) => (curr ?? []).filter((r) => r.id !== runId));
      } catch {
        // ignore — refresh will reconcile on next mount
      }
    },
    [],
  );

  if (runs === null) {
    return (
      <div className="flex flex-col gap-2 p-3">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-1.5 border-b border-border/60 px-2 py-1.5">
        <span className="text-[11.5px] font-medium">Generation history</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6"
              aria-label="Refresh history"
              onClick={() => void refresh()}
            >
              <HugeiconsIcon icon={RefreshIcon} size={12} strokeWidth={1.75} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-[11px]">
            Reload from disk
          </TooltipContent>
        </Tooltip>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <div className="px-3 py-2 text-[11px] text-destructive">{error}</div>
        ) : null}
        {runs.length === 0 ? (
          <div className="px-3 py-4 text-[11px] leading-relaxed text-muted-foreground">
            <p className="font-medium text-foreground/85">No runs yet.</p>
            <p className="mt-1">
              Once you publish from the Generator, each run lands here so you
              can revisit titles, statuses, and direct ADO links.
            </p>
          </div>
        ) : null}
        <ul className="flex flex-col gap-px px-1 py-1">
          {runs.map((r) => (
            <RunCard
              key={r.id}
              run={r}
              onOpenCase={onOpenCase}
              onOpenBug={onOpenBug}
              onDelete={() => void onDelete(r.id)}
            />
          ))}
        </ul>
      </div>
    </div>
  );
}

function RunCard({
  run,
  onOpenCase,
  onOpenBug,
  onDelete,
}: {
  run: GenerationRun;
  onOpenCase: Props["onOpenCase"];
  onOpenBug?: Props["onOpenBug"];
  onDelete: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const okCount = run.publishLog.filter((l) => l.status === "ok").length;
  const failCount = run.publishLog.filter((l) => l.status === "failed").length;
  const hasFailures = failCount > 0;

  return (
    <li className="rounded-md border border-border/40 bg-card/40">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-start gap-2 px-2 py-1.5 text-left text-[11.5px] hover:bg-foreground/[0.04]"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium">{formatTimestamp(run.timestamp)}</span>
            <span className="text-[10.5px] text-muted-foreground">
              {run.mode}
            </span>
            {hasFailures ? (
              <span className="rounded bg-destructive/15 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
                {failCount} failed
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 truncate text-[10.5px] text-muted-foreground">
            {run.planName ?? (run.planId != null ? `Plan #${run.planId}` : "—")}
            {" · "}
            {run.suiteName ??
              (run.suiteId != null ? `Suite #${run.suiteId}` : "All suites")}
          </p>
          <p className="mt-0.5 text-[10.5px] text-muted-foreground/85">
            {run.cases.length} case{run.cases.length === 1 ? "" : "s"} ·{" "}
            {run.bugs.length} bug{run.bugs.length === 1 ? "" : "s"} ·{" "}
            {okCount} published
          </p>
        </div>
        <button
          type="button"
          aria-label="Delete this run"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
        >
          <HugeiconsIcon icon={Cancel01Icon} size={10} strokeWidth={2} />
        </button>
      </button>
      {expanded ? (
        <div className="border-t border-border/40 px-2 py-1.5">
          {run.specExcerpt ? (
            <p className="mb-2 line-clamp-3 text-[10.5px] italic text-muted-foreground">
              {run.specExcerpt}
            </p>
          ) : null}
          {run.cases.length > 0 ? (
            <div className="mb-1.5">
              <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                Cases
              </p>
              <ul className="flex flex-col gap-px">
                {run.cases.map((c, i) => (
                  <li key={`${run.id}-c-${i}`}>
                    <RowAction
                      icon={TaskDone01Icon}
                      label={c.title}
                      adoId={c.adoId}
                      webUrl={c.webUrl}
                      onOpenInApp={
                        c.adoId
                          ? () =>
                              onOpenCase({
                                caseId: c.adoId!,
                                title: `#${c.adoId} · ${c.title}`,
                              })
                          : undefined
                      }
                    />
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {run.bugs.length > 0 ? (
            <div>
              <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                Bugs
              </p>
              <ul className="flex flex-col gap-px">
                {run.bugs.map((b, i) => (
                  <li key={`${run.id}-b-${i}`}>
                    <RowAction
                      icon={Bug01Icon}
                      label={b.title}
                      adoId={b.adoId}
                      webUrl={b.webUrl}
                      onOpenInApp={
                        b.adoId && onOpenBug
                          ? () =>
                              onOpenBug({
                                bugId: b.adoId!,
                                title: `Bug #${b.adoId} · ${b.title}`,
                              })
                          : undefined
                      }
                    />
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function RowAction({
  icon,
  label,
  adoId,
  webUrl,
  onOpenInApp,
}: {
  icon: Parameters<typeof HugeiconsIcon>[0]["icon"];
  label: string;
  adoId?: number | null;
  webUrl?: string | null;
  onOpenInApp?: () => void;
}) {
  return (
    <div className="flex items-center gap-1.5 rounded-sm px-1 py-0.5 text-[11px] hover:bg-foreground/[0.04]">
      <HugeiconsIcon icon={icon} size={10} strokeWidth={1.75} className="text-muted-foreground" />
      <button
        type="button"
        onClick={onOpenInApp}
        disabled={!onOpenInApp}
        className={cn(
          "min-w-0 flex-1 truncate text-left",
          onOpenInApp
            ? "hover:text-primary hover:underline"
            : "cursor-default text-muted-foreground/85",
        )}
      >
        {adoId ? <span className="mr-1 text-muted-foreground">#{adoId}</span> : null}
        {label}
      </button>
      {webUrl ? (
        <button
          type="button"
          onClick={() => void openUrl(webUrl)}
          className="text-[10px] text-muted-foreground hover:text-foreground"
        >
          ADO
        </button>
      ) : null}
    </div>
  );
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

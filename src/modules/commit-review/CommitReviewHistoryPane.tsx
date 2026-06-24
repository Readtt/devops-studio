import { useCallback, useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Cancel01Icon,
  GitBranchIcon,
  Loading03Icon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import {
  deleteCommitReview,
  listCommitReviews,
  type CommitReviewStatus,
  type CommitReviewSummary,
} from "./commitReviewApi";

const STATUS_TINT: Record<CommitReviewStatus, string> = {
  done: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  running: "bg-primary/15 text-primary",
  error: "bg-destructive/15 text-destructive",
  cancelled: "bg-foreground/[0.08] text-muted-foreground",
  interrupted: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
};

const STATUS_DESC: Record<CommitReviewStatus, string> = {
  done: "Finished — findings are saved and reopenable.",
  running: "In progress right now.",
  error: "Ended with an error. Reopen and re-run.",
  cancelled: "You stopped this run before it finished.",
  interrupted: "A refresh or crash interrupted this run. Reopen and re-run.",
};

/** Commit Review run history — one of the two tabs in the History sidebar.
 *  Clicking a row reopens the saved run (its findings + the context you typed)
 *  in a Commit Review tab. */
export function CommitReviewHistoryPane({
  onOpen,
}: {
  onOpen: (runId: string) => void;
}) {
  const [rows, setRows] = useState<CommitReviewSummary[] | null>(null);
  const [filter, setFilter] = useState("");

  const refresh = useCallback(async () => {
    try {
      setRows(await listCommitReviews());
    } catch {
      setRows([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Live refresh when a run transitions (the store dispatches this event).
  useEffect(() => {
    let timer: number | null = null;
    const onUpdated = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        void refresh();
      }, 250);
    };
    window.addEventListener("devops-studio:commit-review-updated", onUpdated);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      window.removeEventListener(
        "devops-studio:commit-review-updated",
        onUpdated,
      );
    };
  }, [refresh]);

  // Manual reload beside the filter (mirrors the Plans tab). Own spinner so a
  // deliberate click reads as "reloading", distinct from the silent debounced
  // refresh above.
  const [refreshing, setRefreshing] = useState(false);
  const reload = useCallback(async () => {
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  }, [refresh]);

  const onDelete = useCallback(async (runId: string) => {
    try {
      await deleteCommitReview(runId);
      setRows((curr) => (curr ?? []).filter((r) => r.runId !== runId));
    } catch {
      // best-effort
    }
  }, []);

  const needle = filter.trim().toLowerCase();
  const visible = useMemo(() => {
    if (!rows) return null;
    if (!needle) return rows;
    return rows.filter(
      (r) =>
        (r.commitSubject ?? "").toLowerCase().includes(needle) ||
        r.commitShort.toLowerCase().includes(needle) ||
        r.status.toLowerCase().includes(needle),
    );
  }, [rows, needle]);

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-border/60 px-2 py-1.5">
        <div className="flex items-center gap-1.5">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter reviews by commit or status…"
            className="min-w-0 flex-1 rounded-md border border-border/60 bg-background/70 px-2 py-1 text-[11.5px] outline-none focus:border-primary/50"
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Reload commit reviews"
                onClick={() => void reload()}
              >
                <HugeiconsIcon
                  icon={RefreshIcon}
                  size={12}
                  strokeWidth={1.75}
                  className={refreshing ? "animate-spin" : ""}
                />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-[11px]">
              Reload commit reviews from disk
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!rows ? (
          <div className="flex flex-col gap-2 p-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState />
        ) : visible && visible.length === 0 ? (
          <p className="px-3 py-3 text-[11px] text-muted-foreground">
            No reviews match this filter.
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5 px-1 py-1">
            {visible?.map((r) => (
              <li key={r.runId}>
                <Row
                  row={r}
                  onOpen={() => onOpen(r.runId)}
                  onDelete={() => void onDelete(r.runId)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
      <span className="inline-flex size-9 items-center justify-center rounded-full bg-foreground/[0.05] text-muted-foreground">
        <HugeiconsIcon icon={GitBranchIcon} size={16} strokeWidth={1.75} />
      </span>
      <p className="text-[12px] font-medium">No commit reviews yet.</p>
      <p className="max-w-[230px] text-[10.5px] leading-relaxed text-muted-foreground">
        Open <em>Commit Review</em> from the <em>+</em> menu (or ⌘/Ctrl+Shift+R),
        pick a commit, and review it. Each run lands here so you can reopen its
        findings later.
      </p>
    </div>
  );
}

function Row({
  row,
  onOpen,
  onDelete,
}: {
  row: CommitReviewSummary;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const commits = commitCount(row.commits);
  return (
    <div className="group/row flex items-start gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-foreground/[0.04]">
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
        <div className="flex items-center gap-1.5 text-[11.5px] font-medium">
          <HugeiconsIcon
            icon={row.status === "running" ? Loading03Icon : GitBranchIcon}
            size={11}
            strokeWidth={1.75}
            className={cn(
              "shrink-0 text-muted-foreground",
              row.status === "running" && "animate-spin",
            )}
          />
          <span className="truncate">{row.commitSubject ?? row.commitShort}</span>
        </div>
        <p className="mt-0.5 flex items-center gap-1 truncate text-[10.5px] text-muted-foreground">
          <span className="font-mono">{row.commitShort}</span>
          {commits > 1 ? (
            <>
              <span className="text-muted-foreground/55">·</span>
              <span>{commits} commits</span>
            </>
          ) : null}
          <span className="text-muted-foreground/55">·</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className={cn(
                  "cursor-help rounded-sm px-1 py-px text-[9px] font-medium uppercase tracking-wide",
                  STATUS_TINT[row.status],
                )}
              >
                {row.status}
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-[240px] text-[11px]">
              {STATUS_DESC[row.status]}
            </TooltipContent>
          </Tooltip>
          {row.status === "done" ? (
            <>
              <span className="text-muted-foreground/55">·</span>
              <span>
                {row.findingCount} finding{row.findingCount === 1 ? "" : "s"}
              </span>
            </>
          ) : null}
          <span className="text-muted-foreground/55">·</span>
          <span>{formatRelative(row.updatedAt)}</span>
        </p>
      </button>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="Delete this review"
            onClick={onDelete}
            className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/15 hover:text-destructive group-hover/row:opacity-100"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={10} strokeWidth={2} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="left" className="text-[11px]">
          Remove this review from history. Your code isn't touched.
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

/** Count of reviewed commits from the row's `commits` JSON (1 for legacy rows). */
function commitCount(json: string | null): number {
  if (!json) return 1;
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) && v.length > 0 ? v.length : 1;
  } catch {
    return 1;
  }
}

function formatRelative(iso: string): string {
  try {
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    const m = Math.floor(diff / 60_000);
    if (m < 1) return "just now";
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const day = Math.floor(h / 24);
    if (day < 7) return `${day}d ago`;
    return d.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

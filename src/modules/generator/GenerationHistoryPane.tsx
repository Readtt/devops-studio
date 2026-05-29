import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import {
  deleteRun,
  listRuns,
  type GenerationRun,
  type RunStatus,
} from "./lib/history";
import { useTestPlans } from "@/modules/test-plans";
import { CopyableSectionHeader } from "@/components/CopyableSectionHeader";
import {
  Bug01Icon,
  Cancel01Icon,
  Copy01Icon,
  Delete02Icon,
  ExternalLink,
  FileEditIcon,
  RefreshIcon,
  TaskDone01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useMemo, useState } from "react";

type Props = {
  onOpenCase: (input: { caseId: number; title: string }) => void;
  onOpenBug?: (input: { bugId: number; title: string }) => void;
  /** Open a saved draft back into the Generator's review phase. Only fired
   *  for rows that carry a restorable payload (i.e. modern drafts). */
  onOpenDraft?: (run: GenerationRun) => void;
  /** Reopen a published run in the Generator's Done view (publish summary).
   *  Lets the user navigate Done ↔ Review ↔ Input via the same breadcrumbs
   *  the live publish flow uses. */
  onOpenPublished?: (run: GenerationRun) => void;
};

/**
 * Sidebar pane that lists every persisted generation run with case + bug
 * counts and a quick-glance "some published, some failed" badge. Clicking
 * a published case/bug row jumps to it in the main pane.
 */
export function GenerationHistoryPane({
  onOpenCase,
  onOpenBug,
  onOpenDraft,
  onOpenPublished,
}: Props) {
  const [runs, setRuns] = useState<GenerationRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<"all" | RunStatus>("all");
  const [textFilter, setTextFilter] = useState("");

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

  // Live refresh: any in-app draft autosave dispatches
  // "devops-studio:history-updated"; refetch so the sidebar mirrors the
  // user's latest edits without a manual click. Debounced to coalesce
  // bursts (typing through a series of edits in the same tab).
  useEffect(() => {
    let timer: number | null = null;
    const onUpdated = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        void refresh();
      }, 250);
    };
    window.addEventListener("devops-studio:history-updated", onUpdated);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      window.removeEventListener(
        "devops-studio:history-updated",
        onUpdated,
      );
    };
  }, [refresh]);

  const filteredRuns = useMemo(() => {
    if (!runs) return null;
    const needle = textFilter.trim().toLowerCase();
    return runs.filter((r) => {
      const effectiveStatus = r.status ?? "published";
      if (statusFilter !== "all" && effectiveStatus !== statusFilter) {
        return false;
      }
      if (!needle) return true;
      const haystack = [
        r.planName ?? "",
        r.suiteName ?? "",
        r.mode,
        r.specExcerpt ?? "",
        ...r.cases.map((c) => c.title),
        ...r.bugs.map((b) => b.title),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [runs, statusFilter, textFilter]);

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

  const visibleRuns = filteredRuns ?? [];
  const showingEmpty = runs.length === 0;
  const showingFilteredEmpty = !showingEmpty && visibleRuns.length === 0;

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

      <div className="border-b border-border/60 px-2 pt-1.5">
        <input
          value={textFilter}
          onChange={(e) => setTextFilter(e.target.value)}
          placeholder="Filter by plan, suite, case, or text…"
          className="mb-1.5 w-full rounded-md border border-border/60 bg-background/70 px-2 py-1 text-[11.5px] outline-none focus:border-primary/50"
        />
        {/* Console-tab filter row — flush, shared baseline, monospace counts.
            Matches the editor/terminal voice the rest of the app uses for
            tree-state controls. */}
        <div className="-mb-px flex items-center gap-3 font-mono text-[10.5px]">
          {(["all", "draft", "published"] as const).map((id) => {
            const count =
              id === "all"
                ? runs.length
                : runs.filter(
                    (r) => (r.status ?? "published") === id,
                  ).length;
            const isActive = statusFilter === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setStatusFilter(id)}
                className={cn(
                  "relative flex items-center gap-1.5 pb-1.5 transition-colors",
                  isActive
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <span className={isActive ? "font-semibold" : ""}>{id}</span>
                <span
                  className={cn(
                    "rounded-sm px-1 py-px text-[9.5px] tabular-nums",
                    isActive
                      ? "bg-primary/15 text-primary"
                      : "bg-foreground/[0.06] text-muted-foreground/70",
                  )}
                >
                  {count}
                </span>
                {isActive ? (
                  <span className="absolute inset-x-0 bottom-0 h-px bg-primary" />
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <div className="px-3 py-2 text-[11px] text-destructive">{error}</div>
        ) : null}
        {showingEmpty ? (
          <div className="px-3 py-4 text-[11px] leading-relaxed text-muted-foreground">
            <p className="font-medium text-foreground/85">No runs yet.</p>
            <p className="mt-1">
              Once you analyze a spec, the draft lands here. Publishing flips
              it to a "published" row with direct ADO links.
            </p>
          </div>
        ) : null}
        {showingFilteredEmpty ? (
          <div className="px-3 py-4 text-[11px] text-muted-foreground">
            No runs match the current filter.
          </div>
        ) : null}
        <ul className="flex flex-col gap-px px-1 py-1">
          {visibleRuns.map((r) => (
            <RunCard
              key={r.id}
              run={r}
              onOpenCase={onOpenCase}
              onOpenBug={onOpenBug}
              onOpenDraft={onOpenDraft}
              onOpenPublished={onOpenPublished}
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
  onOpenDraft,
  onOpenPublished,
  onDelete,
}: {
  run: GenerationRun;
  onOpenCase: Props["onOpenCase"];
  onOpenBug?: Props["onOpenBug"];
  onOpenDraft?: Props["onOpenDraft"];
  onOpenPublished?: Props["onOpenPublished"];
  onDelete: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const okCount = run.publishLog.filter((l) => l.status === "ok").length;
  const failCount = run.publishLog.filter((l) => l.status === "failed").length;
  const hasFailures = failCount > 0;
  const isDraft = (run.status ?? "published") === "draft";
  const canRestoreDraft = isDraft && !!run.draftPayload?.cases;
  // Published rows always have a publishLog — that's enough to reopen them
  // in the Done view. The draft payload may or may not be present (new
  // rows persist it on publish; older rows don't). Either way the done
  // screen renders, and the breadcrumb just won't reach Review when the
  // payload is missing.
  const canOpenPublished = !isDraft && run.publishLog.length > 0;

  // Resolve plan + suite names from the shared cache when the saved row
  // only carries ids. Old runs (pre-name-capture) and any row that lost
  // network at save time will hit this path; once the names land they
  // render in place — no need to re-save the row.
  const { planLabel, suiteLabel } = useResolvedTargetLabels(run);

  return (
    <li>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="group/run rounded-md border border-border/40 bg-card/40 transition-colors hover:bg-foreground/[0.04]">
      {/* Row container is a div so the toggle "card" doesn't wrap the
          action buttons (button-in-button is invalid HTML and trips the
          React hydration validator). The expand toggle and the icon
          actions are sibling buttons sharing this flex row. */}
      <div className="flex w-full items-start gap-2 px-2 py-1.5 text-[11.5px]">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="min-w-0 flex-1 text-left"
        >
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-medium">{formatTimestamp(run.timestamp)}</span>
            <span className="text-[10.5px] text-muted-foreground">
              {run.mode}
            </span>
            <StatusBadge status={run.status ?? "published"} />
            {hasFailures ? (
              <span className="shrink-0 rounded bg-destructive/15 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
                {failCount} failed
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 truncate text-[10.5px] text-muted-foreground">
            {planLabel}
            {" · "}
            {suiteLabel}
          </p>
          <p className="mt-0.5 truncate text-[10.5px] text-muted-foreground/85">
            {run.cases.length} case{run.cases.length === 1 ? "" : "s"} ·{" "}
            {run.bugs.length} bug{run.bugs.length === 1 ? "" : "s"} ·{" "}
            {okCount} published
          </p>
        </button>
        <div className="flex shrink-0 items-center gap-1">
          {canRestoreDraft && onOpenDraft ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="Open this draft in review"
                  onClick={() => onOpenDraft(run)}
                  className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-primary/15 hover:text-primary"
                >
                  <HugeiconsIcon
                    icon={FileEditIcon}
                    size={10}
                    strokeWidth={1.75}
                  />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-[11px]">
                Open in review
              </TooltipContent>
            </Tooltip>
          ) : null}
          {canOpenPublished && onOpenPublished ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="Reopen this run in the publish summary"
                  onClick={() => onOpenPublished(run)}
                  className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-primary/15 hover:text-primary"
                >
                  <HugeiconsIcon
                    icon={ExternalLink}
                    size={10}
                    strokeWidth={1.75}
                  />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-[11px]">
                Reopen publish summary
              </TooltipContent>
            </Tooltip>
          ) : null}
          <button
            type="button"
            aria-label="Delete this run"
            onClick={onDelete}
            className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={10} strokeWidth={2} />
          </button>
        </div>
      </div>
      {expanded ? (
        <div className="border-t border-border/40 px-2 py-1.5">
          {canRestoreDraft && onOpenDraft ? (
            <div className="mb-2 flex items-center justify-between gap-2 rounded-sm border border-primary/30 bg-primary/[0.04] px-2 py-1">
              <span className="min-w-0 flex-1 text-[10.5px] text-muted-foreground">
                Reopen this draft to keep editing where you left off.
              </span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenDraft(run);
                }}
                className="inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-sm border border-primary/40 bg-primary/10 px-1.5 text-[10px] font-medium text-primary transition-colors hover:bg-primary/20"
              >
                <HugeiconsIcon
                  icon={ExternalLink}
                  size={9}
                  strokeWidth={1.75}
                />
                Open in review
              </button>
            </div>
          ) : canOpenPublished && onOpenPublished ? (
            <div className="mb-2 flex items-center justify-between gap-2 rounded-sm border border-primary/30 bg-primary/[0.04] px-2 py-1">
              <span className="min-w-0 flex-1 text-[10.5px] text-muted-foreground">
                Reopen the publish summary — drill into input, review, or
                done from the breadcrumb.
              </span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenPublished(run);
                }}
                className="inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-sm border border-primary/40 bg-primary/10 px-1.5 text-[10px] font-medium text-primary transition-colors hover:bg-primary/20"
              >
                <HugeiconsIcon
                  icon={ExternalLink}
                  size={9}
                  strokeWidth={1.75}
                />
                Open in done
              </button>
            </div>
          ) : isDraft && !canRestoreDraft ? (
            <p className="mb-2 rounded-sm border border-amber-500/30 bg-amber-500/[0.06] px-2 py-1 text-[10px] text-amber-700 dark:text-amber-300">
              This draft was saved before drafts could be reopened. New drafts
              will restore in full.
            </p>
          ) : null}
          {run.specExcerpt ? (
            <p className="mb-2 line-clamp-3 text-[10.5px] italic text-muted-foreground">
              {run.specExcerpt}
            </p>
          ) : null}
          {run.cases.length > 0 ? (
            <div className="mb-1.5">
              <CopyableSectionHeader
                label="Cases"
                kind="Test Case"
                items={run.cases.map((c) => ({
                  id: c.adoId ?? null,
                  title: c.title,
                  webUrl: c.webUrl ?? null,
                }))}
                count={run.cases.length}
                className="mb-1"
              />
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
              <CopyableSectionHeader
                label="Bugs"
                kind="Bug"
                items={run.bugs.map((b) => ({
                  id: b.adoId ?? null,
                  title: b.title,
                  webUrl: b.webUrl ?? null,
                }))}
                count={run.bugs.length}
                className="mb-1"
              />
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
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-56">
          {isDraft ? (
            <ContextMenuItem
              icon={
                <HugeiconsIcon icon={FileEditIcon} size={12} strokeWidth={1.75} />
              }
              description={
                canRestoreDraft
                  ? "Reopen this draft in Review to keep editing."
                  : "Saved before drafts could be reopened — can't restore."
              }
              disabled={!canRestoreDraft || !onOpenDraft}
              onSelect={() => onOpenDraft?.(run)}
            >
              Open in review
            </ContextMenuItem>
          ) : (
            <ContextMenuItem
              icon={
                <HugeiconsIcon icon={ExternalLink} size={12} strokeWidth={1.75} />
              }
              description="Reopen the publish summary — drill into input, review, or done."
              disabled={!canOpenPublished || !onOpenPublished}
              onSelect={() => onOpenPublished?.(run)}
            >
              Open publish summary
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem
            icon={<HugeiconsIcon icon={Copy01Icon} size={12} strokeWidth={1.75} />}
            disabled={!run.specExcerpt}
            onSelect={() => void copyText(run.specExcerpt ?? "")}
          >
            Copy spec
          </ContextMenuItem>
          <ContextMenuItem
            icon={<HugeiconsIcon icon={Copy01Icon} size={12} strokeWidth={1.75} />}
            description="Copy every case and bug title, with ADO ids where published."
            disabled={run.cases.length === 0 && run.bugs.length === 0}
            onSelect={() => void copyText(formatRunTitles(run))}
          >
            Copy case &amp; bug titles
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            variant="destructive"
            icon={<HugeiconsIcon icon={Delete02Icon} size={12} strokeWidth={1.75} />}
            description="Remove from history — anything already published to ADO is untouched."
            onSelect={onDelete}
          >
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
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

function StatusBadge({ status }: { status: RunStatus }) {
  // Mono lowercase so it reads as a state tag (consistent with how the
  // generator's progress strip writes "input · analyze · review").
  if (status === "draft") {
    return (
      <span className="rounded-sm bg-amber-500/15 px-1.5 py-px font-mono text-[10px] text-amber-700 dark:text-amber-300">
        draft
      </span>
    );
  }
  return (
    <span className="rounded-sm bg-primary/15 px-1.5 py-px font-mono text-[10px] text-primary">
      published
    </span>
  );
}

/** Read plan + suite labels for a history row, falling back to the
 *  useTestPlans cache when the row only carries ids. Lazily kicks off a
 *  suites fetch for unknown plans so subsequent renders pick up the
 *  resolved suite name without the user manually clicking around.
 *
 *  Returns formatted strings (not raw ids) so the caller can just drop
 *  them into the row layout. */
function useResolvedTargetLabels(run: GenerationRun): {
  planLabel: string;
  suiteLabel: string;
} {
  const plans = useTestPlans((s) => s.plans);
  const bySuite = useTestPlans((s) => s.bySuite);
  const loadSuites = useTestPlans((s) => s.loadSuites);

  // Trigger a suites lookup for the plan if we have an id, no name, and
  // nothing cached. Cheap — useTestPlans dedupes in-flight requests.
  useEffect(() => {
    if (run.planId == null) return;
    if (run.suiteName) return; // already named, no need to fetch
    const planLoad = bySuite.get(run.planId);
    const planSuites = planLoad?.suites;
    if (!planSuites || planSuites.length === 0) {
      if (!planLoad?.loading) {
        void loadSuites(run.planId);
      }
    }
  }, [run.planId, run.suiteName, bySuite, loadSuites]);

  const resolvedPlanName =
    run.planName ??
    (run.planId != null
      ? plans.find((p) => p.id === run.planId)?.name ?? null
      : null);
  const resolvedSuiteName =
    run.suiteName ??
    (run.planId != null && run.suiteId != null
      ? bySuite.get(run.planId)?.suites.find((s) => s.id === run.suiteId)
          ?.name ?? null
      : null);

  const planLabel =
    resolvedPlanName ??
    (run.planId != null ? `Plan #${run.planId}` : "—");
  const suiteLabel =
    resolvedSuiteName ??
    (run.suiteId != null ? `Suite #${run.suiteId}` : "All suites");

  return { planLabel, suiteLabel };
}

/** Best-effort plain-text clipboard write. Silent on failure (some webviews
 *  restrict clipboard access) — copying a history field is a convenience. */
async function copyText(text: string): Promise<void> {
  if (!text) return;
  try {
    await navigator.clipboard?.writeText(text);
  } catch {
    // ignore — clipboard may be unavailable in this context.
  }
}

/** Assemble a copy-friendly block of a run's case + bug titles, prefixing the
 *  ADO id where the item was published. */
function formatRunTitles(run: GenerationRun): string {
  const lines: string[] = [];
  if (run.cases.length > 0) {
    lines.push("Cases:");
    for (const c of run.cases) {
      lines.push(`${c.adoId ? `#${c.adoId} ` : ""}${c.title}`);
    }
  }
  if (run.bugs.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Bugs:");
    for (const b of run.bugs) {
      lines.push(`${b.adoId ? `#${b.adoId} ` : ""}${b.title}`);
    }
  }
  return lines.join("\n");
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

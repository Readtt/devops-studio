import { useEffect, useRef, useState } from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  AlertCircleIcon,
  Archive02Icon,
  ArrowDown01Icon,
  ArrowReloadHorizontalIcon,
  ArrowUp01Icon,
  CloudDownloadIcon,
  FolderOpenIcon,
  GitBranchIcon,
  Loading03Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";
import {
  gitBranches,
  gitFetch,
  type BranchListItem,
  type GitStatusSummary,
} from "./gitOps";
import { useSourceDirStatus } from "./useSourceDirStatus";
import { useBranchSwitch } from "./useBranchSwitch";

/**
 * Bottom status-bar git widget: the source directory + a live branch switcher.
 * This is the app's single source-directory control — the folder segment opens
 * the directory picker (showing "Pick source directory…" until one is set), and
 * the branch segment (only once the source dir is a git repo) opens a switcher
 * that checks out the chosen branch and fast-forward-pulls it (asking what to do
 * with uncommitted work first).
 */
export function StatusBarGit({
  sourceRoot,
  onPickDir,
}: {
  sourceRoot: string | null;
  onPickDir: () => void;
}) {
  const status = useSourceDirStatus();

  const last = sourceRoot
    ? sourceRoot.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? ""
    : "";

  return (
    <div className="flex h-5 items-stretch overflow-hidden rounded-md border border-border/60 bg-card text-[10.5px]">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onPickDir}
            className="flex items-center gap-1 px-1.5 text-muted-foreground transition-colors hover:bg-foreground/[0.04] hover:text-foreground"
            aria-label={sourceRoot ? "Source directory" : "Pick a source directory"}
          >
            <HugeiconsIcon icon={FolderOpenIcon} size={11} strokeWidth={1.75} />
            <span className="max-w-[160px] truncate">
              {sourceRoot ? last || sourceRoot : "Pick source directory…"}
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          align="start"
          sideOffset={6}
          variant="panel"
          className="max-w-[420px] px-3 py-2 text-[11px] leading-relaxed"
        >
          {sourceRoot ? (
            <div className="flex flex-col gap-1">
              <div className="flex items-baseline gap-1.5">
                <span className="font-mono text-[9.5px] uppercase tracking-wider text-muted-foreground/70">
                  source
                </span>
                <span className="min-w-0 break-all font-mono text-[10.5px] text-foreground/90">
                  {sourceRoot}
                </span>
              </div>
              <p className="mt-0.5 text-[10px] text-muted-foreground/70">
                Click to change the source directory.
              </p>
            </div>
          ) : (
            <p className="text-[11px] text-foreground/90">
              Click to choose a source directory. Code links in bugs and grounded
              AI reviews read from here.
            </p>
          )}
        </TooltipContent>
      </Tooltip>

      {sourceRoot && status.isRepo ? (
        <>
          <span aria-hidden className="w-px self-stretch bg-border/70" />
          <BranchSwitcher cwd={sourceRoot} status={status} />
        </>
      ) : null}
    </div>
  );
}

function BranchSwitcher({
  cwd,
  status,
}: {
  cwd: string;
  status: GitStatusSummary;
}) {
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<BranchListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [lastFetched, setLastFetched] = useState<number | null>(null);
  const [fetchNote, setFetchNote] = useState<string | null>(null);
  // Holds the latest load's cancellation flag so the post-fetch reload below
  // can opt into the same cancellation as the effect-driven load (a closed
  // popover or a changed cwd must not let a late branch list repaint).
  const loadSignal = useRef<{ cancelled: boolean } | null>(null);

  const requestSwitch = useBranchSwitch((s) => s.requestSwitch);
  const pullOnly = useBranchSwitch((s) => s.pullOnly);
  const restoreStash = useBranchSwitch((s) => s.restoreStash);
  const toast = useBranchSwitch((s) => s.toast);
  const busy =
    toast?.kind === "switching" ||
    toast?.kind === "pulling" ||
    toast?.kind === "restoring";

  const current = status.branch;
  const label = current ?? (status.commit ? `(${status.commit})` : "(detached)");
  const canPull = status.behind > 0 && !!status.upstream && !!current;

  const locals = branches.filter((b) => b.kind === "local");
  const remotes = branches.filter((b) => b.kind === "remote");
  const hasRemotes = !!status.upstream || remotes.length > 0;

  const loadBranches = (signal?: { cancelled: boolean }) => {
    setLoading(true);
    void gitBranches(cwd)
      .then((list) => {
        if (!signal?.cancelled) {
          setBranches(list);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!signal?.cancelled) {
          setBranches([]);
          setLoading(false);
        }
      });
  };

  useEffect(() => {
    if (!open) return;
    const signal = { cancelled: false };
    loadSignal.current = signal;
    setFetchNote(null);
    loadBranches(signal);
    return () => {
      signal.cancelled = true;
      if (loadSignal.current === signal) loadSignal.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, cwd]);

  const onFetch = async () => {
    setFetching(true);
    setFetchNote(null);
    try {
      const res = await gitFetch(cwd);
      if (res.status === "fetched") {
        setLastFetched(Date.now());
        // Reuse the current load signal so a popover that closed (or a cwd that
        // changed) while the fetch was in flight cancels this reload too.
        loadBranches(loadSignal.current ?? undefined);
      } else {
        setFetchNote(res.message);
      }
    } catch {
      setFetchNote("Couldn't fetch from the remote.");
    } finally {
      setFetching(false);
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        // Don't let a switcher open while a switch is mid-flight.
        if (busy) return;
        setOpen(next);
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={busy}
              className="flex items-center gap-1 px-1.5 text-muted-foreground transition-colors hover:bg-foreground/[0.04] hover:text-foreground disabled:opacity-60 data-[state=open]:bg-foreground/[0.05] data-[state=open]:text-foreground"
              aria-label="Switch git branch"
            >
              <HugeiconsIcon icon={GitBranchIcon} size={11} strokeWidth={1.75} />
              <span className="max-w-[150px] truncate font-mono text-[10.5px]">
                {label}
              </span>
              {status.dirty ? (
                <span
                  aria-hidden
                  title="Uncommitted changes"
                  className="size-1.5 shrink-0 rounded-full bg-amber-500"
                />
              ) : null}
              {status.parkedHere ? (
                <HugeiconsIcon
                  icon={Archive02Icon}
                  size={10}
                  strokeWidth={1.75}
                  className="shrink-0 text-primary"
                />
              ) : null}
              {status.ahead > 0 || status.behind > 0 ? (
                <span className="flex shrink-0 items-center gap-0.5 font-mono text-[9.5px] text-muted-foreground/80">
                  {status.ahead > 0 ? (
                    <span className="flex items-center">
                      <HugeiconsIcon icon={ArrowUp01Icon} size={9} strokeWidth={2.25} />
                      {status.ahead}
                    </span>
                  ) : null}
                  {status.behind > 0 ? (
                    <span className="flex items-center">
                      <HugeiconsIcon icon={ArrowDown01Icon} size={9} strokeWidth={2.25} />
                      {status.behind}
                    </span>
                  ) : null}
                </span>
              ) : null}
              <HugeiconsIcon
                icon={ArrowDown01Icon}
                size={9}
                strokeWidth={2}
                className="shrink-0 text-muted-foreground/60"
              />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">
          {status.parkedHere
            ? "Switch branch, pull, or restore changes you left here"
            : "Switch branch — also pulls the latest"}
        </TooltipContent>
      </Tooltip>

      <PopoverContent side="top" align="start" sideOffset={6} className="w-[300px] p-0">
        <Command>
          <CommandInput placeholder="Switch branch…" />
          <CommandList className="max-h-[280px]">
            <CommandEmpty>
              {loading ? "Loading branches…" : "No branches match."}
            </CommandEmpty>

            {status.parkedHere ? (
              <CommandGroup heading="Stashed here">
                <CommandItem
                  value="__restore-parked__"
                  onSelect={() => {
                    restoreStash(cwd);
                    setOpen(false);
                  }}
                  className="items-center gap-2"
                >
                  <span className="grid size-3.5 shrink-0 place-items-center text-primary">
                    <HugeiconsIcon icon={Archive02Icon} size={11} strokeWidth={1.75} />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[12px] text-foreground">
                      Restore changes you left here
                    </span>
                    <span className="truncate text-[10px] text-muted-foreground">
                      Bring back what you set aside on this branch
                    </span>
                  </span>
                </CommandItem>
              </CommandGroup>
            ) : null}

            {locals.length > 0 ? (
              <CommandGroup heading="Local">
                {locals.map((item) => (
                  <BranchRow
                    key={item.name}
                    item={item}
                    onSelect={() => {
                      if (!item.isCurrent) requestSwitch(cwd, item.name, status);
                      setOpen(false);
                    }}
                  />
                ))}
              </CommandGroup>
            ) : null}

            {remotes.length > 0 ? (
              <CommandGroup heading="Remote">
                {remotes.map((item) => (
                  <BranchRow
                    key={item.name}
                    item={item}
                    onSelect={() => {
                      requestSwitch(cwd, item.name, status);
                      setOpen(false);
                    }}
                  />
                ))}
              </CommandGroup>
            ) : null}
          </CommandList>

          {hasRemotes || canPull || fetchNote ? (
            <div className="border-t border-border/50">
              {hasRemotes || canPull ? (
                <div className="flex items-center justify-between gap-2 px-1.5 py-1.5">
                  <div className="flex items-center gap-0.5">
                    {hasRemotes ? (
                      <FooterAction
                        icon={fetching ? Loading03Icon : ArrowReloadHorizontalIcon}
                        label={fetching ? "Fetching…" : "Fetch"}
                        spinning={fetching}
                        disabled={fetching}
                        tooltip="Refresh the branch list from the remote — new branches show up here."
                        onClick={() => void onFetch()}
                      />
                    ) : null}
                    {canPull ? (
                      <FooterAction
                        icon={CloudDownloadIcon}
                        label="Pull"
                        count={status.behind}
                        tooltip={`Fast-forward ${current} to the latest — ${status.behind} commit${status.behind === 1 ? "" : "s"} behind.`}
                        onClick={() => {
                          pullOnly(cwd, current ?? "");
                          setOpen(false);
                        }}
                      />
                    ) : null}
                  </div>
                  {hasRemotes && lastFetched !== null && !fetching ? (
                    <span className="shrink-0 px-1 text-[10px] tabular-nums text-muted-foreground/55">
                      fetched {relativeTime(lastFetched)}
                    </span>
                  ) : null}
                </div>
              ) : null}

              {fetchNote ? (
                <div
                  className={cn(
                    "flex items-start gap-1.5 px-2.5 py-1.5 text-[10.5px] leading-snug text-amber-600 dark:text-amber-400",
                    (hasRemotes || canPull) && "border-t border-border/40",
                  )}
                >
                  <HugeiconsIcon
                    icon={AlertCircleIcon}
                    size={11}
                    strokeWidth={1.75}
                    className="mt-px shrink-0"
                  />
                  <span className="min-w-0">{fetchNote}</span>
                </div>
              ) : null}
            </div>
          ) : null}
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function BranchRow({
  item,
  onSelect,
}: {
  item: BranchListItem;
  onSelect: () => void;
}) {
  return (
    <CommandItem
      value={item.name}
      onSelect={onSelect}
      className="items-center gap-2"
    >
      <span className="grid size-3.5 shrink-0 place-items-center text-primary">
        {item.isCurrent ? (
          <HugeiconsIcon icon={Tick02Icon} size={11} strokeWidth={2.5} />
        ) : null}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[12px]">
        {item.short}
      </span>
      {item.isCurrent ? (
        <span className="shrink-0 rounded-sm bg-primary/12 px-1 text-[9px] font-medium uppercase tracking-wide text-primary">
          current
        </span>
      ) : item.kind === "remote" ? (
        <span
          title={`On ${item.remote ?? "remote"} only — switching creates a local copy that tracks it`}
          className="shrink-0 rounded-sm bg-foreground/[0.06] px-1 text-[9px] font-medium uppercase tracking-wide text-muted-foreground"
        >
          {item.remote ?? "remote"}
        </span>
      ) : null}
    </CommandItem>
  );
}

/** A compact, tooltip-backed action in the switcher footer (Fetch / Pull). */
function FooterAction({
  icon,
  label,
  tooltip,
  count,
  spinning,
  disabled,
  onClick,
}: {
  icon: typeof CloudDownloadIcon;
  label: string;
  tooltip: string;
  count?: number;
  spinning?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          onClick={onClick}
          className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[10.5px] font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-60 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
        >
          <HugeiconsIcon
            icon={icon}
            size={12}
            strokeWidth={1.75}
            className={cn(spinning && "animate-spin")}
          />
          {label}
          {typeof count === "number" ? (
            <span className="tabular-nums text-muted-foreground/60">{count}</span>
          ) : null}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[220px] text-[11px]">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}

/** Compact relative time ("just now", "4m ago") for the last fetch. */
function relativeTime(ts: number): string {
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (secs < 10) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  return `${hrs}h ago`;
}

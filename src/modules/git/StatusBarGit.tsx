import { useEffect, useRef, useState, type ReactNode } from "react";
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
  ArrowLeft01Icon,
  ArrowReloadHorizontalIcon,
  ArrowRight01Icon,
  ArrowUp01Icon,
  CloudDownloadIcon,
  FolderAddIcon,
  FolderOpenIcon,
  GitBranchIcon,
  Loading03Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useActionToast } from "@/components/actionToastStore";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { autoBindRepos } from "@/modules/ado/repoBinding";
import {
  addRepo,
  onGetSourceCodeRequested,
  type WorkspaceRepo,
} from "@/modules/settings/store";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  EMPTY_STATUS,
  emitSourceGitChanged,
  gitBranches,
  gitFetch,
  type BranchListItem,
  type GitStatusSummary,
} from "./gitOps";
import { useReposStatus } from "./useReposGit";
import { isBranchOpBusy, useBranchSwitch } from "./useBranchSwitch";
import { GetSourceCodeDialog } from "./GetSourceCodeDialog";

/**
 * Bottom status-bar git widget: the workspace's source repos + a live branch
 * switcher. At one repo it is the single source-directory control it always was
 * — the folder segment opens the directory picker (showing "Pick source
 * directory…" until one is set), and the branch segment opens a switcher that
 * checks out the chosen branch and fast-forward-pulls it (asking what to do with
 * uncommitted work first). At more than one it summarises the workspace and the
 * switcher gains a repo list in front of the branch list; every repo carries its
 * own status, so nothing is ever read from, or applied to, the wrong one.
 */
export function StatusBarGit({ onPickDir }: { onPickDir: () => void }) {
  const repos = usePreferencesStore((s) => s.repos);
  const statuses = useReposStatus();
  const multi = repos.length > 1;

  const single = repos[0] ?? null;
  const sourceRoot = single?.root ?? null;
  const status = (single ? statuses.get(single.id) : undefined) ?? EMPTY_STATUS;

  // The Get source code wizard is hosted here rather than inside a switcher so
  // it can be opened at ANY repo count — including from the Settings window,
  // which runs the clone through this window's pipeline, not a second one.
  const [sourceDialogOpen, setSourceDialogOpen] = useState(false);
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    void onGetSourceCodeRequested(() => setSourceDialogOpen(true)).then((un) => {
      if (cancelled) un();
      else unlisten = un;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return (
    <div className="flex h-5 items-stretch overflow-hidden rounded-md border border-border/60 bg-card text-[10.5px]">
      {multi ? (
        <ReposSegment repos={repos} />
      ) : (
        <FolderSegment sourceRoot={sourceRoot} onPickDir={onPickDir} />
      )}

      <span aria-hidden className="w-px self-stretch bg-border/70" />

      {multi ? (
        <ReposSwitcher
          repos={repos}
          statuses={statuses}
          onGetSourceCode={() => setSourceDialogOpen(true)}
        />
      ) : sourceRoot && status.isRepo ? (
        <BranchSwitcher cwd={sourceRoot} status={status} />
      ) : (
        <GetSourceCodeButton sourceRoot={sourceRoot} notRepoButSet={!!sourceRoot} />
      )}

      {/* Seeded with a configured repo so the destination defaults to the
          folder the others already live in. */}
      <GetSourceCodeDialog
        open={sourceDialogOpen}
        onOpenChange={setSourceDialogOpen}
        sourceRoot={sourceRoot}
      />
    </div>
  );
}

/** The single-repo folder segment: picking a folder replaces the workspace. */
function FolderSegment({
  sourceRoot,
  onPickDir,
}: {
  sourceRoot: string | null;
  onPickDir: () => void;
}) {
  const last = sourceRoot
    ? sourceRoot.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? ""
    : "";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onPickDir}
          className={SEGMENT_CLASS}
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
  );
}

/** The multi-repo folder segment. Clicking opens Settings rather than the
 *  directory picker: that picker collapses the workspace to one folder, which
 *  would silently drop the rest. */
function ReposSegment({ repos }: { repos: WorkspaceRepo[] }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => void openSettingsWindow("general")}
          className={SEGMENT_CLASS}
          aria-label="Source repos"
        >
          <HugeiconsIcon icon={FolderOpenIcon} size={11} strokeWidth={1.75} />
          <span>{repos.length} repos</span>
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        align="start"
        sideOffset={6}
        variant="panel"
        className="max-w-[420px] px-3 py-2 text-[11px] leading-relaxed"
      >
        <div className="flex flex-col gap-1">
          {repos.slice(0, 8).map((repo) => (
            <div key={repo.id} className="flex items-baseline gap-1.5">
              <span className="shrink-0 text-[10.5px] text-foreground/90">
                {repo.name}
              </span>
              <span className="min-w-0 break-all font-mono text-[10px] text-muted-foreground/70">
                {repo.root}
              </span>
            </div>
          ))}
          {repos.length > 8 ? (
            <span className="text-[10px] text-muted-foreground/70">
              and {repos.length - 8} more
            </span>
          ) : null}
          <p className="mt-0.5 text-[10px] text-muted-foreground/70">
            Every AI feature reads all of them. Click to add or remove repos in
            Settings.
          </p>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Shown in place of the branch switcher when the source directory isn't a git
 * repo (or none is set): a call-to-action that opens the clone wizard. This is
 * the QA-tester on-ramp — they hand us an Azure DevOps PAT, so we can clone the
 * code it can read without them touching git themselves.
 */
function GetSourceCodeButton({
  sourceRoot,
  notRepoButSet,
}: {
  sourceRoot: string | null;
  notRepoButSet: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className={SEGMENT_CLASS}
            aria-label="Get source code"
          >
            <HugeiconsIcon icon={CloudDownloadIcon} size={11} strokeWidth={1.75} />
            <span>Get source code</span>
          </button>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          align="start"
          sideOffset={6}
          variant="panel"
          className="max-w-[320px] px-3 py-2 text-[11px] leading-relaxed"
        >
          {notRepoButSet
            ? "This folder isn't a git repository. Clone one here to enable code links and branch switching."
            : "Clone a repository onto this machine — using your Azure DevOps token, or any HTTPS URL."}
        </TooltipContent>
      </Tooltip>
      <GetSourceCodeDialog open={open} onOpenChange={setOpen} sourceRoot={sourceRoot} />
    </>
  );
}

/** Single-repo switcher: the branch pill straight onto the branch list. */
function BranchSwitcher({
  cwd,
  status,
}: {
  cwd: string;
  status: GitStatusSummary;
}) {
  const [open, setOpen] = useState(false);
  const busy = isBranchOpBusy(useBranchSwitch((s) => s.toasts.get(cwd)));

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
              className={cn(SEGMENT_CLASS, SEGMENT_OPEN_CLASS)}
              aria-label="Switch git branch"
            >
              <HugeiconsIcon icon={GitBranchIcon} size={11} strokeWidth={1.75} />
              <span className="max-w-[150px] truncate font-mono text-[10.5px]">
                {branchLabel(status)}
              </span>
              {status.dirty ? <DirtyDot /> : null}
              {status.parkedHere ? <ParkedMark /> : null}
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

      <PopoverContent
        side="top"
        align="start"
        sideOffset={6}
        className="w-[300px] p-0"
        onOpenAutoFocus={focusCommandSurface}
      >
        <BranchList cwd={cwd} status={status} onClose={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

/** Multi-repo switcher: the repo list, drilling into one repo's branch list. */
function ReposSwitcher({
  repos,
  statuses,
  onGetSourceCode,
}: {
  repos: WorkspaceRepo[];
  statuses: Map<string, GitStatusSummary>;
  onGetSourceCode: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [drilledId, setDrilledId] = useState<string | null>(null);
  const toasts = useBranchSwitch((s) => s.toasts);

  // Closing has to go through here, not a bare setOpen: the popover's `open` is
  // controlled, so a programmatic close never fires onOpenChange — and a drilled
  // repo left behind would greet the next open with the wrong repo's branches.
  const close = () => {
    setOpen(false);
    setDrilledId(null);
  };

  const statusOf = (repo: WorkspaceRepo) =>
    statuses.get(repo.id) ?? EMPTY_STATUS;
  // A repo removed from the registry while the popover sat open falls back to
  // the list rather than drilling into nothing.
  const drilled = repos.find((r) => r.id === drilledId) ?? null;

  // Where the repos are, in one word: the branch when they agree, otherwise how
  // many places they're spread across. Falls back to the repo count rather than
  // naming one branch while some repo hasn't got one — the count is never wrong.
  const refs = repos
    .map((r) => (statusOf(r).isRepo ? branchLabel(statusOf(r)) : null))
    .filter((r): r is string => !!r);
  const distinct = new Set(refs);
  const label =
    refs.length === repos.length && distinct.size === 1
      ? refs[0]
      : distinct.size > 1
        ? `${distinct.size} branches`
        : `${repos.length} repos`;
  const dirty = repos.filter((r) => statusOf(r).dirty).length;
  const parked = repos.some((r) => statusOf(r).parkedHere);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => (next ? setOpen(true) : close())}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cn(SEGMENT_CLASS, SEGMENT_OPEN_CLASS)}
              aria-label="Switch a repo's git branch"
            >
              <HugeiconsIcon icon={GitBranchIcon} size={11} strokeWidth={1.75} />
              <span className="max-w-[150px] truncate font-mono text-[10.5px]">
                {label}
              </span>
              {dirty > 0 ? (
                <>
                  <DirtyDot />
                  <span className="shrink-0 text-[10px] text-muted-foreground/80">
                    {dirty} dirty
                  </span>
                </>
              ) : null}
              {parked ? <ParkedMark /> : null}
              <HugeiconsIcon
                icon={ArrowDown01Icon}
                size={9}
                strokeWidth={2}
                className="shrink-0 text-muted-foreground/60"
              />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[280px] text-[11px]">
          Pick a repo to switch its branch, pull it, or restore changes you left
          on it. Each repo moves on its own.
        </TooltipContent>
      </Tooltip>

      <PopoverContent
        side="top"
        align="start"
        sideOffset={6}
        className="w-[300px] p-0"
        onOpenAutoFocus={focusCommandSurface}
      >
        {drilled ? (
          <BranchList
            cwd={drilled.root}
            status={statusOf(drilled)}
            repoName={drilled.name}
            onBack={() => setDrilledId(null)}
            onClose={close}
          />
        ) : (
          <RepoList
            repos={repos}
            statusOf={statusOf}
            busyOf={(repo) => isBranchOpBusy(toasts.get(repo.root))}
            onPick={(repo) => setDrilledId(repo.id)}
            onAdded={close}
            onGetSourceCode={() => {
              close();
              onGetSourceCode();
            }}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

function RepoList({
  repos,
  statusOf,
  busyOf,
  onPick,
  onAdded,
  onGetSourceCode,
}: {
  repos: WorkspaceRepo[];
  statusOf: (repo: WorkspaceRepo) => GitStatusSummary;
  busyOf: (repo: WorkspaceRepo) => boolean;
  onPick: (repo: WorkspaceRepo) => void;
  onAdded: () => void;
  onGetSourceCode: () => void;
}) {
  const addFolder = async () => {
    let picked: string | string[] | null;
    try {
      picked = await openDialog({
        directory: true,
        multiple: false,
        title: "Choose a source repository",
        defaultPath: repos[0]?.root ?? undefined,
      });
    } catch {
      return; // the picker itself failed to open
    }
    if (typeof picked !== "string" || picked.length === 0) return; // cancelled
    try {
      const added = await addRepo(picked);
      void autoBindRepos([added]);
      onAdded();
    } catch {
      // `openDialog` RESOLVES null on cancel rather than throwing, so this is a
      // real registry-write failure. Silently doing nothing leaves the popover
      // sitting open with no reason to retry.
      useActionToast.getState().show({
        tone: "error",
        message: "Couldn't add that folder.",
      });
    }
  };

  return (
    // `tabIndex` so the popover can hand focus here when there's no search box
    // to take it — cmdk routes arrow keys off this element's keydown.
    <Command tabIndex={-1}>
      {/* A search box earns its space only once scanning the list is work. */}
      {repos.length > 6 ? <CommandInput placeholder="Find a repo…" /> : null}
      <CommandList className="max-h-[280px]">
        <CommandEmpty>No repos match.</CommandEmpty>
        <CommandGroup>
          {repos.map((repo) => (
            <RepoRow
              key={repo.id}
              repo={repo}
              status={statusOf(repo)}
              busy={busyOf(repo)}
              onSelect={() => onPick(repo)}
            />
          ))}
        </CommandGroup>
      </CommandList>
      <div className="-mb-1 border-t border-border/50">
        <div className="flex items-center gap-0.5 px-1.5 py-1.5">
          <FooterAction
            icon={FolderAddIcon}
            label="Add folder…"
            tooltip="Add a repository already on this machine. Every AI feature starts reading it; nothing on disk is touched."
            onClick={() => void addFolder()}
          />
          {/* Same wizard, and deliberately the same words, as the "Get source
              code" segment — which only shows when NO repo is configured, so
              the moment a tester had one the way to get the next one off Azure
              DevOps disappeared. This is where they come looking for it. */}
          <FooterAction
            icon={CloudDownloadIcon}
            label="Get source code…"
            tooltip="Clone a repository onto this machine — using your Azure DevOps token, or any HTTPS URL — and add it to the workspace."
            onClick={onGetSourceCode}
          />
        </div>
      </div>
    </Command>
  );
}

function RepoRow({
  repo,
  status,
  busy,
  onSelect,
}: {
  repo: WorkspaceRepo;
  status: GitStatusSummary;
  busy: boolean;
  onSelect: () => void;
}) {
  return (
    <CommandItem
      value={repo.name}
      disabled={busy || !status.isRepo}
      onSelect={onSelect}
      className="items-center gap-2"
    >
      <span className="min-w-0 flex-1 truncate text-[12px]">{repo.name}</span>
      {busy ? (
        <span className="shrink-0 text-[10px] text-muted-foreground">
          working…
        </span>
      ) : !status.isRepo ? (
        <span className="shrink-0 text-[10px] text-muted-foreground/70">
          not a git repository
        </span>
      ) : (
        <>
          <span className="max-w-[9rem] shrink truncate font-mono text-[10.5px] text-muted-foreground">
            {branchLabel(status)}
          </span>
          {status.dirty ? <DirtyDot /> : null}
          {status.parkedHere ? <ParkedMark /> : null}
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
            icon={ArrowRight01Icon}
            size={11}
            strokeWidth={2}
            className="shrink-0 text-muted-foreground/50"
          />
        </>
      )}
    </CommandItem>
  );
}

/**
 * One repo's branch list — the switcher's actual content. Rendered directly
 * inside the popover at one repo, and behind a repo row at more than one, so
 * both paths run exactly the same switch / fetch / pull code against the cwd
 * they were handed.
 */
function BranchList({
  cwd,
  status,
  repoName,
  onBack,
  onClose,
}: {
  cwd: string;
  status: GitStatusSummary;
  repoName?: string;
  onBack?: () => void;
  onClose: () => void;
}) {
  const [branches, setBranches] = useState<BranchListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [lastFetched, setLastFetched] = useState<number | null>(null);
  const [fetchNote, setFetchNote] = useState<string | null>(null);
  // Holds the latest load's cancellation flag so the post-fetch reload below
  // can opt into the same cancellation as the effect-driven load (an unmounted
  // list or a changed cwd must not let a late branch list repaint).
  const loadSignal = useRef<{ cancelled: boolean } | null>(null);

  const requestSwitch = useBranchSwitch((s) => s.requestSwitch);
  const pullOnly = useBranchSwitch((s) => s.pullOnly);
  const restoreStash = useBranchSwitch((s) => s.restoreStash);

  const current = status.branch;
  // Pull is offered whenever the current branch tracks an upstream — not gated
  // on `behind`, because that count is only as fresh as the last fetch (it reads
  // the cached origin/<branch> ref). `git pull --ff-only` fetches first, so it's
  // correct even when the cached count says 0, and a safe no-op when truly in
  // sync. Gating on `behind` is what made pulling the current branch impossible
  // without first switching away and back.
  const canPull = !!current && !!status.upstream;

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
    const signal = { cancelled: false };
    loadSignal.current = signal;
    setFetchNote(null);
    loadBranches(signal);
    return () => {
      signal.cancelled = true;
      if (loadSignal.current === signal) loadSignal.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd]);

  const onFetch = async () => {
    setFetching(true);
    setFetchNote(null);
    try {
      const res = await gitFetch(cwd);
      if (res.status === "fetched") {
        setLastFetched(Date.now());
        // Reuse the current load signal so a list that unmounted (or a cwd that
        // changed) while the fetch was in flight cancels this reload too. No
        // signal means exactly that case — the effect's cleanup cleared it —
        // so there is nothing left to reload into.
        if (loadSignal.current) loadBranches(loadSignal.current);
        // A fetch updates the cached origin/<branch> ref, which is what the
        // ahead/behind chips read — nudge the status poll so "Pull latest ↓N"
        // reflects what we just learned instead of lagging until the 30 s tick.
        emitSourceGitChanged(cwd);
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
    <Command>
      {onBack ? (
        <button
          type="button"
          onClick={onBack}
          className="flex w-full items-center gap-1.5 border-b border-border/50 px-2 py-1.5 text-left text-[11px] text-muted-foreground transition-colors hover:bg-foreground/[0.04] hover:text-foreground"
        >
          <HugeiconsIcon icon={ArrowLeft01Icon} size={12} strokeWidth={2} />
          <span className="min-w-0 flex-1 truncate font-medium text-foreground">
            {repoName}
          </span>
          <span className="shrink-0 text-[10px] text-muted-foreground/70">
            all repos
          </span>
        </button>
      ) : null}

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
                onClose();
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
                  onClose();
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
                  onClose();
                }}
              />
            ))}
          </CommandGroup>
        ) : null}
      </CommandList>

      {hasRemotes || canPull || fetchNote ? (
        // -mb-1 cancels the Command's bottom p-1 so the footer bar sits
        // flush against the popover's bottom edge (no dead strip below it).
        <div className="-mb-1 border-t border-border/50">
          {hasRemotes || canPull ? (
            <div className="flex items-center justify-between gap-2 px-1.5 py-1.5">
              <div className="flex items-center gap-0.5">
                {hasRemotes ? (
                  <FooterAction
                    icon={fetching ? Loading03Icon : ArrowReloadHorizontalIcon}
                    label={fetching ? "Fetching…" : "Fetch"}
                    spinning={fetching}
                    disabled={fetching}
                    tooltip="Check the remote for new branches and updates — without changing your files."
                    onClick={() => void onFetch()}
                  />
                ) : null}
                {canPull ? (
                  <FooterAction
                    icon={CloudDownloadIcon}
                    label="Pull latest"
                    trailing={
                      status.behind > 0 ? (
                        <span className="flex items-center gap-0.5 rounded-sm bg-primary/12 px-1 font-mono text-[9px] font-medium text-primary">
                          <HugeiconsIcon
                            icon={ArrowDown01Icon}
                            size={9}
                            strokeWidth={2.25}
                          />
                          {status.behind}
                        </span>
                      ) : null
                    }
                    tooltip={
                      status.behind > 0
                        ? `Fast-forward ${current} — ${status.behind} commit${status.behind === 1 ? "" : "s"} behind`
                        : `Fetch and fast-forward ${current} if it's behind`
                    }
                    onClick={() => {
                      pullOnly(cwd, current ?? "");
                      onClose();
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

/**
 * Where a switcher popover should put focus when it opens.
 *
 * Radix focuses the first TABBABLE node in the content, and cmdk rows are
 * `role="option"` divs — not tabbable. In the repo list, which only grows a
 * search box past six repos, that made the footer's "Add folder…" the first
 * tabbable node: a tooltip-backed button, and Radix Tooltip opens on focus, so
 * merely opening the switcher fired a tooltip for an action nobody had reached
 * for. Aim at the cmdk surface instead — its input when there is one, else the
 * list root, which is the element that routes arrow keys either way.
 */
function focusCommandSurface(e: Event) {
  const content = (e.currentTarget ?? e.target) as HTMLElement | null;
  const target =
    content?.querySelector<HTMLElement>("[cmdk-input]") ??
    content?.querySelector<HTMLElement>("[cmdk-root]");
  if (!target) return;
  e.preventDefault();
  target.focus();
}

/** A compact, tooltip-backed action in the switcher footer (Fetch / Pull). */
function FooterAction({
  icon,
  label,
  tooltip,
  trailing,
  spinning,
  disabled,
  onClick,
}: {
  icon: typeof CloudDownloadIcon;
  label: string;
  tooltip: string;
  /** Optional badge after the label (e.g. the behind-count chip on Pull). */
  trailing?: ReactNode;
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
          {trailing}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[220px] text-[11px]">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}

const SEGMENT_CLASS =
  "flex items-center gap-1 px-1.5 text-muted-foreground transition-colors hover:bg-foreground/[0.04] hover:text-foreground";
const SEGMENT_OPEN_CLASS =
  "disabled:opacity-60 data-[state=open]:bg-foreground/[0.05] data-[state=open]:text-foreground";

function DirtyDot() {
  return (
    <span
      aria-hidden
      title="Uncommitted changes"
      className="size-1.5 shrink-0 rounded-full bg-amber-500"
    />
  );
}

function ParkedMark() {
  return (
    <HugeiconsIcon
      icon={Archive02Icon}
      size={10}
      strokeWidth={1.75}
      className="shrink-0 text-primary"
    />
  );
}

/** What to call the checked-out ref: the branch, else the detached commit. */
function branchLabel(status: GitStatusSummary): string {
  return status.branch ?? (status.commit ? `(${status.commit})` : "(detached)");
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

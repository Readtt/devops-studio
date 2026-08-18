import { AdoRepoPicker } from "@/components/AdoRepoPicker";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { getConnection, type RepoRef } from "@/modules/ado";
import {
  autoBindRepos,
  bindRepo,
  bindingForAdoRepo,
} from "@/modules/ado/repoBinding";
import { joinPath } from "@/modules/ai/lib/repoPaths";
import { useReposGitInfo, type GitRepoInfo } from "@/modules/git";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  addRepo,
  emitGetSourceCodeRequested,
  onAdoConnectionChanged,
  removeRepo,
  renameRepo,
  sameRoot,
  setRepoAdo,
  validateRepoName,
  type WorkspaceRepo,
} from "@/modules/settings/store";
import {
  CloudDownloadIcon,
  Delete02Icon,
  FolderAddIcon,
  FolderSearchIcon,
  GitBranchIcon,
  Link01Icon,
  MoreHorizontalIcon,
  PencilEdit02Icon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState } from "react";

/**
 * The workspace's source repos, rendered as a block of the General tab.
 *
 * Every code-reading surface sees this whole list; there is no active-repo
 * concept and no repo is special. Ordering is display order only.
 */
export function SourceReposPanel() {
  const repos = usePreferencesStore((s) => s.repos);
  const branches = useReposGitInfo();
  const adoConnected = useAdoConnected();
  const [scan, setScan] = useState<ScanState | null>(null);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);

  const addFolder = async () => {
    setAddError(null);
    let picked: string | string[] | null;
    try {
      picked = await openDialog({
        directory: true,
        multiple: false,
        title: "Choose a source repository",
        defaultPath: repos[0]?.root ?? undefined,
      });
    } catch {
      // The picker itself failed to open; nothing was chosen.
      return;
    }
    if (typeof picked !== "string" || picked.length === 0) return; // cancelled
    try {
      const added = await addRepo(picked);
      void autoBindRepos([added]);
    } catch {
      // `openDialog` RESOLVES null on cancel rather than throwing, so anything
      // that lands here is a real registry-write failure (settings file locked,
      // disk full). Swallowing it silently left the user picking a folder that
      // never appeared, with nothing said.
      setAddError("Couldn't add that folder. Try again.");
    }
  };

  // The wizard runs in the MAIN window — see `emitGetSourceCodeRequested`.
  // Bring that window forward, or it opens behind Settings and reads as a
  // button that did nothing.
  const requestSourceCode = async () => {
    setAddError(null);
    try {
      await emitGetSourceCodeRequested();
      await getAllWebviewWindows().then((wins) =>
        wins.find((w) => w.label === "main")?.setFocus(),
      );
    } catch {
      setAddError(
        "Couldn't open Get source code. Try it from the status bar instead.",
      );
    }
  };

  const scanFolder = async () => {
    let parent: string | null = null;
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: "Choose a folder that contains your clones",
        defaultPath: repos[0]?.root ?? undefined,
      });
      if (typeof picked !== "string" || picked.length === 0) return;
      parent = picked;
    } catch {
      return;
    }
    setScan({ parent, found: null });
    const found = await findGitDirs(parent);
    // Guard against a second scan started while this one was walking.
    setScan((s) => (s && s.parent === parent ? { ...s, found } : s));
  };

  return (
    <div className="flex flex-col gap-2">
      <p className="max-w-[440px] text-[10.5px] leading-relaxed text-muted-foreground/70">
        The repositories DevOps Studio reads code from. Every AI feature sees all
        of them, and published code links resolve against them. Add as many as
        the work spans.
      </p>

      {repos.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/60 bg-card/40 px-4 py-6 text-center">
          <p className="text-[12px] text-muted-foreground">
            No source repos yet.
          </p>
          <p className="mx-auto mt-1 max-w-[420px] text-[10.5px] leading-relaxed text-muted-foreground/80">
            Add the folders your feature lives in. Until you do, the generator
            can&rsquo;t ground test cases in real code, Commit Review has nothing
            to review, and the status bar has no branch to show.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {repos.map((repo) => (
            <RepoRow
              key={repo.id}
              repo={repo}
              otherNames={repos
                .filter((r) => r.id !== repo.id)
                .map((r) => r.name)}
              git={branches.get(repo.id)}
              adoConnected={adoConnected}
              renameRequested={renameId === repo.id}
              onRenameHandled={() => setRenameId(null)}
              onRequestRename={() => setRenameId(repo.id)}
            />
          ))}
        </div>
      )}

      <div className="flex items-center gap-2 pt-0.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" variant="outline" onClick={() => void addFolder()}>
              <HugeiconsIcon icon={FolderAddIcon} size={12} strokeWidth={1.75} />
              Add folder…
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-[280px] text-[11px]">
            Pick one repository folder. It&rsquo;s named after the folder — you
            can rename it after, and nothing on disk is touched.
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" variant="ghost" onClick={() => void scanFolder()}>
              <HugeiconsIcon
                icon={FolderSearchIcon}
                size={12}
                strokeWidth={1.75}
              />
              Scan a folder…
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-[280px] text-[11px]">
            Pick a folder you cloned several repos into. DevOps Studio lists the
            git repositories directly inside it and you choose which to add.
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void requestSourceCode()}
            >
              <HugeiconsIcon
                icon={CloudDownloadIcon}
                size={12}
                strokeWidth={1.75}
              />
              Get source code…
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-[280px] text-[11px]">
            Don&rsquo;t have the repo on this machine yet? Clone it with your
            Azure DevOps token (or any HTTPS URL) and it&rsquo;s added here when
            it lands. Opens in the main window.
          </TooltipContent>
        </Tooltip>
      </div>

      {addError ? (
        <p className="text-[11px] leading-relaxed text-destructive">{addError}</p>
      ) : null}

      <ScanDialog
        scan={scan}
        repos={repos}
        onClose={() => setScan(null)}
      />
    </div>
  );
}

function RepoRow({
  repo,
  otherNames,
  git,
  adoConnected,
  renameRequested,
  onRenameHandled,
  onRequestRename,
}: {
  repo: WorkspaceRepo;
  otherNames: string[];
  git: GitRepoInfo | undefined;
  adoConnected: boolean;
  renameRequested: boolean;
  onRenameHandled: () => void;
  onRequestRename: () => void;
}) {
  const [draft, setDraft] = useState(repo.name);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [adoNote, setAdoNote] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // A binding that landed (from here or another window) answers whatever the
  // note was complaining about.
  useEffect(() => {
    if (repo.ado) setAdoNote(null);
  }, [repo.ado]);

  const detect = async () => {
    setDetecting(true);
    setAdoNote(null);
    const outcome = await bindRepo(repo).catch(
      () => ({ status: "unavailable", message: "Couldn't reach Azure DevOps." }) as const,
    );
    setDetecting(false);
    if (outcome.status === "no-match") {
      setAdoNote(
        "No Azure DevOps repository matches this folder's remote or name. Pick one with “Set ADO repo…”.",
      );
    } else if (outcome.status === "unavailable") {
      setAdoNote(outcome.message);
    }
  };

  const pick = (ref: RepoRef | null) => {
    if (!ref) {
      void setRepoAdo(repo.id, null);
      return;
    }
    const ado = bindingForAdoRepo(ref);
    if (!ado) {
      setAdoNote(
        `Azure DevOps didn't report which project ${ref.name} belongs to, so code links can't be built for it.`,
      );
      return;
    }
    setAdoNote(null);
    void setRepoAdo(repo.id, ado);
  };

  // Follow a rename that landed elsewhere (another window, or the registry
  // de-duping the name we just sent) without stomping an in-progress edit.
  useEffect(() => {
    setDraft(repo.name);
    setError(null);
  }, [repo.name]);

  useEffect(() => {
    if (!renameRequested) return;
    inputRef.current?.focus();
    inputRef.current?.select();
    onRenameHandled();
  }, [renameRequested, onRenameHandled]);

  // Committed on blur/Enter rather than per keystroke: `renameRepo` re-uniquifies,
  // so live-writing would turn "repo" into "repo-2" under the user's cursor the
  // moment they typed a name that momentarily collides.
  const commit = () => {
    const next = draft.trim();
    if (next === repo.name) {
      setError(null);
      return;
    }
    const problem = validateRepoName(next, otherNames);
    setError(problem);
    if (!problem) void renameRepo(repo.id, next);
  };

  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border/60 bg-card/60 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <Input
          ref={inputRef}
          value={draft}
          aria-label="Repo name"
          aria-invalid={error != null}
          onChange={(e) => {
            setDraft(e.currentTarget.value);
            if (error) setError(null);
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.currentTarget.blur();
            } else if (e.key === "Escape") {
              setDraft(repo.name);
              setError(null);
            }
          }}
          className="h-7 w-[180px] text-[11.5px]"
        />
        <BranchCell git={git} />
        <AdoCell
          repo={repo}
          connected={adoConnected}
          detecting={detecting}
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          onPick={pick}
        />
        <RowMenu
          repo={repo}
          adoConnected={adoConnected}
          onRename={onRequestRename}
          onSetAdoRepo={() => setPickerOpen(true)}
          onDetectAdoRepo={() => void detect()}
        />
      </div>

      <Tooltip>
        <TooltipTrigger asChild>
          <span className="block truncate pl-1 font-mono text-[10.5px] text-muted-foreground">
            {repo.root}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-[420px] break-all text-[11px]">
          {repo.root}
        </TooltipContent>
      </Tooltip>

      {error ? (
        <p className="pl-1 text-[10.5px] leading-relaxed text-destructive">
          {error}
        </p>
      ) : null}

      {adoNote ? (
        <p className="pl-1 text-[10.5px] leading-relaxed text-muted-foreground">
          {adoNote}
        </p>
      ) : null}
    </div>
  );
}

function BranchCell({ git }: { git: GitRepoInfo | undefined }) {
  if (!git) return <Skeleton className="h-3.5 w-20 shrink-0" />;
  if (!git.isRepo) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="shrink-0 truncate text-[10.5px] text-muted-foreground/70">
            not a git repository
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-[280px] text-[11px]">
          Still readable by every AI feature — only branch and commit
          provenance on published links need git.
        </TooltipContent>
      </Tooltip>
    );
  }
  const label = git.branch ?? (git.commit ? `${git.commit} (detached)` : "—");
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex min-w-0 shrink items-center gap-1 text-[10.5px] text-muted-foreground">
          <HugeiconsIcon
            icon={GitBranchIcon}
            size={11}
            strokeWidth={1.75}
            className="shrink-0"
          />
          <span className="truncate font-mono">{label}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-[280px] text-[11px]">
        {git.detached
          ? "Detached HEAD — published links stamp the commit but no branch."
          : `Currently on ${label}. Published code links track whatever branch this repo is on at publish time.`}
      </TooltipContent>
    </Tooltip>
  );
}

/** Which ADO repository this folder publishes code links into.
 *
 *  Clickable at every state EXCEPT "no connection": a picker listing nothing,
 *  with no way to fix it from here, is worse than a sentence saying what to do. */
function AdoCell({
  repo,
  connected,
  detecting,
  open,
  onOpenChange,
  onPick,
}: {
  repo: WorkspaceRepo;
  connected: boolean;
  detecting: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (ref: RepoRef | null) => void;
}) {
  if (!connected) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="ml-auto shrink-0 truncate text-[10.5px] text-muted-foreground/60">
            connect Azure DevOps to link repos
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-[280px] text-[11px]">
          Code links deep-link into an Azure DevOps repository, so linking needs
          a connection. Set one up on the Azure DevOps page.
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <AdoRepoPicker
      value={repo.ado?.repoId ?? null}
      onChange={onPick}
      open={open}
      onOpenChange={onOpenChange}
      tooltip={
        repo.ado
          ? `Code links published from this repo point at ${repo.ado.repoName} in ${repo.ado.project}. Click to change it.`
          : "No Azure DevOps repository resolved yet, so code links from this repo can't deep-link into ADO. Click to pick one."
      }
    >
      <button
        type="button"
        aria-label={`Azure DevOps repository for ${repo.name}`}
        className={cn(
          "ml-auto flex h-6 min-w-0 shrink items-center gap-1 rounded-md border border-transparent px-1.5 text-[10.5px] transition-colors",
          "hover:bg-foreground/[0.04] data-[state=open]:bg-foreground/[0.04]",
          repo.ado ? "text-muted-foreground" : "text-muted-foreground/60",
        )}
      >
        <HugeiconsIcon
          icon={Link01Icon}
          size={11}
          strokeWidth={1.75}
          className="shrink-0"
        />
        <span className="truncate">
          {detecting
            ? "linking…"
            : repo.ado
              ? `ADO: ${repo.ado.repoName}`
              : "not linked"}
        </span>
      </button>
    </AdoRepoPicker>
  );
}

function RowMenu({
  repo,
  adoConnected,
  onRename,
  onSetAdoRepo,
  onDetectAdoRepo,
}: {
  repo: WorkspaceRepo;
  adoConnected: boolean;
  onRename: () => void;
  onSetAdoRepo: () => void;
  onDetectAdoRepo: () => void;
}) {
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 shrink-0 text-muted-foreground"
              aria-label={`Actions for ${repo.name}`}
            >
              <HugeiconsIcon
                icon={MoreHorizontalIcon}
                size={14}
                strokeWidth={1.75}
              />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-[11px]">
          Rename, link to Azure DevOps, or remove this repo
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="min-w-52 p-1">
        <DropdownMenuItem
          // Deferred for the same reason as the item below: the menu hands
          // focus back to its trigger as it unmounts, which steals the focus
          // the rename effect just put in the name field — the action looks
          // like it did nothing.
          onSelect={() => setTimeout(onRename, 0)}
          className="flex items-center gap-2 text-[12px]"
        >
          <HugeiconsIcon icon={PencilEdit02Icon} size={13} strokeWidth={1.75} />
          Rename
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!adoConnected}
          // Deferred: the menu closes on select and hands focus back as it
          // unmounts, which cancels a popover opened in the same tick.
          onSelect={() => setTimeout(onSetAdoRepo, 0)}
          className="flex items-center gap-2 text-[12px]"
        >
          <HugeiconsIcon icon={Link01Icon} size={13} strokeWidth={1.75} />
          Set ADO repo…
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!adoConnected}
          onSelect={onDetectAdoRepo}
          className="flex items-center gap-2 text-[12px]"
        >
          <HugeiconsIcon icon={RefreshIcon} size={13} strokeWidth={1.75} />
          Detect from remote
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onSelect={() => void removeRepo(repo.id)}
          className="flex items-center gap-2 text-[12px]"
        >
          <HugeiconsIcon icon={Delete02Icon} size={13} strokeWidth={1.75} />
          Remove from workspace
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Whether the app can reach the ADO org at all — `configured` is org URL +
 *  PAT, which is exactly what the org-wide repo list needs. Re-read on the
 *  connection event so linking lights up the moment the user connects, without
 *  reopening Settings. */
function useAdoConnected(): boolean {
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const read = () => {
      void getConnection()
        .then((s) => {
          if (!cancelled) setConnected(s.configured);
        })
        .catch(() => {
          if (!cancelled) setConnected(false);
        });
    };
    read();
    let unlisten: UnlistenFn | null = null;
    void onAdoConnectionChanged(read).then((un) => {
      if (cancelled) un();
      else unlisten = un;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return connected;
}

/* -------------------------------------------------------------------------- */
/*  Scan a folder                                                              */
/* -------------------------------------------------------------------------- */

type ScanCandidate = { root: string; name: string };
/** `found: null` is the walk still running — distinct from `[]`, "nothing here". */
type ScanState = { parent: string; found: ScanCandidate[] | null };

/** One `fs_read_dir` row (`src-tauri/src/modules/fs/tree.rs`). */
type DirEntry = {
  name: string;
  kind: "file" | "dir" | "symlink";
  size: number;
  mtime: number;
};

/** One level down from `parent`, keeping the directories that carry a `.git`.
 *  A worktree or submodule has `.git` as a FILE, so this stats it rather than
 *  listing it — both spellings are a real repo. */
async function findGitDirs(parent: string): Promise<ScanCandidate[]> {
  let entries: DirEntry[];
  try {
    entries = await invoke<DirEntry[]>("fs_read_dir", {
      path: parent,
      showHidden: false,
    });
  } catch {
    return [];
  }
  const dirs = entries.filter((e) => e.kind === "dir");
  const checked = await Promise.all(
    dirs.map(async (d) => {
      const root = joinPath(parent, d.name);
      // fs_stat REJECTS on a missing path rather than returning null.
      const isRepo = await invoke("fs_stat", { path: joinPath(root, ".git") })
        .then(() => true)
        .catch(() => false);
      return isRepo ? { root, name: d.name } : null;
    }),
  );
  return checked.filter((c): c is ScanCandidate => c !== null);
}

function ScanDialog({
  scan,
  repos,
  onClose,
}: {
  scan: ScanState | null;
  repos: WorkspaceRepo[];
  onClose: () => void;
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [failed, setFailed] = useState<number>(0);

  const found = scan?.found ?? null;
  const rows = (found ?? []).map((c) => ({
    ...c,
    added: repos.some((r) => sameRoot(r.root, c.root)),
  }));
  const addable = rows.filter((r) => !r.added);

  // Pre-select everything new the moment results land — the common case is
  // "add them all", and the checkboxes are there to remove the exceptions.
  const resultKey = rows.map((r) => `${r.root}:${r.added}`).join("|");
  useEffect(() => {
    setPicked(new Set(addable.map((r) => r.root)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resultKey]);

  // Recomputed rather than read off `picked`, so a repo added from another
  // window while this dialog sat open drops out of the count too.
  const toAdd = addable.filter((r) => picked.has(r.root));

  const confirm = async () => {
    setAdding(true);
    setFailed(0);
    let misses = 0;
    try {
      // Sequential: addRepo is read-modify-write against the shared registry,
      // so racing them would let later writes clobber earlier ones. Per-repo
      // try/catch because one folder failing (a root that vanished between the
      // scan and the confirm) must not abandon the rest of the batch.
      const added: WorkspaceRepo[] = [];
      for (const candidate of toAdd) {
        try {
          added.push(await addRepo(candidate.root));
        } catch {
          misses += 1;
        }
      }
      // One org-wide fetch for the whole batch, and not worth waiting on — the
      // repos are in the workspace either way.
      void autoBindRepos(added);
    } finally {
      setAdding(false);
      setFailed(misses);
      // Closing on a failure would tear down the only list the user could
      // retry from, having said nothing. The ones that landed drop out of
      // `addable` on their own, so what stays is exactly what still needs a
      // second try.
      if (misses === 0) onClose();
    }
  };

  return (
    <Dialog open={scan !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Add repositories</DialogTitle>
          <DialogDescription className="break-all">
            Git repositories directly inside{" "}
            <span className="font-mono">{scan?.parent}</span>.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[280px] overflow-y-auto">
          {found === null ? (
            <div className="flex flex-col gap-2">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <p className="py-6 text-center text-[11.5px] text-muted-foreground">
              No git repositories directly inside this folder. Pick the folder
              that <em>contains</em> your clones, not a clone itself.
            </p>
          ) : (
            <div className="flex flex-col gap-1">
              {rows.map((r) => (
                <label
                  key={r.root}
                  className={cn(
                    "flex items-center gap-2.5 rounded-md px-2 py-1.5",
                    r.added
                      ? "opacity-55"
                      : "cursor-pointer hover:bg-muted/40",
                  )}
                >
                  <Checkbox
                    checked={r.added || picked.has(r.root)}
                    disabled={r.added}
                    onCheckedChange={(v) =>
                      setPicked((s) => {
                        const next = new Set(s);
                        if (v) next.add(r.root);
                        else next.delete(r.root);
                        return next;
                      })
                    }
                  />
                  <span className="min-w-0 flex-1 truncate text-[12px]">
                    {r.name}
                  </span>
                  {r.added ? (
                    <span className="shrink-0 text-[10.5px] text-muted-foreground">
                      already added
                    </span>
                  ) : null}
                </label>
              ))}
            </div>
          )}
        </div>

        {failed > 0 ? (
          <p className="text-[11px] leading-relaxed text-destructive">
            {failed === 1 ? "1 folder" : `${failed} folders`} couldn&rsquo;t be
            added — check they still exist, then try again.
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => void confirm()}
            disabled={toAdd.length === 0 || adding}
          >
            {toAdd.length === 1 ? "Add 1 repo" : `Add ${toAdd.length} repos`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}


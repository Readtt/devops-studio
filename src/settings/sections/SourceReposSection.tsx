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
import type { DirEntry } from "@/modules/ai/lib/native";
import { useReposGitInfo, type GitRepoInfo } from "@/modules/git";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  addRepo,
  removeRepo,
  renameRepo,
  validateRepoName,
  type WorkspaceRepo,
} from "@/modules/settings/store";
import {
  Delete02Icon,
  FolderAddIcon,
  FolderSearchIcon,
  GitBranchIcon,
  MoreHorizontalIcon,
  PencilEdit02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState } from "react";

/** Join using the separator the parent path already speaks, so a Windows root
 *  doesn't come back half-forward-slashed and fail the registry's dedup key. */
function joinPath(parent: string, child: string): string {
  const sep = parent.includes("\\") && !parent.includes("/") ? "\\" : "/";
  return `${parent.replace(/[\\/]+$/, "")}${sep}${child}`;
}

/** Compare roots the way the registry does — same folder, either spelling. */
function sameRoot(a: string, b: string): boolean {
  const key = (p: string) =>
    p.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
  return key(a) === key(b);
}

/**
 * The workspace's source repos, rendered as a block of the General tab.
 *
 * Every code-reading surface sees this whole list; there is no active-repo
 * concept and no repo is special. Ordering is display order only.
 */
export function SourceReposPanel() {
  const repos = usePreferencesStore((s) => s.repos);
  const branches = useReposGitInfo();
  const [scan, setScan] = useState<ScanState | null>(null);
  const [renameId, setRenameId] = useState<string | null>(null);

  const addFolder = async () => {
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: "Choose a source repository",
        defaultPath: repos[0]?.root ?? undefined,
      });
      if (typeof picked === "string" && picked.length > 0) {
        await addRepo(picked);
      }
    } catch {
      // User cancelled — nothing to do.
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
      </div>

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
  renameRequested,
  onRenameHandled,
  onRequestRename,
}: {
  repo: WorkspaceRepo;
  otherNames: string[];
  git: GitRepoInfo | undefined;
  renameRequested: boolean;
  onRenameHandled: () => void;
  onRequestRename: () => void;
}) {
  const [draft, setDraft] = useState(repo.name);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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
        <AdoCell repo={repo} />
        <RowMenu repo={repo} onRename={onRequestRename} />
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

function AdoCell({ repo }: { repo: WorkspaceRepo }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "ml-auto shrink-0 truncate text-[10.5px]",
            repo.ado ? "text-muted-foreground" : "text-muted-foreground/60",
          )}
        >
          {repo.ado ? `ADO: ${repo.ado.repoName}` : "not linked"}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-[280px] text-[11px]">
        {repo.ado
          ? `Code links published from this repo point at ${repo.ado.repoName} in ${repo.ado.project}.`
          : "No Azure DevOps repository resolved yet, so code links from this repo can't deep-link into ADO."}
      </TooltipContent>
    </Tooltip>
  );
}

function RowMenu({
  repo,
  onRename,
}: {
  repo: WorkspaceRepo;
  onRename: () => void;
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
          Rename or remove this repo
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="min-w-44 p-1">
        <DropdownMenuItem
          onSelect={onRename}
          className="flex items-center gap-2 text-[12px]"
        >
          <HugeiconsIcon icon={PencilEdit02Icon} size={13} strokeWidth={1.75} />
          Rename
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

/* -------------------------------------------------------------------------- */
/*  Scan a folder                                                              */
/* -------------------------------------------------------------------------- */

type ScanCandidate = { root: string; name: string };
/** `found: null` is the walk still running — distinct from `[]`, "nothing here". */
type ScanState = { parent: string; found: ScanCandidate[] | null };

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
    try {
      // Sequential: addRepo is read-modify-write against the shared registry,
      // so racing them would let later writes clobber earlier ones.
      for (const candidate of toAdd) await addRepo(candidate.root);
    } finally {
      setAdding(false);
      onClose();
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


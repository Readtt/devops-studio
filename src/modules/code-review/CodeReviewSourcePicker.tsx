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
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  adoListBranches,
  adoListPullRequests,
  adoListRecentCommits,
  listRepos,
  type BranchRef,
  type CommitInfo,
  type PullRequestRef,
  type RepoRef,
} from "@/modules/ado";
import {
  ArrowDown01Icon,
  ArrowLeft02Icon,
  FolderLibraryIcon,
  GitBranchIcon,
  GitCommitIcon,
  GitPullRequestIcon,
  HardDriveIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useState } from "react";
import { describeSource, type CodeReviewSource } from "./source";

/**
 * Source selector for the Code Review pane. Review the local working-copy diff
 * (default) or an Azure DevOps commit / pull request.
 *
 * Built on the same cmdk Command + Popover pattern as BranchPicker so it reads
 * like the rest of the app's dropdowns (the old version used a raw native
 * <select> that looked unstyled). One popover, no nesting: pick a repo, pick a
 * branch, then pick from its recent commits — or flip to the PR list. Switching
 * the source wipes the conversation (different change).
 */

const BRANCH_PRIORITY = ["main", "master", "develop"];

export function CodeReviewSourcePicker({
  source,
  onChange,
  disabled,
}: {
  source: CodeReviewSource | null;
  onChange: (s: CodeReviewSource | null) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  // Tooltip is controlled so it can be force-closed while the popover is open —
  // otherwise Radix Tooltip and Popover both portal over the trigger and the
  // hover tooltip overlaps the open dropdown.
  const [tipOpen, setTipOpen] = useState(false);

  // Navigation: null repo ⇒ root (local + repo list). Set ⇒ inside a repo.
  const [repo, setRepo] = useState<RepoRef | null>(null);
  const [mode, setMode] = useState<"commits" | "prs">("commits");
  const [branch, setBranch] = useState<string>("");
  const [pickingBranch, setPickingBranch] = useState(false);

  // Data.
  const [repos, setRepos] = useState<RepoRef[] | null>(null);
  const [branches, setBranches] = useState<BranchRef[] | null>(null);
  const [commits, setCommits] = useState<CommitInfo[] | null>(null);
  const [prs, setPrs] = useState<PullRequestRef[] | null>(null);

  // Reset navigation each time the popover opens so it starts at the root.
  useEffect(() => {
    if (open) {
      setRepo(null);
      setMode("commits");
      setBranch("");
      setPickingBranch(false);
    }
  }, [open]);

  // Repos — fetched once when the popover first opens.
  useEffect(() => {
    if (!open || repos !== null) return;
    let alive = true;
    void listRepos()
      .then((r) => alive && setRepos(r))
      .catch(() => alive && setRepos([]));
    return () => {
      alive = false;
    };
  }, [open, repos]);

  // Branches — refetched per repo. Seeds the branch to the repo default.
  useEffect(() => {
    if (!repo) return;
    let alive = true;
    setBranches(null);
    setBranch(repo.defaultBranch ?? "");
    void adoListBranches(repo.id)
      .then((b) => {
        if (!alive) return;
        setBranches(b);
        // If the repo had no default branch, fall back to a priority head.
        setBranch((cur) => cur || pickDefaultBranch(b));
      })
      .catch(() => alive && setBranches([]));
    return () => {
      alive = false;
    };
  }, [repo]);

  // Recent commits — refetched per (repo, branch) while in commits mode.
  useEffect(() => {
    if (!repo || !branch || mode !== "commits") return;
    let alive = true;
    setCommits(null);
    void adoListRecentCommits(repo.id, branch, 25)
      .then((c) => alive && setCommits(c))
      .catch(() => alive && setCommits([]));
    return () => {
      alive = false;
    };
  }, [repo, branch, mode]);

  // Pull requests — refetched per repo while in PR mode.
  useEffect(() => {
    if (!repo || mode !== "prs") return;
    let alive = true;
    setPrs(null);
    void adoListPullRequests(repo.id, 30)
      .then((p) => alive && setPrs(p))
      .catch(() => alive && setPrs([]));
    return () => {
      alive = false;
    };
  }, [repo, mode]);

  const sortedBranches = useMemo(
    () => sortBranches(branches ?? [], branch),
    [branches, branch],
  );

  const pickLocal = () => {
    onChange(null);
    setOpen(false);
  };
  const pickCommit = (commitId: string) => {
    if (!repo) return;
    onChange({
      kind: "ado",
      repoId: repo.id,
      repoName: repo.name,
      unit: "commit",
      commitId,
    });
    setOpen(false);
  };
  const pickPr = (pr: PullRequestRef) => {
    if (!repo) return;
    onChange({
      kind: "ado",
      repoId: repo.id,
      repoName: repo.name,
      unit: "pr",
      prId: pr.id,
    });
    setOpen(false);
  };

  // Reset cmdk's internal search when the visible list changes.
  const viewKey = !repo
    ? "root"
    : pickingBranch
      ? "branch"
      : `${mode}:${branch}`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip open={open ? false : tipOpen} onOpenChange={setTipOpen}>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={disabled}
              aria-label="Review source"
              className={cn(
                "inline-flex h-6 items-center gap-1.5 rounded-md border border-transparent px-1.5 text-[11.5px] transition-colors",
                "hover:bg-foreground/[0.04] data-[state=open]:bg-foreground/[0.04]",
                "disabled:cursor-not-allowed disabled:opacity-50",
                source ? "text-foreground/85" : "text-muted-foreground",
              )}
            >
              <HugeiconsIcon
                icon={source ? sourceIcon(source) : HardDriveIcon}
                size={12}
                strokeWidth={1.75}
                className="shrink-0 text-muted-foreground"
              />
              <span className="min-w-0 truncate">{describeSource(source)}</span>
              <HugeiconsIcon
                icon={ArrowDown01Icon}
                size={10}
                strokeWidth={2}
                className="shrink-0 text-muted-foreground/70"
              />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent
          variant="panel"
          side="bottom"
          align="start"
          className="max-w-[300px] px-3 py-2 text-[11px] leading-relaxed"
        >
          <div className="flex flex-col gap-1">
            <div className="flex items-baseline gap-1.5">
              <span className="font-mono text-[9.5px] uppercase tracking-wider text-muted-foreground/70">
                source
              </span>
              <span className="font-medium text-foreground/90">
                What this review reads
              </span>
            </div>
            <p className="text-foreground/80">
              Your local working-copy diff, or a commit / pull request / branch
              pulled straight from Azure DevOps.
            </p>
            <p className="mt-0.5 text-[10px] text-muted-foreground/70">
              Switching wipes the conversation.
            </p>
          </div>
        </TooltipContent>
      </Tooltip>

      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={4}
        className="w-80 gap-0 rounded-lg p-0"
      >
        {/* Sub-header: back nav + repo name + commits/PR segmented toggle. */}
        {repo ? (
          <div className="flex items-center gap-1.5 border-b border-border/45 px-2 py-1.5">
            <button
              type="button"
              onClick={() => {
                if (pickingBranch) setPickingBranch(false);
                else setRepo(null);
              }}
              className="grid size-5 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
              aria-label="Back"
            >
              <HugeiconsIcon icon={ArrowLeft02Icon} size={12} strokeWidth={1.75} />
            </button>
            <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-foreground">
              {repo.name}
            </span>
            {!pickingBranch ? (
              <div className="flex shrink-0 items-center gap-0.5 rounded-md bg-muted/50 p-0.5">
                <SegButton
                  active={mode === "commits"}
                  onClick={() => setMode("commits")}
                  icon={GitCommitIcon}
                  label="Commits"
                />
                <SegButton
                  active={mode === "prs"}
                  onClick={() => setMode("prs")}
                  icon={GitPullRequestIcon}
                  label="PRs"
                />
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Branch selector row (commits mode only) — opens the branch list. */}
        {repo && !pickingBranch && mode === "commits" ? (
          <button
            type="button"
            onClick={() => setPickingBranch(true)}
            className="flex w-full items-center gap-1.5 border-b border-border/30 px-2.5 py-1.5 text-left transition-colors hover:bg-foreground/[0.04]"
          >
            <HugeiconsIcon
              icon={GitBranchIcon}
              size={12}
              strokeWidth={1.75}
              className="shrink-0 text-muted-foreground"
            />
            <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-foreground/85">
              {branch || "Select a branch…"}
            </span>
            <span className="shrink-0 text-[10px] text-muted-foreground/70">
              change
            </span>
            <HugeiconsIcon
              icon={ArrowDown01Icon}
              size={10}
              strokeWidth={2}
              className="shrink-0 text-muted-foreground/70"
            />
          </button>
        ) : null}

        <Command key={viewKey}>
          <CommandInput
            placeholder={
              !repo
                ? "Search repositories…"
                : pickingBranch
                  ? "Search branches…"
                  : mode === "commits"
                    ? "Search recent commits…"
                    : "Search pull requests…"
            }
            className="h-8 text-[12px]"
          />
          <CommandList className="max-h-[300px]">
            {/* --- Root: local + repos --- */}
            {!repo ? (
              <>
                <CommandGroup>
                  <CommandItem
                    value="__local working copy__"
                    data-checked={!source}
                    onSelect={pickLocal}
                    className="gap-2 py-1.5"
                  >
                    <HugeiconsIcon
                      icon={HardDriveIcon}
                      size={13}
                      strokeWidth={1.75}
                      className="shrink-0 text-muted-foreground"
                    />
                    <span className="flex flex-1 flex-col">
                      <span className="text-[12px]">Local working copy</span>
                      <span className="text-[10px] text-muted-foreground/70">
                        Uncommitted + branch diff on disk
                      </span>
                    </span>
                  </CommandItem>
                </CommandGroup>
                <CommandGroup heading="Azure DevOps repositories">
                  {repos === null ? (
                    <SkeletonRows n={3} />
                  ) : repos.length === 0 ? (
                    <CommandEmpty>
                      No repos found. Connect Azure DevOps in Settings.
                    </CommandEmpty>
                  ) : (
                    repos.map((r) => (
                      <CommandItem
                        key={r.id}
                        value={r.name}
                        onSelect={() => {
                          setRepo(r);
                          setMode("commits");
                          setPickingBranch(false);
                        }}
                        className="gap-2 py-1.5"
                      >
                        <HugeiconsIcon
                          icon={FolderLibraryIcon}
                          size={13}
                          strokeWidth={1.75}
                          className="shrink-0 text-muted-foreground"
                        />
                        <span className="flex-1 truncate text-[12px]">
                          {r.name}
                        </span>
                      </CommandItem>
                    ))
                  )}
                </CommandGroup>
              </>
            ) : pickingBranch ? (
              /* --- Branch list --- */
              <CommandGroup>
                {branches === null ? (
                  <SkeletonRows n={4} />
                ) : branches.length === 0 ? (
                  <CommandEmpty>No branches found.</CommandEmpty>
                ) : (
                  <>
                    <CommandEmpty>No branches match.</CommandEmpty>
                    {sortedBranches.map((b) => (
                      <CommandItem
                        key={b}
                        value={b}
                        data-checked={b === branch}
                        onSelect={() => {
                          setBranch(b);
                          setPickingBranch(false);
                        }}
                        className="gap-2 py-1.5"
                      >
                        <HugeiconsIcon
                          icon={GitBranchIcon}
                          size={12}
                          strokeWidth={1.75}
                          className="shrink-0 text-muted-foreground"
                        />
                        <span className="flex-1 truncate font-mono text-[12px]">
                          {b}
                        </span>
                      </CommandItem>
                    ))}
                  </>
                )}
              </CommandGroup>
            ) : mode === "commits" ? (
              /* --- Recent commits --- */
              <CommandGroup>
                {!branch ? (
                  <CommandEmpty>Pick a branch to see its commits.</CommandEmpty>
                ) : commits === null ? (
                  <SkeletonRows n={4} tall />
                ) : commits.length === 0 ? (
                  <CommandEmpty>No commits on this branch.</CommandEmpty>
                ) : (
                  <>
                    <CommandEmpty>No commits match.</CommandEmpty>
                    {commits.map((c) => (
                      <CommitItem
                        key={c.commitId}
                        commit={c}
                        onSelect={() => pickCommit(c.commitId)}
                      />
                    ))}
                  </>
                )}
              </CommandGroup>
            ) : (
              /* --- Pull requests --- */
              <CommandGroup>
                {prs === null ? (
                  <SkeletonRows n={3} tall />
                ) : prs.length === 0 ? (
                  <CommandEmpty>No active pull requests.</CommandEmpty>
                ) : (
                  <>
                    <CommandEmpty>No pull requests match.</CommandEmpty>
                    {prs.map((pr) => (
                      <CommandItem
                        key={pr.id}
                        value={`${pr.id} ${pr.title} ${pr.sourceBranch}`}
                        onSelect={() => pickPr(pr)}
                        className="flex-col items-start gap-0.5 py-1.5"
                      >
                        <span className="text-[12px] leading-snug">
                          <span className="font-mono text-muted-foreground">
                            #{pr.id}
                          </span>{" "}
                          {pr.title}
                        </span>
                        <span className="font-mono text-[10px] text-muted-foreground/70">
                          {pr.sourceBranch} → {pr.targetBranch}
                        </span>
                      </CommandItem>
                    ))}
                  </>
                )}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function CommitItem({
  commit,
  onSelect,
}: {
  commit: CommitInfo;
  onSelect: () => void;
}) {
  const short = commit.commitId.slice(0, 8);
  const subject = (commit.comment ?? "").split("\n")[0] || "(no message)";
  return (
    <CommandItem
      value={`${short} ${subject}`}
      onSelect={onSelect}
      className="flex-col items-start gap-0.5 py-1.5"
    >
      <span className="w-full truncate text-[12px] leading-snug text-foreground/90">
        {subject}
      </span>
      <span className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground/70">
        <span className="text-foreground/60">{short}</span>
        {commit.authorName ? <span>· {commit.authorName}</span> : null}
        {commit.committedDate ? (
          <span>· {formatWhen(commit.committedDate)}</span>
        ) : null}
      </span>
    </CommandItem>
  );
}

function SegButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof GitCommitIcon;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex h-5 items-center gap-1 rounded-[5px] px-1.5 text-[10.5px] font-medium transition-colors",
        active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      <HugeiconsIcon icon={icon} size={11} strokeWidth={1.75} />
      {label}
    </button>
  );
}

function SkeletonRows({ n, tall }: { n: number; tall?: boolean }) {
  return (
    <div className="flex flex-col gap-1 px-1 py-1">
      {Array.from({ length: n }, (_, i) => (
        <Skeleton
          key={i}
          className={cn("w-full rounded-md", tall ? "h-9" : "h-7")}
        />
      ))}
    </div>
  );
}

function sortBranches(branches: BranchRef[], current: string): string[] {
  const names = branches.map((b) => b.name);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of BRANCH_PRIORITY) {
    if (names.includes(p) && !seen.has(p)) {
      out.push(p);
      seen.add(p);
    }
  }
  if (current && names.includes(current) && !seen.has(current)) {
    out.push(current);
    seen.add(current);
  }
  for (const n of [...names].sort()) {
    if (!seen.has(n)) {
      out.push(n);
      seen.add(n);
    }
  }
  return out;
}

function pickDefaultBranch(branches: BranchRef[]): string {
  const names = branches.map((b) => b.name);
  for (const p of BRANCH_PRIORITY) if (names.includes(p)) return p;
  return names[0] ?? "";
}

function sourceIcon(source: CodeReviewSource) {
  return source.unit === "pr" ? GitPullRequestIcon : GitCommitIcon;
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

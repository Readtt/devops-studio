import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  adoListPullRequests,
  listRepos,
  type PullRequestRef,
  type RepoRef,
} from "@/modules/ado";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { describeSource, type CodeReviewSource } from "./source";

/**
 * Source selector for the Code Review pane: review the local working-copy diff
 * (default) or an Azure DevOps commit / pull request. Branch-vs-base diffs are
 * supported by the backend; the UI exposes commit + PR (which don't need a
 * branch-list call). Switching wipes the conversation (different change).
 */
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
  const [repos, setRepos] = useState<RepoRef[]>([]);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [repo, setRepo] = useState<RepoRef | null>(null);
  const [unit, setUnit] = useState<"commit" | "pr">("commit");
  const [sha, setSha] = useState("");
  const [prs, setPrs] = useState<PullRequestRef[]>([]);
  const [loadingPrs, setLoadingPrs] = useState(false);

  useEffect(() => {
    if (!open || repos.length > 0) return;
    let alive = true;
    setLoadingRepos(true);
    void listRepos()
      .then((r) => alive && setRepos(r))
      .catch(() => alive && setRepos([]))
      .finally(() => alive && setLoadingRepos(false));
    return () => {
      alive = false;
    };
  }, [open, repos.length]);

  useEffect(() => {
    if (!open || unit !== "pr" || !repo) return;
    let alive = true;
    setLoadingPrs(true);
    void adoListPullRequests(repo.id, 30)
      .then((p) => alive && setPrs(p))
      .catch(() => alive && setPrs([]))
      .finally(() => alive && setLoadingPrs(false));
    return () => {
      alive = false;
    };
  }, [open, unit, repo]);

  const pickLocal = () => {
    onChange(null);
    setOpen(false);
  };

  const pickCommit = () => {
    if (!repo || !sha.trim()) return;
    onChange({
      kind: "ado",
      repoId: repo.id,
      repoName: repo.name,
      unit: "commit",
      commitId: sha.trim(),
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

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={disabled}
              aria-label="Review source"
              className={cn(
                "inline-flex h-6 items-center gap-1 rounded-md border border-transparent px-1.5 text-[11.5px] transition-colors",
                "hover:bg-foreground/[0.04] data-[state=open]:bg-foreground/[0.04]",
                "disabled:cursor-not-allowed disabled:opacity-50",
                source ? "text-foreground/85" : "text-muted-foreground",
              )}
            >
              <span className="truncate">{describeSource(source)}</span>
              <HugeiconsIcon
                icon={ArrowDown01Icon}
                size={10}
                strokeWidth={2}
                className="shrink-0 text-muted-foreground/70"
              />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-[280px] text-[11px]">
          What this review is reading — your local working-copy diff, or an
          Azure DevOps commit / pull request. Switching wipes the conversation.
        </TooltipContent>
      </Tooltip>
      <PopoverContent side="bottom" align="start" sideOffset={4} className="w-80 rounded-lg p-2">
        <button
          type="button"
          onClick={pickLocal}
          className={cn(
            "flex w-full items-center rounded-md px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-foreground/[0.05]",
            !source && "bg-foreground/[0.05] font-medium",
          )}
        >
          Local working copy
        </button>

        <div className="mt-2 mb-1 px-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
          Azure DevOps
        </div>

        {loadingRepos ? (
          <div className="flex flex-col gap-1 px-1">
            <Skeleton className="h-7 w-full rounded-md" />
            <Skeleton className="h-7 w-full rounded-md" />
          </div>
        ) : repos.length === 0 ? (
          <p className="px-2 py-1 text-[11px] text-muted-foreground">
            No repos found. Connect Azure DevOps in Settings.
          </p>
        ) : (
          <>
            <select
              value={repo?.id ?? ""}
              onChange={(e) =>
                setRepo(repos.find((r) => r.id === e.target.value) ?? null)
              }
              className="mb-2 h-8 w-full rounded-md border border-border/60 bg-input/40 px-2 text-[12px] outline-none"
            >
              <option value="">Select a repository…</option>
              {repos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>

            {repo ? (
              <>
                <div className="mb-2 flex gap-1">
                  {(["commit", "pr"] as const).map((u) => (
                    <button
                      key={u}
                      type="button"
                      onClick={() => setUnit(u)}
                      className={cn(
                        "flex-1 rounded-md border px-2 py-1 text-[11px] transition-colors",
                        unit === u
                          ? "border-primary/40 bg-primary/[0.08] text-primary"
                          : "border-border/60 text-muted-foreground hover:bg-foreground/[0.05]",
                      )}
                    >
                      {u === "commit" ? "Commit" : "Pull request"}
                    </button>
                  ))}
                </div>

                {unit === "commit" ? (
                  <div className="flex gap-1">
                    <Input
                      value={sha}
                      onChange={(e) => setSha(e.currentTarget.value)}
                      placeholder="Commit SHA"
                      className="h-8 flex-1 font-mono text-[11.5px]"
                    />
                    <Button
                      size="sm"
                      onClick={pickCommit}
                      disabled={!sha.trim()}
                    >
                      Review
                    </Button>
                  </div>
                ) : loadingPrs ? (
                  <div className="flex flex-col gap-1">
                    <Skeleton className="h-8 w-full rounded-md" />
                    <Skeleton className="h-8 w-full rounded-md" />
                  </div>
                ) : prs.length === 0 ? (
                  <p className="px-1 py-1 text-[11px] text-muted-foreground">
                    No active pull requests.
                  </p>
                ) : (
                  <div className="flex max-h-[220px] flex-col gap-0.5 overflow-y-auto">
                    {prs.map((pr) => (
                      <button
                        key={pr.id}
                        type="button"
                        onClick={() => pickPr(pr)}
                        className="flex flex-col items-start rounded-md px-2 py-1.5 text-left transition-colors hover:bg-foreground/[0.05]"
                      >
                        <span className="text-[12px]">
                          <span className="font-mono text-muted-foreground">
                            #{pr.id}
                          </span>{" "}
                          {pr.title}
                        </span>
                        <span className="font-mono text-[10px] text-muted-foreground/70">
                          {pr.sourceBranch} → {pr.targetBranch}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            ) : null}
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

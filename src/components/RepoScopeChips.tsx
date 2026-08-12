import { HugeiconsIcon } from "@hugeicons/react";
import { Tick02Icon } from "@hugeicons/core-free-icons";

import { cn } from "@/lib/utils";
import { Label } from "@/components/ui/label";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { isRepoInScope } from "@/modules/ai/lib/repoScope";
import type { WorkspaceRepo } from "@/modules/settings/store";

type Props = {
  repos: WorkspaceRepo[];
  /** Repo ids this run reads; null = all of them. */
  scope: string[] | null;
  onToggle: (repoId: string) => void;
  /** Field label. Say what the scope governs, not what a repo is. */
  label?: string;
  /** One line under the chips explaining what the current selection means.
   *  Overrides the default, which describes reading. */
  hint?: string;
  className?: string;
};

/**
 * Per-run repo scope, as a row of toggle chips.
 *
 * All repos are on by default because the app can't know which ones a given
 * spec or commit touches — deselecting is the user's explicit act. Deselecting
 * every repo is allowed and means exactly what it says: the run reads no
 * source at all.
 *
 * Callers render this only when more than one repo is configured; at one repo
 * there is nothing to choose between and the row would be pure noise.
 */
export function RepoScopeChips({
  repos,
  scope,
  onToggle,
  label = "Repos",
  hint,
  className,
}: Props) {
  const selected = repos.filter((r) => isRepoInScope(scope, r.id)).length;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      <div className="flex flex-wrap gap-1.5">
        {repos.map((repo) => {
          const on = isRepoInScope(scope, repo.id);
          return (
            <Tooltip key={repo.id}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => onToggle(repo.id)}
                  aria-pressed={on}
                  className={cn(
                    "inline-flex h-6 max-w-[180px] items-center gap-1.5 rounded-md border px-2 text-[11px] transition-colors hover:bg-foreground/[0.03]",
                    on
                      ? "border-primary/40 bg-primary/[0.05]"
                      : "border-border/50 text-muted-foreground",
                  )}
                >
                  <HugeiconsIcon
                    icon={Tick02Icon}
                    size={10}
                    strokeWidth={2.5}
                    className={cn(
                      "shrink-0",
                      on ? "text-primary" : "opacity-0",
                    )}
                  />
                  <span className="truncate">{repo.name}</span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-[280px] text-[11px]">
                {on
                  ? `Deselect to keep this run out of ${repo.name} — no files read, nothing cited from it.`
                  : `Select to let this run read ${repo.name} again.`}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
      <p className="text-[10px] leading-relaxed text-muted-foreground">
        {hint ??
          (selected === 0
            ? "Nothing selected — this run reads no source at all."
            : "All repos are read by default. Deselect one to leave it out of this run.")}
      </p>
    </div>
  );
}

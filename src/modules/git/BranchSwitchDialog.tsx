import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Archive02Icon,
  ArrowRight01Icon,
} from "@hugeicons/core-free-icons";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { repoBasename, sameRoot } from "@/modules/settings/store";
import { useBranchSwitch, type BranchSwitchConfirm } from "./useBranchSwitch";

/**
 * Asked when switching branches with uncommitted work — the Visual-Studio-style
 * "what about my changes?" prompt. Two deliberate, clearly-named outcomes
 * (carry along vs stash aside) so the user always chooses; never silent.
 * Mounted once, globally; reads the pending confirms from the switch store.
 *
 * Repos are switched independently, so more than one can be waiting on an
 * answer. They're asked one at a time — two modals at once would fight.
 */
export function BranchSwitchDialog() {
  const confirms = useBranchSwitch((s) => s.confirms);
  const confirmSwitch = useBranchSwitch((s) => s.confirmSwitch);
  const cancel = useBranchSwitch((s) => s.cancelConfirm);
  const repos = usePreferencesStore((s) => s.repos);

  const confirm = confirms.values().next().value ?? null;
  // Only worth naming the repo once there's more than one to confuse it with.
  const repoName =
    confirm && repos.length > 1
      ? repos.find((r) => sameRoot(r.root, confirm.cwd))?.name ??
        repoBasename(confirm.cwd)
      : null;

  return (
    <AlertDialog
      open={!!confirm}
      onOpenChange={(open) => {
        if (!open && confirm) cancel(confirm.cwd);
      }}
    >
      {/* Keyed by repo so a second queued confirm REMOUNTS instead of swapping
          its text in under the user's cursor: without this the dialog never
          closes between two dirty repos, focus stays on the same button, and a
          key repeat meant for the first repo checks out the second. */}
      <AlertDialogContent key={confirm?.cwd ?? "none"} className="max-w-[440px]">
        {confirm ? (
          <Body
            confirm={confirm}
            repoName={repoName}
            onCarry={() => confirmSwitch(confirm.cwd, "carry")}
            onStash={() => confirmSwitch(confirm.cwd, "stash")}
          />
        ) : null}
      </AlertDialogContent>
    </AlertDialog>
  );
}

function Body({
  confirm,
  repoName,
  onCarry,
  onStash,
}: {
  confirm: BranchSwitchConfirm;
  repoName: string | null;
  onCarry: () => void;
  onStash: () => void;
}) {
  const { branch, from, blocked } = confirm;
  const here = from ?? "this branch";
  const summary = dirtySummary(confirm);
  const inRepo = repoName ? (
    <>
      {" "}
      in <span className="font-medium text-foreground/85">{repoName}</span>
    </>
  ) : null;

  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>
          {blocked ? "Your changes don't fit there" : "You have uncommitted changes"}
          {repoName ? (
            <>
              {" "}
              <span className="font-normal text-muted-foreground">
                in {repoName}
              </span>
            </>
          ) : null}
        </AlertDialogTitle>
        <AlertDialogDescription>
          {blocked ? (
            <>
              Some of your edits clash with{" "}
              <span className="font-mono text-foreground/85">{branch}</span>, so
              they can&rsquo;t come with you. Leave them here and switch with a
              clean copy of {branch}.
            </>
          ) : (
            <>
              You have {summary} on{" "}
              <span className="font-mono text-foreground/85">{here}</span>
              {inRepo}. What should happen to them when you switch to{" "}
              <span className="font-mono text-foreground/85">{branch}</span>?
            </>
          )}
        </AlertDialogDescription>
      </AlertDialogHeader>

      <div className="flex flex-col gap-2">
        {!blocked ? (
          <OptionRow
            icon={ArrowRight01Icon}
            title={`Bring my changes to ${branch}`}
            description="Take your edits with you to the new branch."
            onClick={onCarry}
          />
        ) : null}
        <OptionRow
          icon={Archive02Icon}
          title={`Leave my changes on ${here}`}
          description={`Set them aside here so ${branch} opens clean. Come back any time and Restore them from the branch menu.`}
          primary
          onClick={onStash}
        />
      </div>

      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
      </AlertDialogFooter>
    </>
  );
}

function OptionRow({
  icon,
  title,
  description,
  primary,
  onClick,
}: {
  icon: typeof ArrowRight01Icon;
  title: string;
  description: string;
  /** Tints the row as the safe path (the "leave them here" option, which can
   *  never fail). No badge — the title already says what it does. */
  primary?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group flex items-start gap-2.5 rounded-md border px-3 py-2.5 text-left transition-colors",
        primary
          ? "border-primary/45 bg-primary/[0.06] hover:bg-primary/[0.1]"
          : "border-border/60 bg-card/40 hover:bg-foreground/[0.04]",
      )}
    >
      <span
        className={cn(
          "mt-0.5 grid size-6 shrink-0 place-items-center rounded-md",
          primary
            ? "bg-primary/15 text-primary"
            : "bg-foreground/[0.06] text-muted-foreground",
        )}
      >
        <HugeiconsIcon icon={icon} size={13} strokeWidth={1.75} />
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[12.5px] font-medium text-foreground">{title}</span>
        <span className="text-[11px] leading-snug text-muted-foreground">
          {description}
        </span>
      </span>
    </button>
  );
}

function dirtySummary(c: BranchSwitchConfirm): string {
  const changed = c.staged + c.unstaged;
  const parts: string[] = [];
  if (changed > 0) {
    parts.push(`${changed} changed file${changed === 1 ? "" : "s"}`);
  }
  if (c.untracked > 0) {
    parts.push(`${c.untracked} new file${c.untracked === 1 ? "" : "s"}`);
  }
  if (parts.length === 0) return "uncommitted changes";
  return parts.join(" and ");
}

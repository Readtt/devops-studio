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
import { useBranchSwitch, type BranchSwitchConfirm } from "./useBranchSwitch";

/**
 * Asked when switching branches with uncommitted work — the Visual-Studio-style
 * "what about my changes?" prompt. Two deliberate, clearly-named outcomes
 * (carry along vs stash aside) so the user always chooses; never silent.
 * Mounted once, globally; reads the pending confirm from the switch store.
 */
export function BranchSwitchDialog() {
  const confirm = useBranchSwitch((s) => s.confirm);
  const confirmSwitch = useBranchSwitch((s) => s.confirmSwitch);
  const cancel = useBranchSwitch((s) => s.cancelConfirm);

  return (
    <AlertDialog
      open={!!confirm}
      onOpenChange={(open) => {
        if (!open) cancel();
      }}
    >
      <AlertDialogContent className="max-w-[440px]">
        {confirm ? (
          <Body
            confirm={confirm}
            onCarry={() => confirmSwitch("carry")}
            onStash={() => confirmSwitch("stash")}
          />
        ) : null}
      </AlertDialogContent>
    </AlertDialog>
  );
}

function Body({
  confirm,
  onCarry,
  onStash,
}: {
  confirm: BranchSwitchConfirm;
  onCarry: () => void;
  onStash: () => void;
}) {
  const { branch, from, blocked } = confirm;
  const here = from ?? "this branch";
  const summary = dirtySummary(confirm);

  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>
          {blocked ? "Your changes don't fit there" : "You have uncommitted changes"}
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
              <span className="font-mono text-foreground/85">{here}</span>.
              What should happen to them when you switch to{" "}
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

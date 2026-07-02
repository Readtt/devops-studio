// Post-clone source-directory picker. Auto-opens (phase "choose-source") once a
// batch finishes with at least one successful clone:
//   • one repo   → a quick "work in it?" confirm
//   • many repos → pick which cloned repo becomes the source directory
// Dismissing (Escape / overlay / Not now / Skip) leaves the source dir unchanged
// — the clones stay on disk; only the app's active source pointer is untouched.

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  AlertCircleIcon,
  CheckmarkCircle02Icon,
  GitBranchIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useState } from "react";
import { useCloneProgress } from "./cloneProgressStore";

export function CloneSourceDialog() {
  const phase = useCloneProgress((s) => s.phase);
  const outcomes = useCloneProgress((s) => s.outcomes);
  const destParent = useCloneProgress((s) => s.destParent);
  const chooseSource = useCloneProgress((s) => s.chooseSource);

  const open = phase === "choose-source";

  const successes = useMemo(
    () => outcomes.filter((o) => o.status === "cloned" && o.path),
    [outcomes],
  );
  const failures = useMemo(
    () => outcomes.filter((o) => o.status !== "cloned"),
    [outcomes],
  );

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  // Default to the first clone each time the picker opens.
  useEffect(() => {
    if (open) setSelectedPath(successes[0]?.path ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const single = successes.length === 1;
  const skip = () => chooseSource(null);
  const confirm = () => chooseSource(single ? (successes[0]?.path ?? null) : selectedPath);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) skip();
      }}
    >
      <DialogContent className="sm:max-w-[460px]" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <HugeiconsIcon
              icon={CheckmarkCircle02Icon}
              size={14}
              strokeWidth={2}
              className="text-primary"
            />
            {single ? "Set source directory" : "Choose your source directory"}
          </DialogTitle>
          <DialogDescription>
            {single ? (
              <>
                Cloned{" "}
                <span className="font-medium text-foreground">
                  {successes[0]?.label}
                </span>
                . Work in it? Code links and grounded AI reviews read from your
                source directory.
              </>
            ) : (
              <>
                {successes.length} repositories cloned
                {destParent ? (
                  <>
                    {" "}
                    into{" "}
                    <span className="font-mono text-[11px] text-foreground/80">
                      {destParent}
                    </span>
                  </>
                ) : null}
                . Pick the one to work in.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {!single ? (
          <div className="flex max-h-[240px] flex-col gap-1 overflow-y-auto py-0.5">
            {successes.map((o) => {
              const active = o.path === selectedPath;
              return (
                <button
                  key={o.path ?? o.label}
                  type="button"
                  onClick={() => setSelectedPath(o.path)}
                  className={cn(
                    "flex items-center gap-2 rounded-md border px-2.5 py-2 text-left transition-colors",
                    active
                      ? "border-primary/50 bg-primary/[0.06]"
                      : "border-border/60 hover:bg-foreground/[0.03]",
                  )}
                >
                  <RadioDot active={active} />
                  <HugeiconsIcon
                    icon={GitBranchIcon}
                    size={12}
                    strokeWidth={1.75}
                    className="shrink-0 text-muted-foreground"
                  />
                  <span className="min-w-0 flex-1 truncate text-[12px] text-foreground">
                    {o.label}
                  </span>
                  {o.project ? (
                    <span className="max-w-[40%] shrink-0 truncate text-[10px] text-muted-foreground/70">
                      {o.project}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        ) : null}

        {failures.length > 0 ? (
          <div className="flex flex-col gap-1 rounded-md border border-border/50 bg-muted/20 px-2.5 py-2">
            <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
              Didn&apos;t clone
            </p>
            {failures.map((o, i) => (
              <div key={i} className="flex items-baseline gap-1.5 text-[11px]">
                <HugeiconsIcon
                  icon={AlertCircleIcon}
                  size={11}
                  strokeWidth={2}
                  className="shrink-0 translate-y-0.5 text-amber-500"
                />
                <span className="shrink-0 font-medium text-foreground/90">{o.label}</span>
                <span className="min-w-0 truncate text-muted-foreground">
                  {o.message ?? "Failed"}
                </span>
              </div>
            ))}
          </div>
        ) : null}

        <DialogFooter className="mt-1 gap-1.5">
          <Button type="button" variant="ghost" size="sm" onClick={skip}>
            {single ? "Not now" : "Skip"}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!single && !selectedPath}
            onClick={confirm}
          >
            {single ? "Use it" : "Set source"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RadioDot({ active }: { active: boolean }) {
  return (
    <span
      className={cn(
        "grid size-3.5 shrink-0 place-items-center rounded-full border",
        active ? "border-primary" : "border-muted-foreground/40",
      )}
    >
      {active ? <span className="size-1.5 rounded-full bg-primary" /> : null}
    </span>
  );
}

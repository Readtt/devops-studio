import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  adoErrorMessage,
  createSuite,
  toAdoError,
  type AdoError,
} from "@/modules/ado";
import { FolderAddIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";
import { useTestPlans } from "./hooks/useTestPlans";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The plan the new suite lives in. */
  planId: number;
  planName: string;
  /** When set, nest under this suite. When `null`, attach to the plan root. */
  parentSuiteId: number | null;
  parentSuiteName: string | null;
  /** Called after the suite is created so the caller can expand into it. */
  onCreated?: (suiteId: number) => void;
};

/**
 * Compact dialog for adding a Static Test Suite under a plan or another
 * suite. Requirement-based and query-based suites need a lot more wiring
 * (work-item query selector, area-path scoping) so they're deliberately
 * out of scope for v1 — we surface that with a small hint at the bottom.
 */
export function NewSuiteDialog({
  open,
  onOpenChange,
  planId,
  planName,
  parentSuiteId,
  parentSuiteName,
  onCreated,
}: Props) {
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<AdoError | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const loadSuites = useTestPlans((s) => s.loadSuites);

  // Reset between openings — leftover state would suggest a previous run.
  useEffect(() => {
    if (open) {
      setName("");
      setError(null);
      setSubmitting(false);
      // Focus after the open animation; otherwise Radix steals focus.
      const id = window.setTimeout(() => inputRef.current?.focus(), 30);
      return () => window.clearTimeout(id);
    }
  }, [open]);

  const trimmed = name.trim();
  const canSubmit = trimmed.length > 0 && !submitting;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const created = await createSuite({
        planId,
        parentSuiteId,
        name: trimmed,
      });
      await loadSuites(planId, { force: true });
      onCreated?.(created.id);
      onOpenChange(false);
    } catch (e) {
      setError(toAdoError(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <HugeiconsIcon
              icon={FolderAddIcon}
              size={12}
              strokeWidth={1.75}
              className="text-primary"
            />
            New static suite
          </DialogTitle>
          <DialogDescription>
            {parentSuiteName ? (
              <>
                Nested under{" "}
                <span className="text-foreground/85">{parentSuiteName}</span>{" "}
                in <span className="text-foreground/85">{planName}</span>.
              </>
            ) : (
              <>
                Top-level suite in{" "}
                <span className="text-foreground/85">{planName}</span>.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="flex flex-col gap-2"
        >
          <div className="flex flex-col gap-1">
            <Label
              htmlFor="new-suite-name"
              className="text-[11px] text-muted-foreground"
            >
              Suite name
            </Label>
            <Input
              ref={inputRef}
              id="new-suite-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Authentication, Smoke, Regression…"
              autoComplete="off"
              spellCheck={false}
              disabled={submitting}
              className="font-mono"
            />
          </div>

          {error ? (
            <p className="rounded-md border border-destructive/40 bg-destructive/[0.06] px-2 py-1.5 text-[11px] text-destructive">
              {adoErrorMessage(error)}
            </p>
          ) : null}

          <p className="text-[10.5px] leading-relaxed text-muted-foreground/80">
            Static suites hold an explicit list of test cases. Requirement-based
            and query-based suites aren't supported yet — those need a
            work-item selector that's still on the roadmap.
          </p>

          <DialogFooter className="mt-1 gap-1.5">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={!canSubmit}
            >
              {submitting ? "Creating…" : "Create suite"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

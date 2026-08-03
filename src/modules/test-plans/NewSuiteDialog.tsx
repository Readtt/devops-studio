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
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  adoErrorMessage,
  createRequirementSuite,
  createSuite,
  suiteRestriction,
  toAdoError,
  type AdoError,
  type WorkItemRef,
} from "@/modules/ado";
import { cn } from "@/lib/utils";
import {
  ExternalLink,
  FolderAddIcon,
  FolderLinksIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "react";
import { useTestPlans } from "./hooks/useTestPlans";
import { RequirementPicker } from "./RequirementPicker";

/** Which kind of suite the dialog is creating. Query-based suites are
 *  deliberately absent: Azure DevOps won't let anything add cases to one, so
 *  the app's whole generate-and-publish flow is inert there. */
type SuiteMode = "static" | "requirement";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The plan the new suite lives in. */
  planId: number;
  planName: string;
  /** When set, nest under this suite. When `null`, attach to the plan root. */
  parentSuiteId: number | null;
  parentSuiteName: string | null;
  /** Deep link to this plan in the ADO web UI, for the requirement-suite
   *  handoff in the footer. `null` when there's no connection yet. */
  planWebUrl?: string | null;
  /** Scopes the requirement search to the plan's area path so the first
   *  results are the ones this plan is actually about. */
  planAreaPath?: string | null;
  /** Which tab to open on, so the two context-menu entries land the user
   *  where they asked to be. */
  initialMode?: SuiteMode;
  /** Called after the suite is created so the caller can expand into it. */
  onCreated?: (suiteId: number) => void;
};

/**
 * Compact dialog for adding a Static Test Suite under a plan or another suite.
 *
 * Creates ONE requirement-based suite at a time, bound to a work item picked
 * here. BULK creation is the part that stays in the Azure DevOps web UI: its
 * dialog runs a full work-item query and creates one suite per result, and
 * reimplementing that query builder isn't worth owning for a once-a-sprint
 * setup action. The footer points at the ADO path so its absence reads as a
 * deliberate handoff rather than a missing feature.
 */
export function NewSuiteDialog({
  open,
  onOpenChange,
  planId,
  planName,
  parentSuiteId,
  parentSuiteName,
  planWebUrl,
  planAreaPath,
  initialMode = "static",
  onCreated,
}: Props) {
  const [mode, setMode] = useState<SuiteMode>(initialMode);
  const [name, setName] = useState("");
  const [requirement, setRequirement] = useState<WorkItemRef | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<AdoError | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const pickerRef = useRef<HTMLButtonElement | null>(null);
  const loadSuites = useTestPlans((s) => s.loadSuites);
  const bySuite = useTestPlans((s) => s.bySuite);

  // Reset between openings — leftover state would suggest a previous run.
  useEffect(() => {
    if (open) {
      setMode(initialMode);
      setName("");
      setRequirement(null);
      setError(null);
      setSubmitting(false);
      // Focus after the open animation; otherwise Radix steals focus. Whichever
      // control the chosen mode actually renders — the static input is
      // unmounted in requirement mode, so focusing it there was a no-op and
      // Radix fell back to the first tabbable element, the "Static" toggle.
      const id = window.setTimeout(() => {
        if (initialMode === "requirement") pickerRef.current?.focus();
        else inputRef.current?.focus();
      }, 30);
      return () => window.clearTimeout(id);
    }
  }, [open, initialMode]);

  const trimmed = name.trim();
  const canSubmit =
    !submitting &&
    (mode === "static" ? trimmed.length > 0 : requirement !== null);

  const submit = async () => {
    if (!canSubmit) return;
    // Same staleness argument as the rename guard in useTestPlans: the menu
    // that opened this dialog may have rendered before a refresh reclassified
    // the parent, and the Rust side does no parent-type validation.
    const parent =
      parentSuiteId != null
        ? bySuite.get(planId)?.suites.find((s) => s.id === parentSuiteId)
        : null;
    const nestBlocked = parent ? suiteRestriction(parent, "nestSuites") : null;
    if (nestBlocked) {
      setError({ kind: "local", message: nestBlocked });
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const created =
        mode === "static"
          ? await createSuite({ planId, parentSuiteId, name: trimmed })
          : await createRequirementSuite({
              planId,
              parentSuiteId,
              requirementId: requirement!.id,
              name: requirement!.title,
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
              icon={mode === "static" ? FolderAddIcon : FolderLinksIcon}
              size={12}
              strokeWidth={1.75}
              className="text-primary"
            />
            {mode === "static" ? "New static suite" : "New requirement-based suite"}
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
          className="flex min-w-0 flex-col gap-2"
        >
          <div role="radiogroup" aria-label="Suite type" className="flex min-w-0 gap-1">
            {(
              [
                ["static", "Static", "An explicit list of cases you curate."],
                [
                  "requirement",
                  "Requirement-based",
                  "Tracks one work item; cases you add link back to it.",
                ],
              ] as const
            ).map(([m, label, hint]) => (
              <Tooltip key={m}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    // Selected state is otherwise colour-only, which a screen
                    // reader can't convey.
                    role="radio"
                    aria-checked={mode === m}
                    onClick={() => setMode(m)}
                    disabled={submitting}
                    className={cn(
                      "flex-1 rounded-md border px-2 py-1 text-[11px] transition-colors",
                      mode === m
                        ? "border-primary/45 bg-primary/[0.08] text-foreground"
                        : "border-border/60 text-muted-foreground hover:bg-foreground/[0.03]",
                    )}
                  >
                    {label}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-[280px] text-[11px]">
                  {hint}
                </TooltipContent>
              </Tooltip>
            ))}
          </div>

          {mode === "static" ? (
            <div className="flex min-w-0 flex-col gap-1">
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
          ) : (
            <div className="flex min-w-0 flex-col gap-1">
              <Label
                htmlFor="new-suite-requirement"
                className="text-[11px] text-muted-foreground"
              >
                Requirement to track
              </Label>
              <RequirementPicker
                triggerRef={pickerRef}
                value={requirement}
                onChange={setRequirement}
                areaPath={planAreaPath ?? null}
                disabled={submitting}
              />
              <p className="text-[10.5px] leading-relaxed text-muted-foreground/80">
                {requirement
                  ? `Creates a suite for #${requirement.id}. Every case you add to it links back as "Tested By" — that link is what drives requirement coverage in Azure DevOps.`
                  : "Only work-item types this project treats as requirements are listed."}
              </p>
            </div>
          )}

          {error ? (
            <p className="rounded-md border border-destructive/40 bg-destructive/[0.06] px-2 py-1.5 text-[11px] text-destructive">
              {adoErrorMessage(error)}
            </p>
          ) : null}

          <p className="text-[10.5px] leading-relaxed text-muted-foreground/80">
            {mode === "static" ? (
              <>
                Static suites hold an explicit list of test cases. Switch to{" "}
                <span className="text-foreground/85">Requirement-based</span> to
                bind a suite to a user story instead.
              </>
            ) : (
              <>
                Creating suites for a whole sprint? Azure DevOps&apos;{" "}
                <span className="text-foreground/85">New Suite</span> ›{" "}
                <span className="text-foreground/85">
                  Requirement based suite
                </span>{" "}
                runs a full work-item query and creates them in bulk.
              </>
            )}
            {planWebUrl ? (
              <>
                {" "}
                <button
                  type="button"
                  onClick={() => void openUrl(planWebUrl)}
                  className="inline-flex items-center gap-0.5 text-primary underline-offset-2 hover:underline"
                >
                  Open this plan in Azure DevOps
                  <HugeiconsIcon
                    icon={ExternalLink}
                    size={9}
                    strokeWidth={1.75}
                  />
                </button>
              </>
            ) : null}
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

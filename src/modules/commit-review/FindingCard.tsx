import { cn } from "@/lib/utils";
import { SeverityChip } from "@/components/chat/ApplyEditCard";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowRight01Icon,
  CheckmarkCircle02Icon,
} from "@hugeicons/core-free-icons";
import { ApplyPatchCard } from "./ApplyPatchCard";
import type { AppliedPatchRecord } from "./patchSchema";
import type { Category, Finding, Severity } from "./schema";

/** Left-border accent by severity — mirrors the Generator review list's
 *  `border-l-2` decision-color idiom. */
const SEVERITY_BORDER: Record<Severity, string> = {
  critical: "border-l-destructive/70",
  high: "border-l-rose-500/60",
  medium: "border-l-amber-500/60",
  low: "border-l-border/50",
};

/** Soft category pill tints, in the same vocabulary as severityChip. */
const CATEGORY_TINT: Record<Category, string> = {
  security: "bg-rose-500/12 text-rose-600 dark:text-rose-300",
  performance: "bg-amber-500/12 text-amber-700 dark:text-amber-300",
  correctness: "bg-sky-500/12 text-sky-700 dark:text-sky-300",
  requirements: "bg-violet-500/12 text-violet-700 dark:text-violet-300",
  maintainability: "bg-foreground/[0.08] text-muted-foreground",
};

const CATEGORY_LABEL: Record<Category, string> = {
  security: "security",
  performance: "performance",
  correctness: "correctness",
  requirements: "requirements",
  maintainability: "maintainability",
};

/** Plain-language definition shown on hover — so a badge like "correctness"
 *  isn't a mystery. */
const CATEGORY_DESC: Record<Category, string> = {
  security:
    "Security risk — injection, auth/permission gaps, unsafe input handling, secret exposure, SSRF/path traversal.",
  performance:
    "Performance issue — N+1 queries, accidental O(n²), unbounded allocations, work inside hot loops, missing limits.",
  correctness:
    "Logic bug — wrong result, off-by-one, null/undefined handling, race condition, or a regression that breaks existing callers.",
  requirements:
    "Doesn't match the requirements you provided in 'Add context' — the change contradicts what the ticket asked for.",
  maintainability:
    "Code quality — readability, naming, structure, dead code, or a missing test on a new branch. Not a bug, but worth fixing.",
};

const SEVERITY_DESC: Record<Severity, string> = {
  critical: "Critical — breaks production, loses/corrupts data, or is a real security hole. Fix before merging.",
  high: "High — a genuine bug or regression that will bite under normal use.",
  medium: "Medium — a real but non-urgent issue: missing error handling, a perf concern, a test gap.",
  low: "Low — a nit: style, naming, or a minor refactor. Optional polish.",
};

const CONFIDENCE_DESC: Record<string, string> = {
  high: "High confidence — the model verified this with your code (read the file / grepped callers) and it survived the skeptical verification pass.",
  medium: "Medium confidence — likely real, with supporting evidence, but some uncertainty remains.",
  low: "Low confidence — surfaced but not fully confirmed. Treat as a lead to check, not a certainty.",
};

function openInViewer(file: string, startLine: number, endLine: number) {
  window.dispatchEvent(
    new CustomEvent("devops-studio:open-code-viewer", {
      detail: {
        path: file,
        startLine: startLine || 1,
        endLine: Math.max(startLine || 1, endLine || startLine || 1),
      },
    }),
  );
}

export function FindingCard({
  finding,
  applied,
  onApplied,
}: {
  finding: Finding;
  applied?: AppliedPatchRecord | null;
  onApplied?: (record: AppliedPatchRecord) => void;
}) {
  const loc = finding.startLine
    ? `${finding.file}:${finding.startLine}${
        finding.endLine && finding.endLine !== finding.startLine
          ? `-${finding.endLine}`
          : ""
      }`
    : finding.file;

  return (
    <div
      className={cn(
        "group relative flex flex-col gap-1.5 rounded-md border border-l-2 bg-card/40 px-3 py-2",
        SEVERITY_BORDER[finding.severity],
        "border-border/55",
      )}
    >
      <div className="flex items-center gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            {/* inline-flex (not a bare span) so this ref wrapper takes the
                chip's exact height — a plain span inherits the row's taller
                line-box and visually drops the badge below the category tag. */}
            <span className="inline-flex shrink-0 items-center">
              <SeverityChip severity={finding.severity} />
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-[260px] text-[11px]">
            {SEVERITY_DESC[finding.severity]}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className={cn(
                "inline-flex shrink-0 items-center rounded-sm px-1.5 py-px text-[9.5px] font-medium uppercase tracking-wider",
                CATEGORY_TINT[finding.category],
              )}
            >
              {CATEGORY_LABEL[finding.category]}
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-[260px] text-[11px]">
            {CATEGORY_DESC[finding.category]}
          </TooltipContent>
        </Tooltip>
        <span className="min-w-0 flex-1 text-[12.5px] font-medium leading-snug text-foreground">
          {finding.title}
        </span>
        {finding.verified ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex shrink-0 items-center text-emerald-600 dark:text-emerald-400">
                <HugeiconsIcon
                  icon={CheckmarkCircle02Icon}
                  size={13}
                  strokeWidth={1.75}
                />
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-[260px] text-[11px]">
              Confirmed by a second skeptical verification pass — it survived an
              attempt to refute it.
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() =>
                openInViewer(finding.file, finding.startLine, finding.endLine)
              }
              className="inline-flex min-w-0 max-w-full items-center truncate rounded-sm border border-border/55 bg-foreground/[0.04] px-1 py-px font-mono text-[10.5px] text-foreground/85 transition-colors hover:bg-foreground/[0.08]"
            >
              {loc}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-[11px]">
            Open this location in the code viewer.
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="cursor-help font-mono text-[9.5px] uppercase tracking-wide text-muted-foreground/70">
              {finding.confidence} confidence
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-[260px] text-[11px]">
            {CONFIDENCE_DESC[finding.confidence]}
          </TooltipContent>
        </Tooltip>
      </div>

      <p className="whitespace-pre-wrap text-[11.5px] leading-snug text-foreground/85">
        {finding.explanation}
      </p>

      {finding.evidence && finding.evidence.trim() ? (
        <details className="group/ev ml-0.5">
          <summary className="flex cursor-pointer list-none items-center gap-1 text-[10.5px] text-muted-foreground hover:text-foreground">
            <HugeiconsIcon
              icon={ArrowRight01Icon}
              size={11}
              strokeWidth={1.75}
              className="transition-transform group-open/ev:rotate-90"
            />
            Evidence
          </summary>
          <p className="mt-1 whitespace-pre-wrap border-l border-border/40 pl-2.5 text-[10.5px] leading-snug text-muted-foreground">
            {finding.evidence}
          </p>
        </details>
      ) : null}

      {finding.suggestedFix ? (
        <ApplyPatchCard
          body={JSON.stringify(finding.suggestedFix)}
          applied={applied ?? null}
          onApplied={onApplied}
        />
      ) : null}
    </div>
  );
}

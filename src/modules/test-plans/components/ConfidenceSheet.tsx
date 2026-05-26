import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  AUTO_PASS_THRESHOLD,
  confidenceTone,
  type ConfidenceVerdict,
  type EvidenceItem,
} from "../lib/confidence";
import {
  AlertCircleIcon,
  CodeIcon,
  Loading03Icon,
  SparklesIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

/**
 * Confidence detail drawer. The chip's hover tooltip used to carry the whole
 * verdict (reasoning + every evidence line + caveats), which ran off-screen on
 * a narrow pane. This is the designated surface instead: a right-side Sheet
 * that scrolls, wraps long findings, and makes each step's file:line clickable
 * so the user can jump straight to the code the prediction was grounded in.
 *
 * Opened by clicking the ConfidenceChip; the chip owns the open state.
 */
export function ConfidenceSheet({
  open,
  onOpenChange,
  verdict,
  evaluating,
  onEvaluate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  verdict: ConfidenceVerdict | null | undefined;
  /** True while a re-evaluation is in flight (keeps the sheet's button busy). */
  evaluating?: boolean;
  onEvaluate?: () => void;
}) {
  const tone = verdict ? confidenceTone(verdict.confidence) : null;
  const pct = verdict ? Math.round(verdict.confidence) : 0;
  const isAutoPass =
    !!verdict &&
    verdict.predictedOutcome === "Pass" &&
    verdict.confidence >= AUTO_PASS_THRESHOLD;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full gap-0 p-0 sm:max-w-md"
      >
        <SheetHeader className="gap-2 border-b border-border/50 px-5 py-4 pr-12">
          <div className="flex items-center gap-2">
            <SheetTitle className="text-[13px] font-semibold tracking-tight">
              Confidence
            </SheetTitle>
            {verdict && tone ? (
              <span
                className={cn(
                  "rounded-sm px-1.5 py-px text-[11px] font-medium tabular-nums",
                  tone.className,
                )}
              >
                {pct}% · {verdict.predictedOutcome}
              </span>
            ) : null}
          </div>
          <SheetDescription className="text-[11.5px] leading-snug">
            {verdict
              ? isAutoPass
                ? "High confidence — auto-pass candidate. Every load-bearing step was grounded in code."
                : verdict.predictedOutcome === "Unknown"
                  ? "Couldn't ground this in code — needs manual testing."
                  : "Below the 90% auto-pass bar — flag for manual testing."
              : "No verdict yet. Run an evaluation to predict whether this case passes against the current source."}
          </SheetDescription>
          {verdict ? (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground/70">
              <span className="font-mono">{verdict.modelId}</span>
              {verdict.runs && verdict.runs > 1 ? (
                <>
                  <span className="text-muted-foreground/40">·</span>
                  <span>{verdict.runs} self-consistency runs</span>
                </>
              ) : null}
              <span className="text-muted-foreground/40">·</span>
              <span>{formatWhen(verdict.evaluatedAt)}</span>
            </div>
          ) : null}
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {verdict ? (
            <div className="flex flex-col gap-5">
              {verdict.reasoning ? (
                <Section title="Reasoning">
                  <p className="whitespace-pre-wrap text-[11.5px] leading-relaxed text-foreground/85">
                    {verdict.reasoning}
                  </p>
                </Section>
              ) : null}

              <Section title={`Evidence (${verdict.evidence.length})`}>
                {verdict.evidence.length === 0 ? (
                  <p className="text-[11px] italic text-muted-foreground">
                    No per-step evidence was returned.
                  </p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {verdict.evidence.map((e, i) => (
                      <EvidenceRow key={i} item={e} />
                    ))}
                  </ul>
                )}
              </Section>

              {verdict.caveats.length > 0 ? (
                <Section title="Caveats" tone="warn">
                  <ul className="flex flex-col gap-1.5">
                    {verdict.caveats.map((c, i) => (
                      <li
                        key={i}
                        className="flex gap-1.5 text-[11px] leading-snug text-muted-foreground"
                      >
                        <HugeiconsIcon
                          icon={AlertCircleIcon}
                          size={12}
                          strokeWidth={1.75}
                          className="mt-px shrink-0 text-amber-500/80"
                        />
                        <span>{c}</span>
                      </li>
                    ))}
                  </ul>
                </Section>
              ) : null}
            </div>
          ) : (
            <p className="text-[11.5px] text-muted-foreground">
              Nothing to show yet.
            </p>
          )}
        </div>

        {onEvaluate ? (
          <div className="mt-auto border-t border-border/50 px-5 py-3">
            <button
              type="button"
              onClick={onEvaluate}
              disabled={evaluating}
              className={cn(
                "inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-md border border-border/60 bg-card/60 text-[11.5px] font-medium text-foreground transition-colors hover:bg-foreground/[0.05]",
                evaluating && "cursor-not-allowed opacity-60",
              )}
            >
              <HugeiconsIcon
                icon={evaluating ? Loading03Icon : SparklesIcon}
                size={12}
                strokeWidth={1.75}
                className={evaluating ? "animate-spin" : ""}
              />
              {evaluating
                ? "Evaluating…"
                : verdict
                  ? "Re-evaluate"
                  : "Evaluate"}
            </button>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function Section({
  title,
  children,
  tone,
}: {
  title: string;
  children: React.ReactNode;
  tone?: "warn";
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div
        className={cn(
          "font-mono text-[9.5px] uppercase tracking-wider",
          tone === "warn"
            ? "text-amber-600/90 dark:text-amber-400/90"
            : "text-muted-foreground/70",
        )}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function EvidenceRow({ item }: { item: EvidenceItem }) {
  return (
    <li className="flex flex-col gap-1 rounded-md border border-border/45 bg-card/40 px-2.5 py-2">
      <p className="text-[11.5px] leading-snug text-foreground/85">
        <span className="font-mono text-[10px] text-muted-foreground/85">
          step {item.step}
        </span>
        <span className="mx-1.5 text-muted-foreground/40">·</span>
        {item.finding}
      </p>
      {item.ref ? (
        <RefChip refStr={item.ref} />
      ) : (
        <span className="inline-flex w-fit items-center gap-1 rounded-sm bg-rose-500/10 px-1.5 py-px text-[9.5px] font-medium text-rose-600 dark:text-rose-300">
          unverified — not grounded in code
        </span>
      )}
    </li>
  );
}

/** Renders an evidence file:line ref as a chip that opens the in-app code
 *  viewer, reusing the same event the chat's FileChip dispatches. */
function RefChip({ refStr }: { refStr: string }) {
  const parsed = parseRef(refStr);
  if (!parsed) {
    return (
      <span className="w-fit font-mono text-[10px] text-foreground/65">
        {refStr}
      </span>
    );
  }
  const open = () => {
    window.dispatchEvent(
      new CustomEvent("devops-studio:open-code-viewer", {
        detail: {
          path: parsed.path,
          startLine: parsed.startLine,
          endLine: parsed.endLine,
        },
      }),
    );
  };
  const lineLabel = parsed.startLine
    ? `:${parsed.startLine}${parsed.endLine && parsed.endLine !== parsed.startLine ? `–${parsed.endLine}` : ""}`
    : "";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={open}
          className="inline-flex w-fit max-w-full items-center gap-1 truncate rounded-sm border border-border/55 bg-foreground/[0.05] px-1.5 py-px font-mono text-[10px] text-foreground/85 transition-colors hover:border-primary/50 hover:bg-primary/[0.08] hover:text-primary"
        >
          <HugeiconsIcon icon={CodeIcon} size={9} strokeWidth={1.75} />
          <span className="truncate">
            {parsed.path}
            {lineLabel}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-[11px]">
        Open in the in-app code viewer
      </TooltipContent>
    </Tooltip>
  );
}

/** Parse "src/foo.ts:42-58" / "src/foo.ts:42" / "src/foo.ts" into parts.
 *  Tolerates the en-dash the model sometimes emits for ranges. */
function parseRef(
  ref: string,
): { path: string; startLine?: number; endLine?: number } | null {
  const trimmed = ref.trim();
  if (!trimmed) return null;
  const m = trimmed.match(/^(.*?):L?(\d+)(?:[-–]L?(\d+))?$/);
  if (!m) return { path: trimmed };
  return {
    path: m[1],
    startLine: Number.parseInt(m[2], 10),
    endLine: m[3] ? Number.parseInt(m[3], 10) : undefined,
  };
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

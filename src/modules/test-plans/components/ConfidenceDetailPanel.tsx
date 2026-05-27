import { useEffect } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { CodeRefChip, parseCodeRef } from "@/components/CodeRefChip";
import {
  AUTO_PASS_THRESHOLD,
  passReadiness,
  readinessTone,
  type ConfidenceVerdict,
  type EvidenceItem,
} from "../lib/confidence";
import {
  AlertCircleIcon,
  Cancel01Icon,
  GitBranchIcon,
  Loading03Icon,
  SparklesIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

/**
 * Confidence detail as an inline side panel — mirrors the generator's Ask
 * panel (a flex sibling, not a workspace tab) so the prediction sits beside
 * the cases / case it's about instead of opening a new tab. Clicking an
 * evidence `file:line` opens the code viewer as a normal tab in the focused
 * leaf.
 *
 * Fully controlled: the host owns "is it open" and the verdict, and provides
 * Re-evaluate. Dismiss via the close button or Esc.
 */
const PANEL_WIDTH = 380;

export function ConfidenceDetailPanel({
  title,
  verdict,
  evaluating,
  onReevaluate,
  onClose,
}: {
  title: string;
  verdict: ConfidenceVerdict | null;
  evaluating?: boolean;
  onReevaluate?: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const readiness = verdict ? passReadiness(verdict) : null;
  const tone = verdict
    ? readinessTone(readiness, verdict.predictedOutcome)
    : null;
  const conf = verdict ? Math.round(verdict.confidence) : 0;
  const isAutoPass =
    !!verdict &&
    verdict.predictedOutcome === "Pass" &&
    verdict.confidence >= AUTO_PASS_THRESHOLD;

  return (
    <aside
      className="flex h-full shrink-0 flex-col border-l border-border/60 bg-card/40"
      style={{ width: PANEL_WIDTH }}
    >
      <header className="flex shrink-0 flex-col gap-2 border-b border-border/40 bg-foreground/[0.02] px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-[12.5px] font-semibold tracking-tight">
            Confidence
          </span>
          {verdict && tone ? (
            <span
              className={cn(
                "rounded-sm px-1.5 py-px text-[11px] font-medium tabular-nums",
                tone.className,
              )}
            >
              {readiness !== null ? `${readiness}% pass-ready` : "Pass-ready —"}
            </span>
          ) : null}
          <div className="ml-auto flex items-center gap-1">
            {onReevaluate ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={onReevaluate}
                    disabled={evaluating}
                    aria-label="Re-evaluate"
                    className={cn(
                      "grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground",
                      evaluating && "cursor-not-allowed opacity-60",
                    )}
                  >
                    <HugeiconsIcon
                      icon={evaluating ? Loading03Icon : SparklesIcon}
                      size={12}
                      strokeWidth={1.75}
                      className={evaluating ? "animate-spin" : ""}
                    />
                  </button>
                </TooltipTrigger>
                <TooltipContent
                  variant="panel"
                  side="bottom"
                  align="end"
                  className="max-w-[280px] px-3 py-2 text-[11px] leading-relaxed"
                >
                  Re-read the source and recompute this prediction.
                </TooltipContent>
              </Tooltip>
            ) : null}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Close confidence panel"
                  className="grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
                >
                  <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={1.75} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-[11px]">
                Close · Esc
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
        <p className="truncate text-[11px] text-muted-foreground" title={title}>
          {title}
        </p>
        {verdict ? (
          <p className="text-[11px] leading-snug text-foreground/80">
            <span className="font-medium text-foreground">
              Predicted {verdict.predictedOutcome}
            </span>
            <span className="text-muted-foreground"> · {conf}% confidence.</span>
            {isAutoPass
              ? " Safe to mark Passed — every load-bearing step was grounded in code."
              : verdict.predictedOutcome === "Unknown"
                ? " Couldn't ground this in code — test it manually."
                : null}
          </p>
        ) : null}
        {verdict ? (
          <p className="flex items-center gap-1 text-[10px] text-muted-foreground/70">
            <HugeiconsIcon
              icon={GitBranchIcon}
              size={10}
              strokeWidth={1.75}
              className="shrink-0"
            />
            Make sure you&apos;re on the right branch.
          </p>
        ) : null}
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
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {!verdict ? (
          <p className="text-[11.5px] text-muted-foreground">
            {evaluating
              ? "Evaluating…"
              : "No verdict yet — run an evaluation to predict whether this case passes against the current source."}
          </p>
        ) : (
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
        )}
      </div>
    </aside>
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
        <CodeRef refStr={item.ref} />
      ) : (
        <span className="inline-flex w-fit items-center gap-1 rounded-sm bg-rose-500/10 px-1.5 py-px text-[9.5px] font-medium text-rose-600 dark:text-rose-300">
          unverified — not grounded in code
        </span>
      )}
    </li>
  );
}

/** An evidence ref → the shared multi-range code-ref pill, opened as a normal
 *  code-viewer tab in the focused leaf. */
function CodeRef({ refStr }: { refStr: string }) {
  const parsed = parseCodeRef(refStr);
  if (!parsed) {
    return (
      <span className="w-fit break-all font-mono text-[10px] text-foreground/65">
        {refStr}
      </span>
    );
  }
  return <CodeRefChip path={parsed.path} ranges={parsed.ranges} />;
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

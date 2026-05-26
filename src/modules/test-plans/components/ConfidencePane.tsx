import { useCallback, useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { getCase } from "@/modules/ado";
import { useTabsStore } from "@/modules/tabs/store/useTabsStore";
import {
  AUTO_PASS_THRESHOLD,
  confidenceTone,
  type ConfidenceVerdict,
  type EvidenceItem,
} from "../lib/confidence";
import { evaluateCaseConfidence } from "../lib/evaluateCaseConfidence";
import { saveConfidence } from "../lib/confidenceApi";
import {
  AlertCircleIcon,
  CodeIcon,
  Loading03Icon,
  SparklesIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

/**
 * Confidence detail as a full workspace pane (it used to be a right-side
 * Sheet that covered everything — so clicking an evidence ref opened the
 * code viewer *behind* the overlay and you couldn't read the reasoning and
 * the code together). As a pane it lives in the tab tree: clicking a
 * `file:line` opens the code viewer in the leaf *beside* this one, so the
 * prediction and the code it's grounded in sit side by side.
 *
 * `caseId` present ⇒ a published case ⇒ Re-evaluate (fetch → eval → save,
 * and refresh this pane's snapshot). Draft-sourced panes (from the generator
 * review) are read-only here; the review card keeps its own Evaluate.
 */
export function ConfidencePane({
  tabId,
  leafId,
  caseTitle,
  verdict,
  caseId,
}: {
  tabId: number;
  leafId: string;
  caseTitle: string;
  verdict: ConfidenceVerdict;
  caseId?: number | null;
}) {
  const [evaluating, setEvaluating] = useState(false);
  const tone = confidenceTone(verdict.confidence);
  const pct = Math.round(verdict.confidence);
  const isAutoPass =
    verdict.predictedOutcome === "Pass" &&
    verdict.confidence >= AUTO_PASS_THRESHOLD;

  const onReevaluate = useCallback(async () => {
    if (caseId == null || evaluating) return;
    setEvaluating(true);
    try {
      const tc = await getCase(caseId);
      const v = await evaluateCaseConfidence({
        title: tc.title,
        steps: tc.steps.map((s) => ({ action: s.action, expected: s.expected })),
      });
      useTabsStore.getState().updateConfidenceVerdict(tabId, v);
      await saveConfidence(caseId, v).catch(() => undefined);
    } catch (e) {
      console.error("[confidence] re-evaluation failed:", e);
    } finally {
      setEvaluating(false);
    }
  }, [caseId, evaluating, tabId]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {/* Header — score + case it's about, mirrors the chat-pane header rhythm. */}
      <header className="flex shrink-0 flex-col gap-2 border-b border-border/50 bg-card/40 px-5 py-3">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-semibold tracking-tight">
            Confidence
          </span>
          <span
            className={cn(
              "rounded-sm px-1.5 py-px text-[11px] font-medium tabular-nums",
              tone.className,
            )}
          >
            {pct}% · {verdict.predictedOutcome}
          </span>
          {caseId != null ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => void onReevaluate()}
                  disabled={evaluating}
                  className={cn(
                    "ml-auto inline-flex h-6 items-center gap-1.5 rounded-md border border-border/60 bg-card/60 px-2 text-[11px] font-medium text-foreground transition-colors hover:bg-foreground/[0.05]",
                    evaluating && "cursor-not-allowed opacity-60",
                  )}
                >
                  <HugeiconsIcon
                    icon={evaluating ? Loading03Icon : SparklesIcon}
                    size={11}
                    strokeWidth={1.75}
                    className={evaluating ? "animate-spin" : ""}
                  />
                  {evaluating ? "Evaluating…" : "Re-evaluate"}
                </button>
              </TooltipTrigger>
              <TooltipContent
                variant="panel"
                side="bottom"
                align="end"
                className="max-w-[300px] px-3 py-2 text-[11px] leading-relaxed"
              >
                Re-read the source and recompute the prediction, then save it
                to this case. Use after the code or the case steps change.
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>
        <p className="truncate text-[11.5px] text-muted-foreground" title={caseTitle}>
          {caseTitle}
        </p>
        <p className="text-[11.5px] leading-snug text-foreground/80">
          {isAutoPass
            ? "High confidence — auto-pass candidate. Every load-bearing step was grounded in code."
            : verdict.predictedOutcome === "Unknown"
              ? "Couldn't ground this in code — needs manual testing."
              : "Below the 90% auto-pass bar — flag for manual testing."}
        </p>
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
      </header>

      <div className="mx-auto flex w-full max-w-2xl min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-4">
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
                <EvidenceRow key={i} item={e} leafId={leafId} />
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
    </div>
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

function EvidenceRow({
  item,
  leafId,
}: {
  item: EvidenceItem;
  leafId: string;
}) {
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
        <RefChip refStr={item.ref} leafId={leafId} />
      ) : (
        <span className="inline-flex w-fit items-center gap-1 rounded-sm bg-rose-500/10 px-1.5 py-px text-[9.5px] font-medium text-rose-600 dark:text-rose-300">
          unverified — not grounded in code
        </span>
      )}
    </li>
  );
}

/** An evidence file:line ref. Opens the in-app code viewer in the leaf
 *  *beside* this pane (via `besideLeafId`), so reasoning + code stay visible
 *  together. Reuses the same event every other code chip dispatches, so path
 *  resolution + dedup are identical. */
function RefChip({ refStr, leafId }: { refStr: string; leafId: string }) {
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
          besideLeafId: leafId,
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
      <TooltipContent
        variant="panel"
        side="top"
        className="max-w-[280px] px-3 py-2 text-[11px] leading-relaxed"
      >
        Open this code beside the prediction — they stay visible together so
        you can check the reasoning against the source.
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

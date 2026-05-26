import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon, Edit02Icon, RefreshIcon } from "@hugeicons/core-free-icons";
import { diffSteps, StepsDiff, type StepLine } from "@/components/diff/stepsDiff";
import { TextDiff } from "@/components/diff/textDiff";
import { useGenerationSession } from "./store/useGenerationSession";
import type { ReviewedBug, ReviewedCase } from "./lib/draftBatchSchema";

/**
 * "What did the last refine change?" panel for the review phase.
 *
 * A refine re-prompts the model with the whole draft, so the store keeps the
 * pre-refine batch in `refineUndoSnapshot`. We diff that snapshot against the
 * current draft and show — per case and per bug — exactly which fields moved:
 * the description (line diff), the steps (step diff), the repro steps, and
 * severity. Each card surfaces only the fields that actually changed, so a
 * step-only edit shows just steps and a wording tweak shows just the
 * description.
 *
 * Cases/bugs are paired by title (a refine usually keeps titles stable); a
 * renamed item reads as one removed + one added, which is honest rather than
 * guessing. Renders nothing until a refine has happened this session.
 */
export function RefineChangesPanel() {
  const snapshot = useGenerationSession((s) => s.refineUndoSnapshot);
  const cases = useGenerationSession((s) => s.cases);
  const bugs = useGenerationSession((s) => s.bugs);
  const undoRefine = useGenerationSession((s) => s.undoRefine);
  const [expanded, setExpanded] = useState(true);

  const diff = useMemo(() => {
    if (!snapshot) return null;
    return {
      cases: pairCases(snapshot.cases, cases),
      bugs: pairBugs(snapshot.bugs, bugs),
    };
  }, [snapshot, cases, bugs]);

  if (!snapshot || !diff) return null;

  const c = diff.cases;
  const b = diff.bugs;
  const totalChanges =
    c.added.length +
    c.removed.length +
    c.modified.length +
    b.added.length +
    b.removed.length +
    b.modified.length;

  return (
    <div className="overflow-hidden rounded-md border border-border/60 bg-card/40">
      <div className="flex items-center gap-2.5 px-3 py-2">
        <HugeiconsIcon
          icon={Edit02Icon}
          size={13}
          strokeWidth={1.75}
          className="shrink-0 text-foreground/70"
        />
        <div className="min-w-0 flex-1">
          <span className="text-[11.5px] font-medium leading-tight text-foreground">
            Last refine
          </span>
          <p className="mt-0.5 truncate text-[10.5px] leading-snug text-muted-foreground">
            {totalChanges === 0
              ? "No changes — the draft came back identical."
              : summarize(c, b)}
          </p>
        </div>

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => undoRefine()}
              className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-border/60 bg-card/60 px-2 text-[10.5px] text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
            >
              <HugeiconsIcon icon={RefreshIcon} size={11} strokeWidth={1.75} />
              Undo refine
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-[260px] text-[11px]">
            Roll the draft back to the state it was in before this refine. The
            current draft is discarded.
          </TooltipContent>
        </Tooltip>

        {totalChanges > 0 ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            className={cn(
              "inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[10.5px] text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground",
              expanded && "bg-foreground/[0.05] text-foreground",
            )}
          >
            <HugeiconsIcon
              icon={ArrowDown01Icon}
              size={10}
              strokeWidth={1.75}
              className={cn("transition-transform", expanded && "rotate-180")}
            />
            {expanded ? "Hide" : "Changes"}
          </button>
        ) : null}
      </div>

      {expanded && totalChanges > 0 ? (
        <div className="flex flex-col gap-2 border-t border-border/30 px-3 py-2.5">
          {/* Cases */}
          {c.added.map((cs) => (
            <ChangeCard key={`ca-${cs.uid}`} tone="added" title={cs.title}>
              {cs.description.trim() ? (
                <Field label="Description">
                  <TextDiff before="" after={cs.description} />
                </Field>
              ) : null}
              <Field label="Steps">
                <StepsDiff rows={diffSteps([], toStepLines(cs))} />
              </Field>
            </ChangeCard>
          ))}
          {c.modified.map(({ before, after }) => {
            const ch = caseFieldChanges(before, after);
            return (
              <ChangeCard key={`cm-${after.uid}`} tone="modified" title={after.title}>
                {ch.description ? (
                  <Field label="Description">
                    <TextDiff before={before.description} after={after.description} />
                  </Field>
                ) : null}
                {ch.steps ? (
                  <Field label="Steps">
                    <StepsDiff rows={diffSteps(toStepLines(before), toStepLines(after))} />
                  </Field>
                ) : null}
                {ch.rationale ? (
                  <Field label="Rationale">
                    <TextDiff before={before.rationale} after={after.rationale} />
                  </Field>
                ) : null}
              </ChangeCard>
            );
          })}
          {c.removed.map((cs) => (
            <ChangeCard key={`cr-${cs.uid}`} tone="removed" title={cs.title}>
              <Field label="Steps">
                <StepsDiff rows={diffSteps(toStepLines(cs), [])} />
              </Field>
            </ChangeCard>
          ))}

          {/* Bugs */}
          {b.added.length + b.removed.length + b.modified.length > 0 ? (
            <span className="mt-1 font-mono text-[9.5px] uppercase tracking-wider text-muted-foreground/85">
              Bug suggestions
            </span>
          ) : null}
          {b.added.map((bug) => (
            <ChangeCard key={`ba-${bug.uid}`} tone="added" title={bug.title}>
              <SeverityLine after={bug.severity} />
              <Field label="Repro steps">
                <TextDiff before="" after={bug.reproSteps} />
              </Field>
            </ChangeCard>
          ))}
          {b.modified.map(({ before, after }) => (
            <ChangeCard key={`bm-${after.uid}`} tone="modified" title={after.title}>
              {before.severity !== after.severity ? (
                <SeverityLine before={before.severity} after={after.severity} />
              ) : null}
              {before.reproSteps !== after.reproSteps ? (
                <Field label="Repro steps">
                  <TextDiff before={before.reproSteps} after={after.reproSteps} />
                </Field>
              ) : null}
            </ChangeCard>
          ))}
          {b.removed.map((bug) => (
            <ChangeCard key={`br-${bug.uid}`} tone="removed" title={bug.title}>
              <Field label="Repro steps">
                <TextDiff before={bug.reproSteps} after="" />
              </Field>
            </ChangeCard>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// --- Cards & fields ---------------------------------------------------------

type Tone = "added" | "removed" | "modified";

const TONE: Record<Tone, { label: string; pill: string }> = {
  added: { label: "added", pill: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" },
  removed: { label: "removed", pill: "bg-rose-500/15 text-rose-600 dark:text-rose-300" },
  modified: { label: "reworked", pill: "bg-amber-500/15 text-amber-700 dark:text-amber-300" },
};

function ChangeCard({
  tone,
  title,
  children,
}: {
  tone: Tone;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-md border border-border/45 bg-card/30">
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <span
          className={cn(
            "shrink-0 rounded-sm px-1.5 py-px text-[9.5px] font-medium uppercase tracking-wider",
            TONE[tone].pill,
          )}
        >
          {TONE[tone].label}
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-[11.5px] font-medium",
            tone === "removed" ? "text-foreground/60 line-through" : "text-foreground",
          )}
          title={title}
        >
          {title}
        </span>
      </div>
      <div className="flex flex-col">{children}</div>
    </div>
  );
}

/** A labelled change section inside a card (Description / Steps / Repro). */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-border/25">
      <div className="bg-foreground/[0.02] px-3 py-1 font-mono text-[9px] uppercase tracking-wider text-muted-foreground/85">
        {label}
      </div>
      {children}
    </div>
  );
}

/** Severity change line — a before→after when it moved, a single pill when
 *  added/unchanged. */
function SeverityLine({ before, after }: { before?: string; after: string }) {
  const short = (s: string) => s.split(" - ")[1] ?? s;
  return (
    <div className="flex items-center gap-1.5 border-t border-border/25 px-3 py-1.5 text-[10.5px]">
      <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground/85">
        Severity
      </span>
      {before && before !== after ? (
        <span className="text-muted-foreground">
          <span className="line-through">{short(before)}</span> → {short(after)}
        </span>
      ) : (
        <span className="text-foreground/80">{short(after)}</span>
      )}
    </div>
  );
}

// --- Pairing ----------------------------------------------------------------

function toStepLines(c: ReviewedCase): StepLine[] {
  return c.steps.map((s, i) => ({ index: i + 1, action: s.action, expected: s.expected }));
}

const norm = (s: string) => s.trim().toLowerCase();

function stepsChanged(a: ReviewedCase, b: ReviewedCase): boolean {
  if (a.steps.length !== b.steps.length) return true;
  for (let i = 0; i < a.steps.length; i++) {
    if (a.steps[i].action !== b.steps[i].action) return true;
    if (a.steps[i].expected !== b.steps[i].expected) return true;
  }
  return false;
}

function caseFieldChanges(a: ReviewedCase, b: ReviewedCase) {
  return {
    description: a.description !== b.description,
    steps: stepsChanged(a, b),
    rationale: (a.rationale ?? "") !== (b.rationale ?? ""),
  };
}

function caseChanged(a: ReviewedCase, b: ReviewedCase): boolean {
  const ch = caseFieldChanges(a, b);
  return ch.description || ch.steps || ch.rationale;
}

function pairCases(before: ReviewedCase[], after: ReviewedCase[]) {
  const pool = new Map<string, ReviewedCase[]>();
  for (const item of before) {
    const k = norm(item.title);
    const arr = pool.get(k);
    if (arr) arr.push(item);
    else pool.set(k, [item]);
  }
  const added: ReviewedCase[] = [];
  const modified: { before: ReviewedCase; after: ReviewedCase }[] = [];
  for (const a of after) {
    const prev = pool.get(norm(a.title))?.shift();
    if (!prev) added.push(a);
    else if (caseChanged(prev, a)) modified.push({ before: prev, after: a });
  }
  const removed: ReviewedCase[] = [];
  for (const arr of pool.values()) removed.push(...arr);
  return { added, removed, modified };
}

function pairBugs(before: ReviewedBug[], after: ReviewedBug[]) {
  const pool = new Map<string, ReviewedBug[]>();
  for (const item of before) {
    const k = norm(item.title);
    const arr = pool.get(k);
    if (arr) arr.push(item);
    else pool.set(k, [item]);
  }
  const added: ReviewedBug[] = [];
  const modified: { before: ReviewedBug; after: ReviewedBug }[] = [];
  for (const a of after) {
    const prev = pool.get(norm(a.title))?.shift();
    if (!prev) added.push(a);
    else if (prev.reproSteps !== a.reproSteps || prev.severity !== a.severity) {
      modified.push({ before: prev, after: a });
    }
  }
  const removed: ReviewedBug[] = [];
  for (const arr of pool.values()) removed.push(...arr);
  return { added, removed, modified };
}

function summarize(
  c: { added: unknown[]; removed: unknown[]; modified: unknown[] },
  b: { added: unknown[]; removed: unknown[]; modified: unknown[] },
): string {
  const seg = (bits: string[]) => bits.join(" · ");
  const parts: string[] = [];
  const caseBits: string[] = [];
  if (c.modified.length) caseBits.push(`${c.modified.length} reworked`);
  if (c.added.length) caseBits.push(`${c.added.length} added`);
  if (c.removed.length) caseBits.push(`${c.removed.length} removed`);
  if (caseBits.length) parts.push(`Cases: ${seg(caseBits)}`);

  const bugBits: string[] = [];
  if (b.modified.length) bugBits.push(`${b.modified.length} reworked`);
  if (b.added.length) bugBits.push(`${b.added.length} added`);
  if (b.removed.length) bugBits.push(`${b.removed.length} removed`);
  if (bugBits.length) parts.push(`Bugs: ${seg(bugBits)}`);

  return parts.join("   ·   ");
}

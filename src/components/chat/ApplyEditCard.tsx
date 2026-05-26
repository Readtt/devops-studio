import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  AlertCircleIcon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  Edit02Icon,
  Loading03Icon,
  RefreshIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { openUrl } from "@tauri-apps/plugin-opener";
import type {
  AppliedEditRecord,
  ApplyEditHandler,
  ApplyEditResult,
  CaseLookup,
  EditBeforeSnapshot,
  UndoEditHandler,
} from "@/components/ChatMarkdown";

/**
 * Inline "Apply to ADO" card for a `devops-edit` fenced block.
 *
 * Design goal: read like a quiet inline action, not a colored callout.
 * Single horizontal row by default. No status stripe, no colored tint —
 * just a thin border and a small kind icon. The diff lives under a Diff
 * toggle so the message stays scannable when there are several edits.
 *
 * The `applied` prop holds the persisted post-apply result. When it's
 * non-null the card renders the quiet "Applied" terminal state with no
 * Apply button — that's how we make reopening a chat behave correctly
 * after the user already pushed the change to ADO.
 */

export type ParsedEdit =
  | {
      ok: true;
      kind:
        | "rename"
        | "rewrite-steps"
        | "create-case"
        | "delete-case"
        | "set-outcome"
        | "unknown";
      caseId: number | null;
      title: string | null;
      steps: { action: string; expected: string }[];
      /** Optional model-provided reason — used by delete-case to surface
       *  "why is this being removed?" in the confirm step. */
      reason: string | null;
      /** Canonical execution outcome for set-outcome blocks — one of
       *  Passed / Failed / Blocked / NotApplicable / Active, or null when the
       *  model emitted something we don't recognize. */
      outcome: string | null;
    }
  | { ok: false; error: string };

/** Map a loose model-supplied outcome string onto the canonical ADO value.
 *  Tolerates "pass"/"fail"/"n/a"/"reset" etc. so a chatty payload still
 *  applies. Returns null for anything unrecognized. */
function normalizeOutcome(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  switch (raw.trim().toLowerCase().replace(/[\s_]/g, "")) {
    case "pass":
    case "passed":
      return "Passed";
    case "fail":
    case "failed":
      return "Failed";
    case "block":
    case "blocked":
      return "Blocked";
    case "na":
    case "n/a":
    case "notapplicable":
      return "NotApplicable";
    case "active":
    case "reset":
    case "notrun":
    case "unspecified":
      return "Active";
    default:
      return null;
  }
}

/** Display label + dot colour for an outcome chip on a set-outcome card. */
function outcomeChip(outcome: string | null): { label: string; className: string } {
  switch (outcome) {
    case "Passed":
      return { label: "Passed", className: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" };
    case "Failed":
      return { label: "Failed", className: "bg-rose-500/15 text-rose-600 dark:text-rose-300" };
    case "Blocked":
      return { label: "Blocked", className: "bg-amber-500/15 text-amber-700 dark:text-amber-300" };
    case "NotApplicable":
      return { label: "Not applicable", className: "bg-foreground/[0.08] text-muted-foreground" };
    case "Active":
      return { label: "Reset to not-run", className: "bg-foreground/[0.08] text-muted-foreground" };
    default:
      return { label: "Unknown", className: "bg-destructive/15 text-destructive" };
  }
}

type ApplyState = "idle" | "applying" | "undoing" | "error";

export function ApplyEditCard({
  body,
  onApply,
  lookupCase,
  applied,
  onApplied,
  onUndo,
  onUndone,
}: {
  body: string;
  onApply: ApplyEditHandler;
  lookupCase?: CaseLookup;
  /** Persisted apply result from a previous session. When set, the card
   *  renders as already-applied — no Apply button. */
  applied?: AppliedEditRecord | null;
  /** Fired after a successful apply in the current session so the parent
   *  can persist the applied state into the message. */
  onApplied?: (record: AppliedEditRecord) => void;
  /** ADO-side undo handler. Performs the inverse write using the snapshot
   *  the applied record captured at apply-time. Optional — when omitted,
   *  the Undo button is hidden. */
  onUndo?: UndoEditHandler;
  /** Called after a successful undo so the parent can drop the persisted
   *  applied-edit record. */
  onUndone?: () => void;
}) {
  const [state, setState] = useState<ApplyState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const parsed = useMemo(() => parseEdit(body), [body]);

  const current = parsed.ok && parsed.caseId != null
    ? lookupCase?.(parsed.caseId) ?? null
    : null;

  // Precompute the step diff once so the summary and the expanded body
  // share the same numbers and we don't redo the LCS on every toggle.
  const stepRows = useMemo<DiffRow[] | null>(() => {
    if (!parsed.ok || parsed.kind !== "rewrite-steps") return null;
    const indexed: StepLine[] = parsed.steps.map((s, i) => ({
      index: i + 1,
      action: s.action,
      expected: s.expected,
    }));
    return diffSteps(current?.steps ?? [], indexed);
  }, [parsed, current]);

  const apply = async () => {
    if (state === "applying" || state === "undoing") return;
    if (applied) return;
    if (!parsed.ok) {
      setState("error");
      setErrorMessage(parsed.error);
      return;
    }
    setState("applying");
    setErrorMessage(null);
    try {
      // Hand the handler the normalized payload (coerced caseId, parsed
      // steps) so model-side type sloppiness doesn't reach the wire.
      const payload: Record<string, unknown> = {
        kind: parsed.kind,
        caseId: parsed.caseId,
      };
      if (parsed.kind === "rename") payload.title = parsed.title ?? "";
      if (parsed.kind === "rewrite-steps") payload.steps = parsed.steps;
      if (parsed.kind === "set-outcome") payload.outcome = parsed.outcome;
      if (parsed.kind === "create-case") {
        payload.title = parsed.title ?? "";
        payload.steps = parsed.steps;
      }
      if (parsed.kind === "delete-case") {
        // Delete is irreversible from the chat — confirm before firing.
        // We use the native confirm because we want a blocking
        // synchronous gate; the user has to actively say yes.
        const confirmed = window.confirm(
          parsed.caseId
            ? `Delete case #${parsed.caseId}? It moves to the ADO Recycle Bin and is recoverable for 30 days.`
            : "Delete this case?",
        );
        if (!confirmed) {
          setState("idle");
          return;
        }
        if (parsed.reason) payload.reason = parsed.reason;
      }
      const result: ApplyEditResult = await onApply(payload);
      if (result.ok) {
        // Snapshot the pre-apply state so Undo can revive it later. We
        // capture from `current` (resolved from the live case list at the
        // moment of apply) rather than re-reading at undo-time, so the
        // undo target is deterministic regardless of any concurrent
        // edits that happen between apply and undo.
        const before: EditBeforeSnapshot | undefined =
          current && parsed.kind === "rename"
            ? { kind: "rename", title: current.title }
            : current && parsed.kind === "rewrite-steps"
              ? {
                  kind: "rewrite-steps",
                  steps: current.steps.map((s) => ({
                    action: s.action,
                    expected: s.expected,
                  })),
                }
              : undefined;
        const record: AppliedEditRecord = {
          appliedAt: new Date().toISOString(),
          message: result.message ?? "Applied.",
          caseId: parsed.caseId ?? undefined,
          before,
        };
        // Tell the parent — that triggers the chat-store update that
        // persists the applied state so reopening the chat keeps it.
        onApplied?.(record);
        setState("idle");
        setExpanded(false);
      } else {
        setState("error");
        setErrorMessage(result.message ?? "Couldn't apply.");
      }
    } catch (e) {
      setState("error");
      setErrorMessage(e instanceof Error ? e.message : String(e));
    }
  };

  const undo = async () => {
    if (state === "undoing" || state === "applying") return;
    if (!applied || !onUndo) return;
    setState("undoing");
    setErrorMessage(null);
    try {
      const result = await onUndo(applied);
      if (result.ok) {
        // Tell the parent — that drops the applied record so the card
        // re-renders in the idle "Apply" state.
        onUndone?.();
        setState("idle");
      } else {
        setState("error");
        setErrorMessage(result.message ?? "Couldn't undo.");
      }
    } catch (e) {
      setState("error");
      setErrorMessage(e instanceof Error ? e.message : String(e));
    }
  };

  // --- Malformed block ----------------------------------------------------

  if (!parsed.ok) {
    return (
      <div className="rounded-md border border-border/55 bg-card/30 px-3 py-2">
        <Row
          icon={AlertCircleIcon}
          tone="error"
          title="Malformed edit block"
          subtitle={parsed.error}
        />
      </div>
    );
  }

  const kindLabel =
    parsed.kind === "rename"
      ? "Rename"
      : parsed.kind === "rewrite-steps"
        ? "Rewrite steps"
        : parsed.kind === "create-case"
          ? "Create case"
          : parsed.kind === "delete-case"
            ? "Delete case"
            : parsed.kind === "set-outcome"
              ? "Set outcome"
              : `Edit (${parsed.kind})`;

  // --- Already-applied (persisted across sessions) -------------------------

  if (applied) {
    // Undo is only offered when the applied record actually carries the
    // pre-apply snapshot — otherwise we have nothing to revert to. Records
    // persisted before the snapshot field existed still show as Applied
    // but without the button.
    const canUndo = !!applied.before && !!onUndo;
    const undoErrorMessage = state === "error" ? errorMessage : null;
    return (
      <div
        className={cn(
          "rounded-md border bg-card/30 px-3 py-2 transition-colors",
          state === "error" ? "border-destructive/40" : "border-border/45",
        )}
      >
        <div className="flex items-center gap-2.5">
          <HugeiconsIcon
            icon={state === "undoing" ? Loading03Icon : Tick02Icon}
            size={13}
            strokeWidth={1.75}
            className={cn(
              "shrink-0 text-muted-foreground",
              state === "undoing" && "animate-spin text-foreground/70",
            )}
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
              <span className="text-[11.5px] font-medium leading-tight text-foreground">
                {`Applied · ${kindLabel.toLowerCase()}`}
              </span>
              {parsed.caseId != null ? (
                <CaseRefBadge
                  caseId={parsed.caseId}
                  title={current?.title ?? null}
                  webUrl={current?.webUrl ?? null}
                  suite={current?.suite ?? null}
                />
              ) : null}
            </div>
            <p
              className={cn(
                "mt-0.5 truncate text-[10.5px] leading-snug",
                undoErrorMessage ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {undoErrorMessage ?? applied.message}
            </p>
          </div>
          {canUndo ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={undo}
                  disabled={state === "undoing"}
                  className={cn(
                    "inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-border/60 bg-card/60 px-2.5 text-[11px] font-medium text-foreground transition-colors hover:bg-foreground/[0.05]",
                    state === "undoing" && "cursor-not-allowed opacity-60",
                  )}
                >
                  <HugeiconsIcon
                    icon={state === "undoing" ? Loading03Icon : RefreshIcon}
                    size={11}
                    strokeWidth={1.75}
                    className={state === "undoing" ? "animate-spin" : ""}
                  />
                  {state === "undoing" ? "Undoing…" : "Undo"}
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-[11px]">
                Revert the case in Azure DevOps to the state it was in
                before this edit was applied.
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      </div>
    );
  }

  // --- Idle / applying / error --------------------------------------------

  const subtitle = errorMessage ?? buildSubtitle(parsed, current, stepRows);
  const canExpand =
    parsed.kind === "rename" ||
    (parsed.kind === "rewrite-steps" && (stepRows?.length ?? 0) > 0) ||
    (parsed.kind === "create-case" && parsed.steps.length > 0);

  return (
    <div
      className={cn(
        "rounded-md border bg-card/30 transition-colors",
        state === "error" ? "border-destructive/40" : "border-border/55",
      )}
    >
      <div className="flex items-center gap-2.5 px-3 py-2">
        <KindIcon state={state} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <span className="text-[11.5px] font-medium leading-tight text-foreground">
              {kindLabel}
            </span>
            {parsed.kind === "create-case" ? (
              <span className="rounded-sm bg-emerald-500/15 px-1.5 py-px font-mono text-[9.5px] uppercase tracking-wider text-emerald-700 dark:text-emerald-300">
                new
              </span>
            ) : parsed.caseId != null ? (
              <CaseRefBadge
                caseId={parsed.caseId}
                title={current?.title ?? null}
                webUrl={current?.webUrl ?? null}
                suite={current?.suite ?? null}
              />
            ) : (
              <span className="font-mono text-[10px] text-destructive">
                no caseId
              </span>
            )}
            {parsed.kind === "set-outcome" ? (
              <span
                className={cn(
                  "rounded-sm px-1.5 py-px text-[9.5px] font-medium uppercase tracking-wider",
                  outcomeChip(parsed.outcome).className,
                )}
              >
                {outcomeChip(parsed.outcome).label}
              </span>
            ) : null}
          </div>
          <p
            className={cn(
              "mt-0.5 truncate text-[10.5px] leading-snug",
              state === "error" ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {subtitle}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {canExpand ? (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              className={cn(
                "inline-flex h-7 items-center gap-1 rounded-md px-2 text-[10.5px] text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground",
                expanded && "bg-foreground/[0.05] text-foreground",
              )}
            >
              <HugeiconsIcon
                icon={ArrowDown01Icon}
                size={10}
                strokeWidth={1.75}
                className={cn("transition-transform", expanded && "rotate-180")}
              />
              Diff
            </button>
          ) : null}
          <ApplyButton
            state={state}
            onClick={apply}
            // create-case is the one kind where caseId is optionally null
            // — the case doesn't exist yet. Every other kind requires a
            // caseId to target the right work item. set-outcome also needs a
            // recognized outcome before it can be applied.
            disabled={
              (parsed.kind !== "create-case" && parsed.caseId == null) ||
              (parsed.kind === "set-outcome" && !parsed.outcome)
            }
          />
        </div>
      </div>

      {expanded ? (
        <div className="border-t border-border/30">
          {parsed.kind === "rename" ? (
            <RenameDiff
              beforeTitle={current?.title ?? null}
              afterTitle={parsed.title ?? "(no title)"}
            />
          ) : parsed.kind === "rewrite-steps" ? (
            <StepsDiff rows={stepRows ?? []} />
          ) : parsed.kind === "create-case" ? (
            <CreateCasePreview
              title={parsed.title ?? "(no title)"}
              steps={parsed.steps}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row primitives
// ---------------------------------------------------------------------------

function Row({
  icon,
  tone,
  title,
  subtitle,
  caseRef,
}: {
  icon: React.ComponentProps<typeof HugeiconsIcon>["icon"];
  tone: "muted" | "error";
  title: string;
  subtitle?: string;
  caseRef?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <HugeiconsIcon
        icon={icon}
        size={13}
        strokeWidth={1.75}
        className={cn(
          "shrink-0",
          tone === "error" ? "text-destructive" : "text-muted-foreground",
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <span
            className={cn(
              "text-[11.5px] font-medium leading-tight",
              tone === "error" ? "text-destructive" : "text-foreground",
            )}
          >
            {title}
          </span>
          {caseRef ?? null}
        </div>
        {subtitle ? (
          <p
            className={cn(
              "mt-0.5 truncate text-[10.5px] leading-snug",
              tone === "error" ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {subtitle}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function KindIcon({ state }: { state: ApplyState }) {
  const icon =
    state === "applying"
      ? Loading03Icon
      : state === "error"
        ? AlertCircleIcon
        : Edit02Icon;
  return (
    <HugeiconsIcon
      icon={icon}
      size={13}
      strokeWidth={1.75}
      className={cn(
        "shrink-0",
        state === "error"
          ? "text-destructive"
          : state === "applying"
            ? "animate-spin text-foreground/70"
            : "text-foreground/70",
      )}
    />
  );
}

function ApplyButton({
  state,
  onClick,
  disabled,
}: {
  state: ApplyState;
  onClick: () => void;
  disabled?: boolean;
}) {
  const label =
    state === "applying"
      ? "Applying…"
      : state === "error"
        ? "Retry"
        : "Apply";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          disabled={disabled || state === "applying"}
          className={cn(
            "inline-flex h-7 items-center gap-1 rounded-md border px-2.5 text-[11px] font-medium transition-colors",
            "border-border/60 bg-card/60 text-foreground hover:bg-foreground/[0.05]",
            (disabled || state === "applying") && "cursor-not-allowed opacity-60",
          )}
        >
          {state === "applying" ? (
            <HugeiconsIcon
              icon={Loading03Icon}
              size={11}
              strokeWidth={2}
              className="animate-spin"
            />
          ) : null}
          {label}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-[11px]">
        Push this change to Azure DevOps. The case is updated in place.
      </TooltipContent>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// Rename diff
// ---------------------------------------------------------------------------

export function RenameDiff({
  beforeTitle,
  afterTitle,
}: {
  beforeTitle: string | null;
  afterTitle: string;
}) {
  return (
    <div className="grid grid-cols-[1fr_auto_1fr] items-stretch">
      <DiffSide label="Current">
        <p className="whitespace-pre-wrap break-words text-[11.5px] leading-snug text-foreground/75">
          {beforeTitle ?? (
            <span className="italic text-muted-foreground">
              Not in current scope
            </span>
          )}
        </p>
      </DiffSide>
      <DiffArrow />
      <DiffSide label="Proposed">
        <p className="whitespace-pre-wrap break-words text-[11.5px] font-medium leading-snug text-foreground">
          {afterTitle}
        </p>
      </DiffSide>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create-case preview — read-only render of the proposed new case so the
// user can scan it before Apply. There's no "before" side because the case
// doesn't exist yet; the title + steps render as a single proposed body.
// ---------------------------------------------------------------------------

export function CreateCasePreview({
  title,
  steps,
}: {
  title: string;
  steps: { action: string; expected: string }[];
}) {
  return (
    <div className="flex flex-col gap-0">
      <div className="bg-foreground/[0.02] px-3 py-2">
        <span className="font-mono text-[9.5px] uppercase tracking-wider text-muted-foreground/85">
          Title
        </span>
        <p className="mt-0.5 text-[11.5px] font-medium leading-snug text-foreground">
          {title}
        </p>
      </div>
      <div className="grid grid-cols-[24px_1fr_1fr] gap-2 border-t border-border/25 bg-foreground/[0.02] px-3 py-1 font-mono text-[9.5px] uppercase tracking-wider text-muted-foreground/85">
        <span>#</span>
        <span>Action</span>
        <span>Expected</span>
      </div>
      <div className="divide-y divide-border/25">
        {steps.length === 0 ? (
          <div className="px-3 py-3 text-[11px] text-muted-foreground">
            (no steps in proposal)
          </div>
        ) : (
          steps.map((s, i) => (
            <div
              key={i}
              className="grid grid-cols-[24px_1fr_1fr] gap-2 px-3 py-1.5"
            >
              <span className="font-mono text-[10px] text-emerald-700 dark:text-emerald-300">
                +{i + 1}
              </span>
              <p className="whitespace-pre-wrap text-[11.5px] leading-snug text-foreground/90">
                {s.action || <Placeholder />}
              </p>
              <p className="whitespace-pre-wrap text-[11.5px] leading-snug text-foreground/90">
                {s.expected || <Placeholder />}
              </p>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Steps diff
// ---------------------------------------------------------------------------

export type StepLine = { index: number; action: string; expected: string };

export type DiffRow =
  | { kind: "unchanged"; before: StepLine; after: StepLine }
  | { kind: "changed"; before: StepLine; after: StepLine }
  | { kind: "added"; after: StepLine }
  | { kind: "removed"; before: StepLine };

export function StepsDiff({ rows }: { rows: DiffRow[] }) {
  return (
    <div>
      <div className="grid grid-cols-[24px_1fr_1fr] gap-2 bg-foreground/[0.02] px-3 py-1 font-mono text-[9.5px] uppercase tracking-wider text-muted-foreground/85">
        <span>#</span>
        <span>Action</span>
        <span>Expected</span>
      </div>
      <div className="divide-y divide-border/25">
        {rows.map((row, i) => (
          <StepDiffRow key={i} row={row} />
        ))}
        {rows.length === 0 ? (
          <div className="px-3 py-3 text-[11px] text-muted-foreground">
            (no steps in proposal)
          </div>
        ) : null}
      </div>
    </div>
  );
}

function StepDiffRow({ row }: { row: DiffRow }) {
  // Each row uses one subtle background tint to signal change type. We
  // intentionally avoid color saturation higher than ~6% so the diff reads
  // as informative rather than alarming.
  if (row.kind === "added") {
    return (
      <div className="grid grid-cols-[24px_1fr_1fr] gap-2 px-3 py-1.5">
        <span className="font-mono text-[10px] text-emerald-700 dark:text-emerald-300">
          +{row.after.index}
        </span>
        <p className="whitespace-pre-wrap text-[11.5px] leading-snug text-foreground/90">
          {row.after.action || <Placeholder />}
        </p>
        <p className="whitespace-pre-wrap text-[11.5px] leading-snug text-foreground/90">
          {row.after.expected || <Placeholder />}
        </p>
      </div>
    );
  }
  if (row.kind === "removed") {
    return (
      <div className="grid grid-cols-[24px_1fr_1fr] gap-2 px-3 py-1.5">
        <span className="font-mono text-[10px] text-muted-foreground line-through">
          −{row.before.index}
        </span>
        <p className="whitespace-pre-wrap text-[11.5px] leading-snug text-foreground/55 line-through">
          {row.before.action || <Placeholder />}
        </p>
        <p className="whitespace-pre-wrap text-[11.5px] leading-snug text-foreground/55 line-through">
          {row.before.expected || <Placeholder />}
        </p>
      </div>
    );
  }
  if (row.kind === "unchanged") {
    return (
      <div className="grid grid-cols-[24px_1fr_1fr] gap-2 px-3 py-1.5">
        <span className="font-mono text-[10px] text-muted-foreground/70">
          {row.after.index}
        </span>
        <p className="whitespace-pre-wrap text-[11.5px] leading-snug text-foreground/65">
          {row.after.action}
        </p>
        <p className="whitespace-pre-wrap text-[11.5px] leading-snug text-foreground/65">
          {row.after.expected}
        </p>
      </div>
    );
  }
  // changed — compare action and expected INDEPENDENTLY. A row is "changed"
  // overall if either column differs; the other column should render as
  // plain unchanged text instead of a misleading strikethrough+repeat. The
  // model often rewords just the action while keeping the expected result
  // identical (or vice versa) — showing both columns as changed reads as
  // "everything moved" when only half moved.
  const actionChanged = row.before.action !== row.after.action;
  const expectedChanged = row.before.expected !== row.after.expected;
  return (
    <div className="grid grid-cols-[24px_1fr_1fr] gap-2 px-3 py-1.5">
      <span className="font-mono text-[10px] text-foreground/65">
        {row.after.index}
      </span>
      <ColumnDiff
        changed={actionChanged}
        before={row.before.action}
        after={row.after.action}
      />
      <ColumnDiff
        changed={expectedChanged}
        before={row.before.expected}
        after={row.after.expected}
      />
    </div>
  );
}

/** Renders a single column of a "changed" row: strikethrough + new lines
 *  when the column actually changed, plain text when it didn't. */
function ColumnDiff({
  changed,
  before,
  after,
}: {
  changed: boolean;
  before: string;
  after: string;
}) {
  if (!changed) {
    return (
      <p className="whitespace-pre-wrap text-[11.5px] leading-snug text-foreground/75">
        {after || <Placeholder />}
      </p>
    );
  }
  return (
    <div className="min-w-0">
      <p className="whitespace-pre-wrap text-[11.5px] leading-snug text-muted-foreground line-through">
        {before || <Placeholder />}
      </p>
      <p className="mt-0.5 whitespace-pre-wrap text-[11.5px] font-medium leading-snug text-foreground">
        {after || <Placeholder />}
      </p>
    </div>
  );
}

function Placeholder() {
  return <span className="italic text-muted-foreground/70">(empty)</span>;
}

// LCS-style diff over step pairs. Small N*M (~30x30) so cost is irrelevant.
export function diffSteps(before: StepLine[], after: StepLine[]): DiffRow[] {
  const norm = (s: StepLine) => `${s.action}∷${s.expected}`;
  const beforeKeys = before.map(norm);
  const afterKeys = after.map(norm);

  if (beforeKeys.length === afterKeys.length && beforeKeys.every((k, i) => k === afterKeys[i])) {
    return after.map((a, i) => ({ kind: "unchanged", before: before[i], after: a }));
  }

  const m = beforeKeys.length;
  const n = afterKeys.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (beforeKeys[i] === afterKeys[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (beforeKeys[i] === afterKeys[j]) {
      rows.push({ kind: "unchanged", before: before[i], after: after[j] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      if (
        j < n &&
        dp[i + 1][j + 1] >= dp[i][j] - 1 &&
        before[i].action.length + before[i].expected.length > 0 &&
        after[j].action.length + after[j].expected.length > 0
      ) {
        rows.push({ kind: "changed", before: before[i], after: after[j] });
        i++;
        j++;
      } else {
        rows.push({ kind: "removed", before: before[i] });
        i++;
      }
    } else {
      rows.push({ kind: "added", after: after[j] });
      j++;
    }
  }
  while (i < m) {
    rows.push({ kind: "removed", before: before[i] });
    i++;
  }
  while (j < n) {
    rows.push({ kind: "added", after: after[j] });
    j++;
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Shared chrome
// ---------------------------------------------------------------------------

function DiffSide({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 bg-foreground/[0.015] p-2.5">
      <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground/70">
        {label}
      </span>
      {children}
    </div>
  );
}

function DiffArrow() {
  return (
    <div className="flex items-center justify-center border-x border-border/25 bg-foreground/[0.02] px-2">
      <HugeiconsIcon
        icon={ArrowRight01Icon}
        size={11}
        strokeWidth={2}
        className="text-muted-foreground/70"
      />
    </div>
  );
}

export function CaseRefBadge({
  caseId,
  title,
  webUrl,
  suite,
}: {
  caseId: number;
  title: string | null;
  webUrl: string | null;
  suite?: { planId: number; suiteId: number } | null;
}) {
  const onOpen = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    window.dispatchEvent(
      new CustomEvent("devops-studio:open-test-case", {
        detail: {
          caseId,
          title: title ? `#${caseId} ${title}` : `#${caseId}`,
          planId: suite?.planId ?? null,
          suiteId: suite?.suiteId ?? null,
        },
      }),
    );
  };
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onOpen}
          onAuxClick={(e) => {
            if (webUrl) {
              e.preventDefault();
              void openUrl(webUrl);
            }
          }}
          className="inline-flex max-w-[14rem] items-center gap-1 truncate rounded-sm border border-border/55 bg-foreground/[0.04] px-1 py-px font-mono text-[10px] text-foreground/85 transition-colors hover:bg-foreground/[0.08]"
        >
          <span>#{caseId}</span>
          {title ? (
            <span className="truncate font-sans text-foreground/65">{title}</span>
          ) : null}
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        variant="panel"
        className="max-w-[280px] p-0"
      >
        <div className="px-3 py-2">
          <div className="font-mono text-[9.5px] uppercase tracking-wider text-muted-foreground/85">
            Case #{caseId}
          </div>
          <p className="mt-1 text-[12px] font-medium leading-snug text-foreground">
            {title ?? (
              <span className="italic text-muted-foreground">
                Not in current scope
              </span>
            )}
          </p>
        </div>
        <div className="border-t border-border/40 bg-foreground/[0.03] px-3 py-1.5 text-[10.5px] leading-snug text-muted-foreground">
          {webUrl ? (
            <>
              Click to open in app
              <span className="mx-1 text-muted-foreground/55">·</span>
              middle-click for Azure DevOps
            </>
          ) : (
            "Click to open in app"
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// Subtitle + payload parsing
// ---------------------------------------------------------------------------

export function buildSubtitle(
  parsed: Extract<ParsedEdit, { ok: true }>,
  current: { title: string } | null,
  stepRows: DiffRow[] | null,
): string {
  if (parsed.kind === "rename") {
    if (!current) {
      return `Set title to "${truncate(parsed.title ?? "", 60)}"`;
    }
    if (current.title === parsed.title) return "No change — proposal matches current title.";
    return `"${truncate(current.title, 28)}" → "${truncate(parsed.title ?? "", 28)}"`;
  }
  if (parsed.kind === "rewrite-steps") {
    if (!stepRows) return `${parsed.steps.length} step${parsed.steps.length === 1 ? "" : "s"} proposed`;
    let added = 0;
    let removed = 0;
    let changed = 0;
    let unchanged = 0;
    for (const r of stepRows) {
      if (r.kind === "added") added++;
      else if (r.kind === "removed") removed++;
      else if (r.kind === "changed") changed++;
      else unchanged++;
    }
    const parts: string[] = [];
    if (changed) parts.push(`${changed} changed`);
    if (added) parts.push(`${added} added`);
    if (removed) parts.push(`${removed} removed`);
    if (parts.length === 0) {
      return unchanged === 0
        ? "No changes."
        : `${unchanged} step${unchanged === 1 ? "" : "s"} match current — no change.`;
    }
    return parts.join(" · ");
  }
  if (parsed.kind === "create-case") {
    const title = parsed.title?.trim();
    if (!title) return "Missing title — cannot create.";
    return `"${truncate(title, 60)}" · ${parsed.steps.length} step${parsed.steps.length === 1 ? "" : "s"}`;
  }
  if (parsed.kind === "delete-case") {
    if (parsed.caseId == null) return "Missing caseId — cannot delete.";
    if (parsed.reason) {
      return `Move to Recycle Bin · ${truncate(parsed.reason, 50)}`;
    }
    return `Move #${parsed.caseId} to the ADO Recycle Bin (recoverable for 30 days)`;
  }
  if (parsed.kind === "set-outcome") {
    if (parsed.caseId == null) return "Missing caseId — cannot record.";
    if (!parsed.outcome) {
      return "Unsupported outcome — expected Passed, Failed, Blocked, N/A, or Active.";
    }
    return parsed.outcome === "Active"
      ? `Reset #${parsed.caseId} to "not run" on its test point`
      : `Record #${parsed.caseId} as ${outcomeChip(parsed.outcome).label} on its test point`;
  }
  return `Unsupported edit kind "${parsed.kind}"`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

export function parseEdit(body: string): ParsedEdit {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch (e) {
    return {
      ok: false,
      error:
        e instanceof Error
          ? `JSON parse failed: ${e.message}`
          : "JSON parse failed",
    };
  }
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "Edit payload isn't a JSON object." };
  }
  const obj = raw as Record<string, unknown>;
  const kind = typeof obj.kind === "string" ? obj.kind : "unknown";
  const caseIdRaw = obj.caseId;
  const caseId =
    typeof caseIdRaw === "number" && Number.isFinite(caseIdRaw)
      ? caseIdRaw
      : typeof caseIdRaw === "string" && /^\d+$/.test(caseIdRaw.trim())
        ? Number.parseInt(caseIdRaw.trim(), 10)
        : null;
  const reason = typeof obj.reason === "string" ? obj.reason : null;
  if (kind === "rename") {
    const title = typeof obj.title === "string" ? obj.title : null;
    return { ok: true, kind: "rename", caseId, title, steps: [], reason, outcome: null };
  }
  if (kind === "set-outcome") {
    return {
      ok: true,
      kind: "set-outcome",
      caseId,
      title: null,
      steps: [],
      reason,
      outcome: normalizeOutcome(obj.outcome),
    };
  }
  if (kind === "rewrite-steps") {
    const stepsArr = Array.isArray(obj.steps) ? obj.steps : [];
    const steps: { action: string; expected: string }[] = [];
    for (const s of stepsArr) {
      if (!s || typeof s !== "object") continue;
      const so = s as Record<string, unknown>;
      steps.push({
        action: typeof so.action === "string" ? so.action : "",
        expected: typeof so.expected === "string" ? so.expected : "",
      });
    }
    return { ok: true, kind: "rewrite-steps", caseId, title: null, steps, reason, outcome: null };
  }
  if (kind === "create-case") {
    const title = typeof obj.title === "string" ? obj.title : null;
    const stepsArr = Array.isArray(obj.steps) ? obj.steps : [];
    const steps: { action: string; expected: string }[] = [];
    for (const s of stepsArr) {
      if (!s || typeof s !== "object") continue;
      const so = s as Record<string, unknown>;
      steps.push({
        action: typeof so.action === "string" ? so.action : "",
        expected: typeof so.expected === "string" ? so.expected : "",
      });
    }
    return { ok: true, kind: "create-case", caseId, title, steps, reason, outcome: null };
  }
  if (kind === "delete-case") {
    return { ok: true, kind: "delete-case", caseId, title: null, steps: [], reason, outcome: null };
  }
  return { ok: true, kind: "unknown", caseId, title: null, steps: [], reason, outcome: null };
}

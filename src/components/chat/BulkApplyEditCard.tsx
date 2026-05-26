import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  AlertCircleIcon,
  ArrowDown01Icon,
  Loading03Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { Checkbox } from "@/components/ui/checkbox";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  buildSubtitle,
  CaseRefBadge,
  CreateCasePreview,
  diffSteps,
  parseEdit,
  RenameDiff,
  StepsDiff,
  type DiffRow,
  type ParsedEdit,
} from "./ApplyEditCard";
import type {
  AppliedEditRecord,
  AppliedEditsMap,
  ApplyEditHandler,
  CaseLookup,
} from "@/components/ChatMarkdown";

/**
 * Bulk "Apply to ADO" card for a `devops-bulk-edit` fenced block. The block
 * body is `{ "edits": [ <devops-edit objects> ] }` — the model uses it to
 * propose changes to MANY cases at once.
 *
 * One grouped card: each proposed edit is a selectable row (checkbox +
 * one-line summary + expandable diff). The user can cherry-pick which to
 * apply ("Apply selected") or trust the whole batch ("Apply all"). Each row
 * applies through the SAME handler the single-edit ApplyEditCard uses, so the
 * ADO writes are identical — this card is just the batching UX on top.
 *
 * Partial applies survive reload: each sub-edit is content-addressed by a
 * deterministic hash (parent block hash + index + canonicalized edit) and its
 * applied state is persisted in the message's appliedEdits map, exactly like
 * single edits.
 */
type RowState = "idle" | "applying" | "ok" | "failed";

type ParsedRow = {
  index: number;
  subHash: string;
  parsed: ParsedEdit;
};

export function BulkApplyEditCard({
  body,
  blockHash,
  onApply,
  lookupCase,
  appliedEdits,
  onApplied,
}: {
  body: string;
  /** Hash of the whole bulk block — namespaces each sub-edit's persisted key. */
  blockHash: string;
  onApply: ApplyEditHandler;
  lookupCase?: CaseLookup;
  appliedEdits?: AppliedEditsMap;
  /** Persist a row's applied state, keyed by the row's sub-hash. */
  onApplied?: (subHash: string, record: AppliedEditRecord) => void;
}) {
  const doc = useMemo(() => parseBulk(body), [body]);
  const rows = useMemo<ParsedRow[]>(() => {
    if (!doc.ok) return [];
    return doc.edits.map((e, i) => ({
      index: i,
      subHash: subEditHash(blockHash, i, e),
      parsed: parseEdit(JSON.stringify(e)),
    }));
  }, [doc, blockHash]);

  const isApplied = (subHash: string) => !!appliedEdits?.[subHash];

  // Default-select every appliable, not-yet-applied row. Runs once on mount.
  const [selected, setSelected] = useState<Set<number>>(() => {
    const s = new Set<number>();
    for (const r of rows) {
      if (appliable(r.parsed) && !appliedEdits?.[r.subHash]) s.add(r.index);
    }
    return s;
  });
  const [rowState, setRowState] = useState<Record<number, RowState>>({});
  const [rowError, setRowError] = useState<Record<number, string>>({});
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const [running, setRunning] = useState(false);

  if (!doc.ok) {
    return (
      <div className="rounded-md border border-destructive/40 bg-card/30 px-3 py-2">
        <div className="flex items-center gap-2.5">
          <HugeiconsIcon
            icon={AlertCircleIcon}
            size={13}
            strokeWidth={1.75}
            className="shrink-0 text-destructive"
          />
          <div className="min-w-0">
            <p className="text-[11.5px] font-medium text-foreground">
              Malformed bulk-edit block
            </p>
            <p className="mt-0.5 truncate text-[10.5px] text-destructive">
              {doc.error}
            </p>
          </div>
        </div>
      </div>
    );
  }

  const toggle = (index: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });

  const toggleExpand = (index: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });

  const applyRows = async (indices: number[]) => {
    if (running) return;
    setRunning(true);
    try {
      for (const i of indices) {
        const row = rows[i];
        if (!row || !row.parsed.ok) continue;
        if (isApplied(row.subHash) || rowState[i] === "ok") continue;
        if (!appliable(row.parsed)) continue;
        const p = row.parsed;
        const payload: Record<string, unknown> = { kind: p.kind, caseId: p.caseId };
        if (p.kind === "rename") payload.title = p.title ?? "";
        if (p.kind === "rewrite-steps") payload.steps = p.steps;
        if (p.kind === "set-outcome") payload.outcome = p.outcome;
        if (p.kind === "create-case") {
          payload.title = p.title ?? "";
          payload.steps = p.steps;
        }
        if (p.kind === "delete-case") {
          // Irreversible from chat — confirm each delete before firing, even
          // inside Apply all. The user actively says yes per case.
          const ok = window.confirm(
            p.caseId
              ? `Delete case #${p.caseId}? It moves to the ADO Recycle Bin and is recoverable for 30 days.`
              : "Delete this case?",
          );
          if (!ok) continue;
          if (p.reason) payload.reason = p.reason;
        }
        setRowState((s) => ({ ...s, [i]: "applying" }));
        try {
          const result = await onApply(payload);
          if (result.ok) {
            setRowState((s) => ({ ...s, [i]: "ok" }));
            setSelected((prev) => {
              const next = new Set(prev);
              next.delete(i);
              return next;
            });
            onApplied?.(row.subHash, {
              appliedAt: new Date().toISOString(),
              message: result.message ?? "Applied.",
              caseId: p.caseId ?? undefined,
            });
          } else {
            setRowState((s) => ({ ...s, [i]: "failed" }));
            setRowError((s) => ({ ...s, [i]: result.message ?? "Couldn't apply." }));
          }
        } catch (e) {
          // One row failing must not abort the batch — record it and move on.
          setRowState((s) => ({ ...s, [i]: "failed" }));
          setRowError((s) => ({
            ...s,
            [i]: e instanceof Error ? e.message : String(e),
          }));
        }
      }
    } finally {
      setRunning(false);
    }
  };

  const pendingIndices = rows
    .filter((r) => appliable(r.parsed) && !isApplied(r.subHash) && rowState[r.index] !== "ok")
    .map((r) => r.index);
  const selectedPending = [...selected].filter((i) => pendingIndices.includes(i)).sort((a, b) => a - b);
  const appliedCount = rows.filter(
    (r) => isApplied(r.subHash) || rowState[r.index] === "ok",
  ).length;

  return (
    <div className="overflow-hidden rounded-md border border-border/55 bg-card/30">
      <div className="flex items-center gap-2 border-b border-border/40 bg-foreground/[0.02] px-3 py-2">
        <span className="text-[11.5px] font-medium text-foreground">
          {rows.length} proposed edit{rows.length === 1 ? "" : "s"}
        </span>
        {appliedCount > 0 ? (
          <span className="rounded-sm bg-emerald-500/15 px-1.5 py-px text-[9.5px] font-medium text-emerald-700 dark:text-emerald-300">
            {appliedCount} applied
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-1.5">
          <BatchButton
            label={`Apply selected${selectedPending.length ? ` (${selectedPending.length})` : ""}`}
            onClick={() => void applyRows(selectedPending)}
            disabled={running || selectedPending.length === 0}
            running={running}
          />
          <BatchButton
            label="Apply all"
            onClick={() => void applyRows(pendingIndices)}
            disabled={running || pendingIndices.length === 0}
            running={running}
            primary
          />
        </div>
      </div>

      <ul className="divide-y divide-border/30">
        {rows.map((row) => (
          <BulkRow
            key={row.index}
            row={row}
            lookupCase={lookupCase}
            applied={isApplied(row.subHash) || rowState[row.index] === "ok"}
            state={rowState[row.index] ?? "idle"}
            error={rowError[row.index] ?? null}
            checked={selected.has(row.index)}
            onToggle={() => toggle(row.index)}
            expanded={expanded.has(row.index)}
            onToggleExpand={() => toggleExpand(row.index)}
          />
        ))}
      </ul>
    </div>
  );
}

function BulkRow({
  row,
  lookupCase,
  applied,
  state,
  error,
  checked,
  onToggle,
  expanded,
  onToggleExpand,
}: {
  row: ParsedRow;
  lookupCase?: CaseLookup;
  applied: boolean;
  state: RowState;
  error: string | null;
  checked: boolean;
  onToggle: () => void;
  expanded: boolean;
  onToggleExpand: () => void;
}) {
  const parsed = row.parsed;
  const current =
    parsed.ok && parsed.caseId != null ? (lookupCase?.(parsed.caseId) ?? null) : null;

  const stepRows = useMemo<DiffRow[] | null>(() => {
    if (!parsed.ok || parsed.kind !== "rewrite-steps") return null;
    const indexed = parsed.steps.map((s, i) => ({
      index: i + 1,
      action: s.action,
      expected: s.expected,
    }));
    return diffSteps(current?.steps ?? [], indexed);
  }, [parsed, current]);

  if (!parsed.ok) {
    return (
      <li className="flex items-center gap-2 px-3 py-2">
        <HugeiconsIcon
          icon={AlertCircleIcon}
          size={12}
          strokeWidth={1.75}
          className="shrink-0 text-destructive"
        />
        <span className="text-[10.5px] text-destructive">{parsed.error}</span>
      </li>
    );
  }

  const subtitle = error ?? buildSubtitle(parsed, current, stepRows);
  const canExpand =
    parsed.kind === "rename" ||
    (parsed.kind === "rewrite-steps" && (stepRows?.length ?? 0) > 0) ||
    (parsed.kind === "create-case" && parsed.steps.length > 0);
  const ok = appliable(parsed);

  return (
    <li className="px-3 py-2">
      <div className="flex items-center gap-2.5">
        {applied ? (
          <HugeiconsIcon
            icon={Tick02Icon}
            size={14}
            strokeWidth={2}
            className="shrink-0 text-emerald-600 dark:text-emerald-400"
          />
        ) : state === "applying" ? (
          <HugeiconsIcon
            icon={Loading03Icon}
            size={14}
            strokeWidth={2}
            className="shrink-0 animate-spin text-foreground/70"
          />
        ) : (
          <Checkbox
            checked={checked}
            onCheckedChange={onToggle}
            disabled={!ok}
            aria-label="Include this edit"
            className="shrink-0"
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <span className="text-[11px] font-medium leading-tight text-foreground">
              {kindLabel(parsed.kind)}
            </span>
            {parsed.kind === "create-case" ? (
              <span className="rounded-sm bg-emerald-500/15 px-1 py-px font-mono text-[9px] uppercase tracking-wider text-emerald-700 dark:text-emerald-300">
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
              <span className="font-mono text-[10px] text-destructive">no caseId</span>
            )}
          </div>
          <p
            className={cn(
              "mt-0.5 truncate text-[10.5px] leading-snug",
              state === "failed" ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {subtitle}
          </p>
        </div>
        {canExpand ? (
          <button
            type="button"
            onClick={onToggleExpand}
            aria-expanded={expanded}
            className={cn(
              "inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[10px] text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground",
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
      </div>

      {expanded ? (
        <div className="mt-1.5 overflow-hidden rounded-sm border border-border/30">
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
    </li>
  );
}

function BatchButton({
  label,
  onClick,
  disabled,
  running,
  primary,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  running?: boolean;
  primary?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          disabled={disabled}
          className={cn(
            "inline-flex h-7 items-center gap-1 rounded-md border px-2.5 text-[11px] font-medium transition-colors",
            primary
              ? "border-primary/50 bg-primary/90 text-primary-foreground hover:bg-primary"
              : "border-border/60 bg-card/60 text-foreground hover:bg-foreground/[0.05]",
            disabled && "cursor-not-allowed opacity-50",
          )}
        >
          {running ? (
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
      <TooltipContent side="top" className="max-w-[260px] text-[11px]">
        Push these changes to Azure DevOps. Each row is written as its own
        edit; one failing won&apos;t stop the rest.
      </TooltipContent>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// Parsing + helpers
// ---------------------------------------------------------------------------

type ParsedBulk =
  | { ok: true; edits: unknown[] }
  | { ok: false; error: string };

function parseBulk(body: string): ParsedBulk {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? `JSON parse failed: ${e.message}` : "JSON parse failed",
    };
  }
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "Bulk-edit payload isn't a JSON object." };
  }
  const editsRaw = (raw as Record<string, unknown>).edits;
  if (!Array.isArray(editsRaw)) {
    return { ok: false, error: 'Missing "edits" array.' };
  }
  if (editsRaw.length === 0) {
    return { ok: false, error: "Empty edits array." };
  }
  return { ok: true, edits: editsRaw };
}

/** Whether a parsed edit has everything it needs to be applied — mirrors the
 *  single-card's disabled logic so a half-specified row can't be selected. */
function appliable(parsed: ParsedEdit): boolean {
  if (!parsed.ok) return false;
  if (parsed.kind === "create-case") return !!parsed.title && parsed.steps.length > 0;
  if (parsed.caseId == null) return false;
  if (parsed.kind === "set-outcome") return !!parsed.outcome;
  if (parsed.kind === "unknown") return false;
  return true;
}

function kindLabel(kind: string): string {
  switch (kind) {
    case "rename":
      return "Rename";
    case "rewrite-steps":
      return "Rewrite steps";
    case "create-case":
      return "Create case";
    case "delete-case":
      return "Delete case";
    case "set-outcome":
      return "Set outcome";
    default:
      return `Edit (${kind})`;
  }
}

/** Deterministic, reload-stable hash for a sub-edit: parent block hash +
 *  index + canonicalized (sorted-key) JSON. Namespacing by block + index keeps
 *  two structurally-identical edits in the same batch distinct. */
function subEditHash(blockHash: string, index: number, edit: unknown): string {
  const s = `${blockHash}:${index}:${canonicalJson(edit)}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return (h >>> 0).toString(36);
}

function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const obj = v as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",")}}`;
}

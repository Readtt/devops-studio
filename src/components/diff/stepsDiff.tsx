// Shared step-level diff: the LCS pairing + the row renderer for the
// generator's refine-changes panel. The look intentionally matches the
// suite-chat "rewrite-steps" Apply card (low-saturation tints, strikethrough
// on removed/changed text, +/− gutter markers) — that card carries its own
// inline copy of this logic in chat/ApplyEditCard.tsx; if you change the diff
// presentation, change both, or fold ApplyEditCard onto this module.

export type StepLine = { index: number; action: string; expected: string };

export type DiffRow =
  | { kind: "unchanged"; before: StepLine; after: StepLine }
  | { kind: "changed"; before: StepLine; after: StepLine }
  | { kind: "added"; after: StepLine }
  | { kind: "removed"; before: StepLine };

export function Placeholder() {
  return <span className="italic text-muted-foreground/70">(empty)</span>;
}

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

// LCS-style diff over step pairs. Small N*M (~30x30) so cost is irrelevant.
export function diffSteps(before: StepLine[], after: StepLine[]): DiffRow[] {
  const norm = (s: StepLine) => `${s.action}∷${s.expected}`;
  const beforeKeys = before.map(norm);
  const afterKeys = after.map(norm);

  if (
    beforeKeys.length === afterKeys.length &&
    beforeKeys.every((k, i) => k === afterKeys[i])
  ) {
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

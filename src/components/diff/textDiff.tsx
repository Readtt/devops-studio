// Line-based unified text diff for prose fields (case descriptions, bug repro
// steps). Same red/green/strikethrough language as the step diff, rendered as
// a unified list: removed lines first (rose, −), then added (emerald, +),
// unchanged lines muted. Standard and unambiguous — no side-by-side to parse.

type LineRow = { kind: "unchanged" | "added" | "removed"; text: string };

export function TextDiff({ before, after }: { before: string; after: string }) {
  const rows = lineDiff(before, after);
  return (
    <div className="divide-y divide-border/20">
      {rows.map((row, i) => (
        <div
          key={i}
          className={cnRow(row.kind)}
        >
          <span className="select-none pt-px font-mono text-[10px] leading-snug text-muted-foreground/60">
            {row.kind === "added" ? "+" : row.kind === "removed" ? "−" : " "}
          </span>
          <p
            className={
              row.kind === "removed"
                ? "whitespace-pre-wrap text-[11.5px] leading-snug text-rose-700/90 line-through dark:text-rose-300/80"
                : row.kind === "added"
                  ? "whitespace-pre-wrap text-[11.5px] leading-snug text-emerald-800 dark:text-emerald-200"
                  : "whitespace-pre-wrap text-[11.5px] leading-snug text-foreground/55"
            }
          >
            {row.text || " "}
          </p>
        </div>
      ))}
    </div>
  );
}

function cnRow(kind: LineRow["kind"]): string {
  const base = "grid grid-cols-[14px_1fr] gap-1.5 px-3 py-0.5";
  if (kind === "added") return `${base} bg-emerald-500/[0.07]`;
  if (kind === "removed") return `${base} bg-rose-500/[0.07]`;
  return base;
}

// LCS over lines — same shape as the step diff, just on plain strings.
function lineDiff(before: string, after: string): LineRow[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const m = a.length;
  const n = b.length;

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const rows: LineRow[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      rows.push({ kind: "unchanged", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ kind: "removed", text: a[i] });
      i++;
    } else {
      rows.push({ kind: "added", text: b[j] });
      j++;
    }
  }
  while (i < m) {
    rows.push({ kind: "removed", text: a[i] });
    i++;
  }
  while (j < n) {
    rows.push({ kind: "added", text: b[j] });
    j++;
  }
  return rows;
}

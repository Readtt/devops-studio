import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  parseUnifiedDiff,
  type DiffHunk,
  type DiffLine,
  type FileDiff,
  type FileStatus,
} from "./unifiedDiff";
import type { CommitDiff } from "./gitCommitApi";

/**
 * Read-only viewer for a single commit's unified diff. Renders the `rawPatch`
 * the backend already fetched (git_commit_diff) — no extra IPC — as a
 * file-grouped, line-numbered diff using the same rose/emerald language as the
 * fix-preview diff (components/diff/textDiff). Each file is collapsible and its
 * path opens in the code viewer, matching ApplyPatchCard.
 */
export function CommitDiffView({ diff }: { diff: CommitDiff }) {
  const files = useMemo(() => parseUnifiedDiff(diff.rawPatch), [diff.rawPatch]);

  if (files.length === 0) {
    return (
      <div className="rounded-md border border-border/55 bg-card/40 px-3 py-3 text-center text-[11.5px] text-muted-foreground">
        No textual diff to show — this commit changed no file contents (an empty,
        merge, or metadata-only commit).
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="divide-y divide-border/40 overflow-hidden rounded-md border border-border/55 bg-card/40">
        {files.map((file, i) => (
          <FileBlock key={`${file.path}-${i}`} file={file} />
        ))}
      </div>
      {diff.truncated ? (
        <p className="px-1 text-[10.5px] leading-snug text-muted-foreground">
          This is a large commit — the diff was truncated for display, so later
          files or hunks may be missing. Open a file to read its full contents.
        </p>
      ) : null}
    </div>
  );
}

/**
 * Renders one or several commits' diffs. A single commit renders inline; a
 * multi-commit selection gets a labelled section header per commit so the
 * reviewer can tell which change belongs to which commit.
 */
export function CommitDiffPanel({ diffs }: { diffs: CommitDiff[] }) {
  if (diffs.length === 0) return null;
  if (diffs.length === 1) return <CommitDiffView diff={diffs[0]} />;
  return (
    <div className="flex flex-col gap-3">
      {diffs.map((diff, i) => (
        <section key={diff.sha} className="flex flex-col gap-1.5">
          <CommitSectionHeader diff={diff} index={i} total={diffs.length} />
          <CommitDiffView diff={diff} />
        </section>
      ))}
    </div>
  );
}

function CommitSectionHeader({
  diff,
  index,
  total,
}: {
  diff: CommitDiff;
  index: number;
  total: number;
}) {
  const adds = diff.files.reduce((s, f) => s + f.additions, 0);
  const dels = diff.files.reduce((s, f) => s + f.deletions, 0);
  return (
    <div className="flex items-center gap-2 rounded-md border border-border/55 bg-foreground/[0.03] px-2.5 py-1.5">
      <span className="shrink-0 rounded-sm bg-primary/12 px-1 py-px font-mono text-[9px] font-medium uppercase tracking-wide text-primary">
        {index + 1}/{total}
      </span>
      <span className="shrink-0 font-mono text-[11px] text-foreground/85">
        {diff.shortSha}
      </span>
      <span className="min-w-0 flex-1 truncate text-[11.5px] text-foreground/80">
        {diff.subject}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2 font-mono text-[10.5px]">
        <span className="text-muted-foreground">
          {diff.files.length} file{diff.files.length === 1 ? "" : "s"}
        </span>
        {adds > 0 ? (
          <span className="text-emerald-600 dark:text-emerald-400">+{adds}</span>
        ) : null}
        {dels > 0 ? (
          <span className="text-rose-600 dark:text-rose-400">−{dels}</span>
        ) : null}
      </span>
    </div>
  );
}

function FileBlock({ file }: { file: FileDiff }) {
  const [open, setOpen] = useState(true);
  // No point opening a deletion (it's gone from the working tree) or a binary
  // blob (the code viewer can't render it).
  const canOpen = file.status !== "deleted" && !file.isBinary;

  const openInViewer = () => {
    const startLine = file.hunks[0]?.newStart ?? 1;
    window.dispatchEvent(
      new CustomEvent("devops-studio:open-code-viewer", {
        detail: { path: file.path, startLine, endLine: startLine },
      }),
    );
  };

  return (
    <div className="bg-card/20">
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              aria-label={open ? "Collapse file" : "Expand file"}
              className="shrink-0 rounded-sm p-0.5 text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
            >
              <HugeiconsIcon
                icon={ArrowRight01Icon}
                size={12}
                strokeWidth={2}
                className={cn("transition-transform", open && "rotate-90")}
              />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-[11px]">
            {open ? "Collapse this file's diff." : "Expand this file's diff."}
          </TooltipContent>
        </Tooltip>
        <StatusBadge status={file.status} />
        {canOpen ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={openInViewer}
                className="min-w-0 truncate text-left font-mono text-[11px] text-foreground/85 transition-colors hover:text-foreground hover:underline"
              >
                <PathLabel file={file} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-[280px] text-[11px]">
              Open this file in the code viewer at the first change.
            </TooltipContent>
          </Tooltip>
        ) : (
          <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
            <PathLabel file={file} />
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2 font-mono text-[10.5px]">
          {file.additions > 0 ? (
            <span className="text-emerald-600 dark:text-emerald-400">
              +{file.additions}
            </span>
          ) : null}
          {file.deletions > 0 ? (
            <span className="text-rose-600 dark:text-rose-400">
              −{file.deletions}
            </span>
          ) : null}
        </span>
      </div>

      {open ? (
        file.isBinary ? (
          <BodyNote>Binary file — no text diff to display.</BodyNote>
        ) : file.hunks.length === 0 ? (
          <BodyNote>
            {file.status === "renamed"
              ? "Renamed with no content changes."
              : "No content changes (mode or metadata only)."}
          </BodyNote>
        ) : (
          <div className="border-t border-border/40 bg-foreground/[0.02]">
            {file.hunks.map((hunk, i) => (
              <HunkBlock key={i} hunk={hunk} />
            ))}
          </div>
        )
      ) : null}
    </div>
  );
}

function PathLabel({ file }: { file: FileDiff }) {
  if (file.status === "renamed" && file.oldPath && file.oldPath !== file.path) {
    return (
      <span>
        <span className="text-muted-foreground">{file.oldPath}</span>
        <span className="text-muted-foreground/50"> → </span>
        {file.path}
      </span>
    );
  }
  return <>{file.path}</>;
}

function BodyNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-t border-border/40 bg-foreground/[0.02] px-3 py-2 text-[10.5px] text-muted-foreground">
      {children}
    </div>
  );
}

function HunkBlock({ hunk }: { hunk: DiffHunk }) {
  return (
    <div>
      <div className="truncate bg-foreground/[0.03] px-3 py-0.5 font-mono text-[10px] leading-snug text-muted-foreground/70">
        {hunk.header}
      </div>
      {hunk.lines.map((line, i) => (
        <DiffRow key={i} line={line} />
      ))}
    </div>
  );
}

function DiffRow({ line }: { line: DiffLine }) {
  const isAdd = line.kind === "add";
  const isDel = line.kind === "del";
  return (
    <div
      className={cn(
        "flex items-start",
        isAdd && "bg-emerald-500/[0.07]",
        isDel && "bg-rose-500/[0.07]",
      )}
    >
      <Gutter>{line.oldLine ?? ""}</Gutter>
      <Gutter>{line.newLine ?? ""}</Gutter>
      {/* Muted +/− marker, same as the canonical textDiff sign column. */}
      <span className="w-3 shrink-0 select-none py-px text-center font-mono text-[10px] leading-snug text-muted-foreground/60">
        {isAdd ? "+" : isDel ? "−" : ""}
      </span>
      <span
        className={cn(
          // Add/del reuse textDiff's exact tokens; context sits at /70 rather
          // than textDiff's /55 — a full-file code diff is mostly context, so
          // it needs to stay legible where short prose diffs don't.
          "min-w-0 flex-1 whitespace-pre-wrap break-words py-px pl-1 pr-3 font-mono text-[11px] leading-snug",
          isAdd && "text-emerald-800 dark:text-emerald-200",
          isDel && "text-rose-700/90 dark:text-rose-300/80",
          !isAdd && !isDel && "text-foreground/70",
        )}
      >
        {line.text || " "}
      </span>
    </div>
  );
}

function Gutter({ children }: { children: React.ReactNode }) {
  return (
    <span className="w-10 shrink-0 select-none px-1.5 py-px text-right font-mono text-[10px] leading-snug text-muted-foreground/40 tabular-nums">
      {children}
    </span>
  );
}

function StatusBadge({ status }: { status: FileStatus }) {
  const config: Record<FileStatus, { label: string; cls: string }> = {
    added: {
      label: "added",
      cls: "text-emerald-700 dark:text-emerald-300 bg-emerald-500/12",
    },
    deleted: {
      label: "deleted",
      cls: "text-rose-700 dark:text-rose-300 bg-rose-500/12",
    },
    renamed: { label: "renamed", cls: "text-foreground/70 bg-foreground/[0.06]" },
    modified: { label: "changed", cls: "text-foreground/70 bg-foreground/[0.06]" },
  };
  const { label, cls } = config[status];
  return (
    <span
      className={cn(
        "shrink-0 rounded-sm px-1 py-px text-[9px] font-medium uppercase tracking-wide",
        cls,
      )}
    >
      {label}
    </span>
  );
}

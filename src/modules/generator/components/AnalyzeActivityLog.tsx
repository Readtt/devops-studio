import { useEffect, useRef, useState } from "react";
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  AlertCircleIcon,
  FileEditIcon,
  Search01Icon,
  CodeIcon,
  AiBrain01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@/lib/utils";
import type { ActivityEntry } from "../lib/activityLog";

type Props = {
  entries: ActivityEntry[];
  className?: string;
};

/** Streaming log of what the analyst agent is doing — tool calls (Read/Glob/Grep
 *  with the file/pattern), thinking steps, and tool errors. Each tool entry
 *  collapses to a one-liner by default and expands to the full output for
 *  inspection. Auto-scrolls to the newest entry while the user hasn't manually
 *  scrolled away. */
export function AnalyzeActivityLog({ entries, className }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const pinnedToBottomRef = useRef(true);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (pinnedToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [entries]);

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinnedToBottomRef.current = distance < 24;
  };

  if (entries.length === 0) {
    return (
      <div
        className={cn(
          "flex items-center gap-2 rounded-md border border-dashed border-border/50 bg-card/20 px-3 py-2 font-mono text-[10.5px] text-muted-foreground/70",
          className,
        )}
      >
        <HugeiconsIcon icon={AiBrain01Icon} className="size-3.5" />
        <span className="text-muted-foreground/40">$</span>
        <span>waiting for the model to start…</span>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      onScroll={onScroll}
      className={cn(
        // Left-rail "log stream" framing: a single accent line down the
        // left edge anchors the activity timeline visually without adding
        // a heavier card border that competes with the page's own panel.
        "relative flex max-h-64 flex-col gap-px overflow-y-auto rounded-md border border-border/60 bg-card/40 p-1.5",
        className,
      )}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-1.5 left-3.5 w-px bg-border/50"
      />
      {entries.map((entry) => (
        <ActivityRow key={entry.id} entry={entry} />
      ))}
    </div>
  );
}

function ActivityRow({ entry }: { entry: ActivityEntry }) {
  const [open, setOpen] = useState(false);
  const hasExpandable =
    entry.outputFull !== undefined &&
    entry.outputFull.length > (entry.outputSummary?.length ?? 0);
  const isError = entry.kind === "error";
  const isThinking = entry.kind === "thinking";

  return (
    <div
      className={cn(
        "rounded px-2 py-1.5 transition-colors",
        isError
          ? "bg-destructive/8 text-destructive"
          : "hover:bg-muted/40",
      )}
    >
      <div className="flex items-start gap-1.5">
        <button
          type="button"
          onClick={() => hasExpandable && setOpen((o) => !o)}
          className={cn(
            "mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded text-muted-foreground/70",
            hasExpandable ? "hover:bg-muted/60 hover:text-foreground" : "opacity-30",
          )}
          aria-label={open ? "Collapse" : "Expand"}
          disabled={!hasExpandable}
        >
          <HugeiconsIcon
            icon={open ? ArrowDown01Icon : ArrowRight01Icon}
            className="size-3"
          />
        </button>

        <HugeiconsIcon
          icon={iconFor(entry)}
          className={cn(
            "mt-0.5 size-3.5 shrink-0",
            isError
              ? "text-destructive"
              : isThinking
                ? "text-muted-foreground/60"
                : "text-primary/80",
          )}
        />

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            <span
              className={cn(
                "font-mono text-[11px]",
                isThinking && "text-muted-foreground",
              )}
            >
              {entry.toolName ?? (isThinking ? "thinking" : "step")}
            </span>
            {entry.inputSummary ? (
              <span className="truncate font-mono text-[11px] text-muted-foreground">
                {entry.inputSummary}
              </span>
            ) : null}
          </div>

          {!open && entry.outputSummary ? (
            <p className="mt-0.5 truncate font-mono text-[10.5px] text-muted-foreground/80">
              {entry.outputSummary}
            </p>
          ) : null}

          {open && entry.outputFull ? (
            <pre className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap rounded border border-border/40 bg-muted/20 px-2 py-1 font-mono text-[10.5px] text-foreground/80">
              {entry.outputFull}
            </pre>
          ) : null}

          {entry.error && !open ? (
            <p className="mt-0.5 truncate font-mono text-[10.5px] text-destructive/90">
              {entry.error}
            </p>
          ) : null}
        </div>

        <div className="ml-2 shrink-0 font-mono text-[10px] text-muted-foreground/60 tabular-nums">
          {formatTimestamp(entry.ts)}
          {entry.durationMs !== undefined ? (
            <> · {formatDuration(entry.durationMs)}</>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function iconFor(entry: ActivityEntry) {
  if (entry.kind === "error") return AlertCircleIcon;
  if (entry.kind === "thinking") return AiBrain01Icon;
  const name = entry.toolName?.toLowerCase() ?? "";
  if (name === "read") return FileEditIcon;
  if (name === "grep") return Search01Icon;
  if (name === "glob") return CodeIcon;
  return CodeIcon;
}

function formatTimestamp(ms: number): string {
  const s = ms / 1000;
  if (s < 10) return `+${s.toFixed(1)}s`;
  if (s < 60) return `+${Math.round(s)}s`;
  return `+${Math.floor(s / 60)}m${Math.round(s % 60)
    .toString()
    .padStart(2, "0")}s`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

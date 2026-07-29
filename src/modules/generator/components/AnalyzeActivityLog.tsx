import { useEffect, useRef, useState } from "react";
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  AlertCircleIcon,
  ExternalLink,
  Loading03Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@/lib/utils";
import type { ActivityEntry } from "../lib/activityLog";

type Props = {
  entries: ActivityEntry[];
  className?: string;
  /** True while the run is actively in flight. Drives the live "working…"
   *  indicator (with an elapsed timer) so an analyze/refine that hasn't made a
   *  tool call yet reads as busy instead of frozen at "waiting…". */
  running?: boolean;
  /** Tighter vertical bound for embedded contexts (refine rounds history
   *  shows the log inside a scrollable dialog already). Defaults to `max-h-72`. */
  maxHeightClass?: string;
  /** When true, long tool call lines wrap to multiple lines instead of
   *  getting a per-cell horizontal scrollbar. Used inside the rounds
   *  history dialog where a) the dialog's own ScrollArea fights nested
   *  wheel events, and b) the user is reviewing past activity at a slower
   *  pace and readability beats terminal-strict layout. The live composer
   *  keeps the default (nowrap + scroll) since rows are appearing fast
   *  and a multi-line wrap would jitter the layout on every new step. */
  wrap?: boolean;
};

/** Streaming log of what the analyst agent is doing — modeled after a build
 *  log or LSP trace. Each row renders the tool call as a syntax-tinted
 *  function expression (Read("path/to/file.ts")) instead of generic
 *  icon+label rows. Read entries surface an "open" affordance that loads the
 *  file into the CodeViewer (via the existing devops-studio:open-code-viewer
 *  side-channel event). Auto-scrolls to newest entry while the user hasn't
 *  scrolled away. */
export function AnalyzeActivityLog({
  entries,
  className,
  running = false,
  maxHeightClass = "max-h-72",
  wrap = false,
}: Props) {
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
          "relative overflow-hidden rounded-md border border-border/60 bg-card/40",
          className,
        )}
      >
        <LogChrome running={running} />
        {running ? (
          <div className="flex items-center gap-2 px-3 py-3 text-[11.5px] text-muted-foreground">
            <span className="flex items-center gap-0.5" aria-hidden>
              <span className="inline-flex h-1.5 w-1.5 animate-[chat-thinking-pulse_1.2s_ease-in-out_infinite] rounded-full bg-primary" />
              <span className="inline-flex h-1.5 w-1.5 animate-[chat-thinking-pulse_1.2s_ease-in-out_infinite] rounded-full bg-primary [animation-delay:0.18s]" />
              <span className="inline-flex h-1.5 w-1.5 animate-[chat-thinking-pulse_1.2s_ease-in-out_infinite] rounded-full bg-primary [animation-delay:0.36s]" />
            </span>
            <span>Working — the model is reasoning about your draft</span>
            <Elapsed className="ml-auto" />
          </div>
        ) : (
          <div className="px-3 py-3 text-[11.5px] text-muted-foreground/70">
            No tool activity recorded.
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "relative w-full min-w-0 overflow-hidden rounded-md border border-border/60 bg-card/40 shadow-sm",
        className,
      )}
    >
      <LogChrome count={entries.length} running={running} />
      <div
        ref={containerRef}
        onScroll={onScroll}
        // Vertical-only scroll on the outer container — horizontal scroll
        // happens INSIDE each row's content cell so the row layout
        // (gutter, expand button, timestamp on the right) stays anchored.
        // The previous "whole-log scrolls horizontally" idea sounded nice
        // but broke the right-rail pinning AND silently failed inside the
        // dialog's nested min-w-0 chain.
        className={cn(
          "w-full min-w-0 overflow-y-auto",
          maxHeightClass,
        )}
      >
        <ol className="flex w-full min-w-0 flex-col">
          {entries.map((entry, i) => (
            <ActivityRow
              key={entry.id}
              entry={entry}
              index={i + 1}
              isLast={i === entries.length - 1}
              wrap={wrap}
            />
          ))}
        </ol>
      </div>
    </div>
  );
}

/** Clean header consistent with the app's other surfaces (no faux-terminal
 *  traffic lights): a small status glyph + label, with a step-count badge on
 *  the right. A spinner replaces the dot while the run is in flight. */
function LogChrome({ count, running }: { count?: number; running?: boolean }) {
  return (
    <div className="flex h-7 items-center gap-2 border-b border-border/40 bg-foreground/[0.02] px-3">
      {running ? (
        <HugeiconsIcon
          icon={Loading03Icon}
          size={11}
          strokeWidth={2}
          className="shrink-0 animate-spin text-muted-foreground/70"
        />
      ) : (
        <span className="size-1.5 shrink-0 rounded-full bg-emerald-500/70" />
      )}
      <span className="text-[11px] font-medium tracking-tight text-foreground/80">
        Analyst activity
      </span>
      {count !== undefined ? (
        // "actions", not "steps": each row is one tool call / thought, and one
        // budgeted agentic STEP (the "step 4/26" readout) usually spans several
        // of them — calling both "steps" made the two counters look wrong.
        <span className="ml-auto rounded-sm bg-foreground/[0.06] px-1.5 py-px font-mono text-[9.5px] tabular-nums text-muted-foreground/85">
          {count} action{count === 1 ? "" : "s"}
        </span>
      ) : null}
    </div>
  );
}

/** Self-ticking elapsed-time readout (+3s …) so a running step that hasn't
 *  produced a tool call yet still visibly advances. */
function Elapsed({ className }: { className?: string }) {
  const [startedAt] = useState(() => Date.now());
  const [, force] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => force((n) => n + 1), 500);
    return () => window.clearInterval(t);
  }, []);
  const secs = Math.max(0, (Date.now() - startedAt) / 1000);
  const label = secs < 60 ? `${Math.round(secs)}s` : `${Math.floor(secs / 60)}m${Math.round(secs % 60).toString().padStart(2, "0")}s`;
  return (
    <span className={cn("shrink-0 tabular-nums text-[10.5px] text-muted-foreground/55", className)}>
      {label}
    </span>
  );
}

function ActivityRow({
  entry,
  index,
  isLast,
  wrap,
}: {
  entry: ActivityEntry;
  index: number;
  isLast: boolean;
  wrap: boolean;
}) {
  const [open, setOpen] = useState(false);
  const hasExpandable =
    entry.outputFull !== undefined &&
    entry.outputFull.length > (entry.outputSummary?.length ?? 0);
  const isError = entry.kind === "error";
  const isThinking = entry.kind === "thinking";
  const isPending = entry.durationMs === undefined && !isThinking && !isError;
  const fileTarget = readFileTarget(entry);

  return (
    <li
      className={cn(
        "group relative w-full min-w-0 border-l-2 px-3 py-1 font-mono text-[11px] transition-colors",
        isError
          ? "border-l-destructive/70 bg-destructive/[0.05]"
          : isThinking
            ? "border-l-transparent hover:bg-foreground/[0.025]"
            : isLast && isPending
              ? "border-l-primary/80 bg-primary/[0.04]"
              : "border-l-border/40 hover:bg-foreground/[0.025]",
      )}
    >
      <div className="flex w-full min-w-0 items-baseline gap-2">
        {/* Line-number gutter, like a code editor. Mono and tabular-nums so
            it stays aligned regardless of step count. */}
        <span className="w-7 shrink-0 select-none text-right text-[10px] tabular-nums text-muted-foreground/45">
          {index.toString().padStart(2, "0")}
        </span>

        {/* Expand chevron OR a status glyph, sharing the same column. */}
        <button
          type="button"
          onClick={() => hasExpandable && setOpen((o) => !o)}
          disabled={!hasExpandable}
          aria-label={open ? "Collapse" : "Expand"}
          className={cn(
            "inline-flex size-3.5 shrink-0 items-center justify-center rounded-sm text-[10px] transition-colors",
            isError
              ? "text-destructive/80"
              : isThinking
                ? "text-muted-foreground/45"
                : "text-muted-foreground/60",
            hasExpandable && "hover:bg-foreground/[0.06] hover:text-foreground",
            !hasExpandable && "cursor-default",
          )}
        >
          {hasExpandable ? (
            <HugeiconsIcon
              icon={open ? ArrowDown01Icon : ArrowRight01Icon}
              className="size-3"
            />
          ) : isError ? (
            <HugeiconsIcon icon={AlertCircleIcon} className="size-3" />
          ) : (
            <span aria-hidden>{statusGlyph(entry, isPending)}</span>
          )}
        </button>

        {/* Content cell — flex-1 fills the available width between gutter
            and right rail. In SCROLL mode (live composer) the cell gets a
            slim horizontal scrollbar via the activity-cell global rules
            and content stays single-line. In WRAP mode (rounds history
            dialog) the cell grows vertically and content wraps; this
            mode wins inside dialogs because shadcn's ScrollArea fights
            nested horizontal wheel events. */}
        <div
          className={cn(
            "min-w-0 flex-1",
            wrap ? "" : "activity-cell overflow-x-auto",
          )}
        >
          {isThinking ? (
            <p
              className={cn(
                "italic leading-snug text-muted-foreground/85",
                wrap ? "break-words" : "whitespace-nowrap",
              )}
            >
              <span className="mr-1.5 text-muted-foreground/40">∴</span>
              {entry.inputSummary || "thinking…"}
            </p>
          ) : (
            <ToolCallLine entry={entry} fileTarget={fileTarget} wrap={wrap} />
          )}

          {!open && entry.outputSummary ? (
            <p
              className={cn(
                "mt-0.5 text-[10.5px] text-muted-foreground/70",
                wrap ? "break-words" : "whitespace-nowrap",
              )}
            >
              <span className="mr-1 text-muted-foreground/40">↳</span>
              {entry.outputSummary}
            </p>
          ) : null}

          {open && entry.outputFull ? (
            <pre
              className={cn(
                "mt-1 max-h-56 rounded-sm border border-border/40 bg-foreground/[0.04] px-2 py-1.5 text-[10.5px] leading-relaxed text-foreground/85",
                // Output blobs stay scrollable either way — they're
                // formatted code, not prose, and forcing them to wrap
                // produces unreadable salad. In wrap mode the outer cell
                // is wide enough that this pre simply uses its own
                // scrollbar without competing with anything.
                "overflow-auto whitespace-pre",
              )}
            >
              {entry.outputFull}
            </pre>
          ) : null}

          {entry.error && !open ? (
            <p
              className={cn(
                "mt-0.5 text-[10.5px] text-destructive/85",
                wrap ? "break-words" : "whitespace-nowrap",
              )}
            >
              <span className="mr-1 text-destructive/55">✗</span>
              {entry.error}
            </p>
          ) : null}
        </div>

        {/* Right rail: timestamp + (hover) open-in-app for Read entries. */}
        <div className="flex shrink-0 items-baseline gap-1.5">
          {fileTarget ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                openInCodeViewer(fileTarget);
              }}
              className={cn(
                "inline-flex h-5 items-center gap-1 rounded-sm border border-transparent px-1.5 text-[10px] text-muted-foreground transition-colors",
                "opacity-0 group-hover:opacity-100 focus:opacity-100",
                "hover:border-primary/40 hover:bg-primary/[0.08] hover:text-primary",
              )}
              title={`Open ${fileTarget.path} in the code viewer`}
            >
              <HugeiconsIcon icon={ExternalLink} size={9} strokeWidth={1.75} />
              open
            </button>
          ) : null}
          <span className="text-[10px] tabular-nums text-muted-foreground/55">
            {formatTimestamp(entry.ts)}
          </span>
          {entry.durationMs !== undefined ? (
            <span className="text-[10px] tabular-nums text-muted-foreground/40">
              {formatDuration(entry.durationMs)}
            </span>
          ) : null}
        </div>
      </div>
    </li>
  );
}

/** Render the tool call as a one-line "function expression". Read/Glob/Grep
 *  get specialized formatting so paths and patterns are visually distinct
 *  from the tool token. Everything else falls back to `name(arg)`. */
function ToolCallLine({
  entry,
  fileTarget,
  wrap,
}: {
  entry: ActivityEntry;
  fileTarget: FileTarget | null;
  wrap: boolean;
}) {
  const toolName = entry.toolName ?? "step";
  const lower = toolName.toLowerCase();
  const arg = entry.inputSummary ?? "";
  // In wrap mode every paragraph also gets break-all so a long single
  // token (file path, regex) doesn't push the row past the dialog edge.
  const lineCls = wrap ? "leading-snug break-all" : "leading-snug whitespace-nowrap";

  // Read("path") — make the path itself clickable when we have a target.
  if (fileTarget) {
    return (
      <p className={lineCls}>
        <span className="font-semibold text-primary">{toolName}</span>
        <span className="text-muted-foreground/60">(</span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            openInCodeViewer(fileTarget);
          }}
          className="text-left text-amber-700 underline-offset-2 hover:underline dark:text-amber-300"
          title="Open in code viewer"
        >
          <span className="text-muted-foreground/55">&quot;</span>
          {fileTarget.path}
          {fileTarget.startLine ? (
            <span className="text-emerald-700 dark:text-emerald-300">
              :{fileTarget.startLine}
              {fileTarget.endLine && fileTarget.endLine !== fileTarget.startLine
                ? `-${fileTarget.endLine}`
                : ""}
            </span>
          ) : null}
          <span className="text-muted-foreground/55">&quot;</span>
        </button>
        <span className="text-muted-foreground/60">)</span>
      </p>
    );
  }

  // Grep("pattern", path/) — pattern is the string, path is a hint.
  if (lower === "grep") {
    const { pattern, scope } = splitGrepArg(arg);
    return (
      <p className={lineCls}>
        <span className="font-semibold text-primary">{toolName}</span>
        <span className="text-muted-foreground/60">(</span>
        <span className="text-amber-700 dark:text-amber-300">
          <span className="text-muted-foreground/55">/</span>
          {pattern}
          <span className="text-muted-foreground/55">/</span>
        </span>
        {scope ? (
          <>
            <span className="text-muted-foreground/55">, </span>
            <span className="text-foreground/75">{scope}</span>
          </>
        ) : null}
        <span className="text-muted-foreground/60">)</span>
      </p>
    );
  }

  // Glob("pattern") — pattern reads as a glob token.
  if (lower === "glob") {
    return (
      <p className={lineCls}>
        <span className="font-semibold text-primary">{toolName}</span>
        <span className="text-muted-foreground/60">(</span>
        <span className="text-violet-700 dark:text-violet-300">
          <span className="text-muted-foreground/55">&quot;</span>
          {arg}
          <span className="text-muted-foreground/55">&quot;</span>
        </span>
        <span className="text-muted-foreground/60">)</span>
      </p>
    );
  }

  // Generic fallback — tool(arg-as-string).
  return (
    <p className="leading-snug">
      <span className="font-semibold text-primary">{toolName}</span>
      {arg ? (
        <>
          <span className="text-muted-foreground/60">(</span>
          <span className="text-foreground/80">{arg}</span>
          <span className="text-muted-foreground/60">)</span>
        </>
      ) : null}
    </p>
  );
}

type FileTarget = {
  path: string;
  startLine?: number;
  endLine?: number;
};

/** Extract a file target from a Read activity entry. Read inputs come through
 *  as just the file path (see `summarizeToolInput`); we also handle the rare
 *  `path:start-end` shorthand the model sometimes emits. */
function readFileTarget(entry: ActivityEntry): FileTarget | null {
  if (entry.toolName?.toLowerCase() !== "read") return null;
  const raw = entry.inputSummary?.trim();
  if (!raw) return null;

  // `path:start-end` → split off the range. Be defensive about Windows
  // drive letters (`C:\…`) where the first colon is part of the path.
  const m = raw.match(/^(.+?):(\d+)(?:[-–](\d+))?$/);
  if (m && !raw.match(/^[a-zA-Z]:[\\/]/)) {
    return {
      path: m[1],
      startLine: Number(m[2]),
      endLine: m[3] ? Number(m[3]) : undefined,
    };
  }
  return { path: raw };
}

/** Grep input summaries come through as `pattern (scope)` or `pattern (in
 *  scope)` from `summarizeToolInput`. Split the two so they can be rendered
 *  in different colors. */
function splitGrepArg(arg: string): { pattern: string; scope: string | null } {
  const m = arg.match(/^(.+?)\s+\((?:in\s+)?(.+?)\)\s*$/);
  if (m) return { pattern: m[1], scope: m[2] };
  return { pattern: arg, scope: null };
}

function openInCodeViewer(target: FileTarget): void {
  window.dispatchEvent(
    new CustomEvent("devops-studio:open-code-viewer", {
      detail: {
        path: target.path,
        startLine: target.startLine,
        endLine: target.endLine,
      },
    }),
  );
}

function statusGlyph(entry: ActivityEntry, isPending: boolean): string {
  if (entry.kind === "error") return "✗";
  if (isPending) return "▸";
  return "✓";
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

import { useState } from "react";
import { cn } from "@/lib/utils";
import type { ActivityEntry } from "@/modules/generator/lib/activityLog";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  AlertCircleIcon,
  ArrowRight01Icon,
  CodeIcon,
  FileEditIcon,
  Loading03Icon,
  Search01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";

/**
 * Compact, expandable strip of the tool calls an assistant turn made
 * (Read / Glob / Grep / …). Renders above the message text so the chat no
 * longer goes silent while the model works — a running tool shows a spinner,
 * a finished one a check. Click a row to expand its input + a result preview.
 *
 * The whole group is collapsed by default to a one-line summary ("N tool
 * calls") so a turn with a dozen reads doesn't bury the answer under a wall of
 * rows. It auto-expands while the turn streams so live progress stays visible,
 * then tucks itself back into the summary once the work is done.
 *
 * Fed by ActivityEntry[] persisted on the message (so the strip survives a
 * reload, where everything reads as completed history). We only surface
 * `tool` / `error` entries — `thinking` breadcrumbs are noise here.
 *
 * Shared across Suite Chat, Code Review, and the generator Ask panel so tool
 * activity looks identical everywhere.
 */
export function ToolCallStrip({
  events,
  streaming,
}: {
  events: ActivityEntry[] | undefined;
  /** This message is still streaming — lets a tool with no result yet show a
   *  live spinner instead of a (wrong) completed check. */
  streaming?: boolean;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [groupOpen, setGroupOpen] = useState(false);
  const rows = (events ?? []).filter(
    (e) => e.kind === "tool" || e.kind === "error",
  );
  if (rows.length === 0) return null;

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const errorCount = rows.filter((e) => e.kind === "error").length;
  const totalMs = rows.reduce((sum, e) => sum + (e.durationMs ?? 0), 0);
  // Show the rows while the user has expanded the group OR the turn is still
  // streaming — never hide work in progress behind a collapsed summary.
  const showRows = groupOpen || !!streaming;

  return (
    <div className="mb-2 overflow-hidden rounded-lg border border-border/45 bg-foreground/[0.02]">
      <button
        type="button"
        onClick={() => setGroupOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[10.5px] transition-colors hover:bg-foreground/[0.03]"
      >
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          size={11}
          strokeWidth={2}
          className={cn(
            "shrink-0 text-muted-foreground/60 transition-transform",
            showRows && "rotate-90",
          )}
        />
        <span className="shrink-0 font-medium text-foreground/80">
          {rows.length} tool {rows.length === 1 ? "call" : "calls"}
        </span>
        {errorCount > 0 ? (
          <span className="shrink-0 font-medium text-rose-600 dark:text-rose-400">
            · {errorCount} failed
          </span>
        ) : null}
        <span className="min-w-0 flex-1" />
        {streaming ? (
          <HugeiconsIcon
            icon={Loading03Icon}
            size={11}
            strokeWidth={2}
            className="shrink-0 animate-spin text-muted-foreground/70"
          />
        ) : totalMs > 0 ? (
          <span className="shrink-0 tabular-nums text-muted-foreground/55">
            {formatDuration(totalMs)}
          </span>
        ) : null}
      </button>
      {showRows ? (
      <div className="border-t border-border/30">
      {rows.map((e, i) => {
        const isError = e.kind === "error";
        // A tool with no recorded result yet is still running — but only while
        // the message streams; a reloaded thread should never spin forever.
        const running = !isError && e.durationMs == null && !!streaming;
        const open = expanded.has(e.id);
        const hasDetail = !!(e.inputSummary || e.outputSummary || e.error);
        return (
          <div
            key={e.id}
            className={cn(
              "text-[10.5px]",
              i > 0 && "border-t border-border/30",
            )}
          >
            <button
              type="button"
              disabled={!hasDetail}
              onClick={() => hasDetail && toggle(e.id)}
              className={cn(
                "flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors",
                hasDetail && "hover:bg-foreground/[0.03]",
              )}
            >
              <ToolGlyph name={e.toolName} error={isError} />
              <span
                className={cn(
                  "shrink-0 font-medium",
                  isError ? "text-rose-600 dark:text-rose-400" : "text-foreground/80",
                )}
              >
                {e.toolName ?? (isError ? "error" : "tool")}
              </span>
              {e.inputSummary ? (
                <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground/85">
                  {e.inputSummary}
                </span>
              ) : (
                <span className="min-w-0 flex-1" />
              )}
              {running ? (
                <HugeiconsIcon
                  icon={Loading03Icon}
                  size={11}
                  strokeWidth={2}
                  className="shrink-0 animate-spin text-muted-foreground/70"
                />
              ) : isError ? (
                <HugeiconsIcon
                  icon={AlertCircleIcon}
                  size={11}
                  strokeWidth={2}
                  className="shrink-0 text-rose-500/80"
                />
              ) : (
                <span className="flex shrink-0 items-center gap-1.5">
                  {e.durationMs != null ? (
                    <span className="tabular-nums text-muted-foreground/55">
                      {formatDuration(e.durationMs)}
                    </span>
                  ) : null}
                  <HugeiconsIcon
                    icon={Tick02Icon}
                    size={11}
                    strokeWidth={2}
                    className="text-emerald-600/80 dark:text-emerald-400/80"
                  />
                </span>
              )}
            </button>
            {open && hasDetail ? (
              <div className="border-t border-border/30 bg-foreground/[0.015] px-2.5 py-1.5">
                {e.error ? (
                  <pre className="whitespace-pre-wrap break-words font-mono text-[10px] leading-snug text-rose-600/90 dark:text-rose-400/90">
                    {e.error}
                  </pre>
                ) : null}
                {e.outputSummary ? (
                  <pre className="mt-0.5 max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-snug text-muted-foreground/85">
                    {e.outputFull || e.outputSummary}
                  </pre>
                ) : !e.error ? (
                  <p className="font-mono text-[10px] italic text-muted-foreground/55">
                    (no output captured)
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
      </div>
      ) : null}
    </div>
  );
}

function ToolGlyph({ name, error }: { name?: string; error?: boolean }) {
  const icon = error
    ? AlertCircleIcon
    : iconForTool(name);
  return (
    <HugeiconsIcon
      icon={icon}
      size={11}
      strokeWidth={1.75}
      className="shrink-0 text-muted-foreground/70"
    />
  );
}

function iconForTool(name?: string) {
  switch ((name ?? "").toLowerCase()) {
    case "grep":
      return Search01Icon;
    case "read":
    case "read_file":
    case "glob":
    case "list_files":
      return FileEditIcon;
    default:
      return CodeIcon;
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

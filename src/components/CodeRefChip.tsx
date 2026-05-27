import { Fragment } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { CodeIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { fmtRange, parseCodeRef, shortenPath, type CodeRange } from "./codeRef";

// Re-exported so existing call sites keep importing the parser from here.
export { parseCodeRef };
export type { CodeRange };

/**
 * One clickable code reference, rendered as a compact pill. Handles
 * multi-range refs ("src/foo.cs:376,594-600,1080") — the path shows once and
 * each line range is its own clickable segment that jumps the in-app viewer to
 * that range. The path truncates at small widths; the ranges stay put, so the
 * pill never overflows or dangles trailing line numbers as plain text.
 *
 * Used by chat citations (code review / suite chat / ask) and the confidence
 * panel. Always opens the viewer in the focused leaf (a normal tab).
 */
export function CodeRefChip({
  path,
  ranges,
  className,
}: {
  path: string;
  ranges: CodeRange[];
  className?: string;
}) {
  const open = (r?: CodeRange) => {
    window.dispatchEvent(
      new CustomEvent("devops-studio:open-code-viewer", {
        detail: {
          path,
          startLine: r?.start,
          endLine: r?.end,
        },
      }),
    );
  };
  const short = shortenPath(path);
  const full = `${path}${ranges.length ? `:${ranges.map(fmtRange).join(", ")}` : ""}`;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-flex max-w-full items-center gap-1 rounded-sm border border-border/55 bg-foreground/[0.05] px-1.5 py-px align-baseline font-mono text-[10.5px] text-foreground/85",
            className,
          )}
        >
          <HugeiconsIcon
            icon={CodeIcon}
            size={9}
            strokeWidth={1.75}
            className="shrink-0 text-muted-foreground"
          />
          <button
            type="button"
            onClick={() => open(ranges[0])}
            className="min-w-0 truncate transition-colors hover:text-primary"
            title={full}
          >
            {short}
          </button>
          {ranges.length > 0 ? (
            <span className="flex shrink-0 items-center">
              <span className="text-muted-foreground/60">:</span>
              {ranges.map((r, i) => (
                <Fragment key={i}>
                  {i > 0 ? (
                    <span className="text-muted-foreground/40">,</span>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => open(r)}
                    className="px-0.5 tabular-nums transition-colors hover:text-primary"
                  >
                    {fmtRange(r)}
                  </button>
                </Fragment>
              ))}
            </span>
          ) : null}
        </span>
      </TooltipTrigger>
      <TooltipContent
        variant="panel"
        side="top"
        className="max-w-[340px] px-3 py-2 text-[11px] leading-relaxed"
      >
        <div className="break-all font-mono text-[10.5px] text-foreground/90">
          {full}
        </div>
        <div className="mt-1 text-[10px] text-muted-foreground/80">
          {ranges.length > 1
            ? "Click a line number to jump to that range."
            : "Open in the in-app code viewer."}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

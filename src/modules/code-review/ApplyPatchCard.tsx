import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  Cancel01Icon,
  CheckmarkCircle02Icon,
  FileEditIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";

/**
 * Inline "Apply this patch" card rendered by ChatMarkdown when the
 * reviewer emits a `code-review-patch` fenced JSON block.
 *
 * UX:
 *   - Header: path + line range badge.
 *   - Body: monospace preview of the replacement.
 *   - Apply button: read current file, splice the line range with the
 *     replacement, write atomically. The card switches to a quiet
 *     "Applied" state on success.
 *   - "Open in code viewer" button: jump to the file at startLine so
 *     the user can sanity-check before pressing Apply.
 *
 * Failure modes surface as a single line under the button — usually
 * "file not found" or "range out of bounds" when the diff has moved
 * since the review was generated.
 */

type PatchBody = {
  path: string;
  startLine: number;
  endLine: number;
  replacement: string;
};

type ReadResult =
  | { kind: "text"; content: string; size: number }
  | { kind: "binary"; size: number }
  | { kind: "toolarge"; size: number; limit: number };

type ApplyState =
  | { kind: "idle" }
  | { kind: "applying" }
  | { kind: "applied"; at: string }
  | { kind: "error"; message: string };

export function ApplyPatchCard({ body }: { body: string }) {
  const sourceRoot = usePreferencesStore((s) => s.sourceRoot);
  const [state, setState] = useState<ApplyState>({ kind: "idle" });

  const parsed = parsePatch(body);
  if (!parsed.ok) {
    return (
      <div className="my-2 rounded-md border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">
        Couldn't parse this patch block: {parsed.error}
      </div>
    );
  }
  const patch = parsed.value;
  const previewLines = patch.replacement.split("\n");
  const previewCapped = previewLines.length > 12;
  const visibleLines = previewCapped ? previewLines.slice(0, 12) : previewLines;
  const replacedRangeText =
    patch.endLine < patch.startLine
      ? `insert before line ${patch.startLine}`
      : patch.startLine === patch.endLine
        ? `replace line ${patch.startLine}`
        : `replace lines ${patch.startLine}–${patch.endLine}`;

  const onApply = async () => {
    if (!sourceRoot) {
      setState({
        kind: "error",
        message: "Set a source directory in Settings first.",
      });
      return;
    }
    setState({ kind: "applying" });
    try {
      const absPath = resolveAgainstRoot(patch.path, sourceRoot);
      const raw = await invoke<ReadResult>("fs_read_file", { path: absPath });
      if (raw.kind !== "text") {
        throw new Error(
          raw.kind === "binary" ? "file is binary" : "file is too large",
        );
      }
      const next = spliceLines(
        raw.content,
        patch.startLine,
        patch.endLine,
        patch.replacement,
      );
      await invoke("fs_write_file", {
        path: absPath,
        content: next,
        source: "code-review-apply",
      });
      setState({ kind: "applied", at: new Date().toISOString() });
    } catch (e) {
      setState({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const openInViewer = () => {
    window.dispatchEvent(
      new CustomEvent("devops-studio:open-code-viewer", {
        detail: {
          path: patch.path,
          startLine: patch.startLine,
          endLine: Math.max(patch.startLine, patch.endLine),
        },
      }),
    );
  };

  const isApplied = state.kind === "applied";

  return (
    <div
      className={cn(
        "my-2 overflow-hidden rounded-md border",
        isApplied
          ? "border-emerald-500/40 bg-emerald-500/[0.05]"
          : "border-border/60 bg-card/55",
      )}
    >
      <div className="flex items-center gap-2 border-b border-border/40 px-3 py-1.5">
        <HugeiconsIcon
          icon={isApplied ? CheckmarkCircle02Icon : FileEditIcon}
          size={12}
          strokeWidth={1.75}
          className={
            isApplied
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-muted-foreground"
          }
        />
        <button
          type="button"
          onClick={openInViewer}
          className="min-w-0 truncate text-left font-mono text-[11px] text-foreground/85 hover:text-foreground hover:underline"
          title="Open in code viewer"
        >
          {patch.path}
        </button>
        <span className="rounded-sm bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
          {replacedRangeText}
        </span>
        {isApplied ? (
          <span className="ml-auto inline-flex items-center gap-1 rounded-sm bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
            <HugeiconsIcon icon={Tick02Icon} size={9} strokeWidth={2} />
            Applied
          </span>
        ) : null}
      </div>
      <pre className="overflow-x-auto bg-foreground/[0.02] px-3 py-2 font-mono text-[11px] leading-relaxed">
        {visibleLines.map((line, i) => (
          <span key={i} className="block">
            <span className="mr-3 inline-block w-6 text-right text-muted-foreground/40 select-none">
              {(patch.startLine + i).toString()}
            </span>
            <span className="text-emerald-700 dark:text-emerald-300">
              {line || " "}
            </span>
          </span>
        ))}
        {previewCapped ? (
          <span className="block px-3 pt-1 text-[10.5px] text-muted-foreground/70">
            … {previewLines.length - 12} more lines hidden
          </span>
        ) : null}
      </pre>
      <div className="flex items-center justify-between gap-2 border-t border-border/40 px-3 py-1.5">
        <div className="text-[10.5px] text-muted-foreground">
          {state.kind === "error" ? (
            <span className="inline-flex items-center gap-1 text-rose-600 dark:text-rose-400">
              <HugeiconsIcon icon={Cancel01Icon} size={10} strokeWidth={2} />
              {state.message}
            </span>
          ) : state.kind === "applied" ? (
            <span>
              Wrote to disk at {new Date(state.at).toLocaleTimeString()}.
              You can re-run the diff or refresh the review.
            </span>
          ) : (
            <span>
              Review the preview above. Apply writes atomically; original
              file is replaced in one shot.
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="xs"
                variant="ghost"
                onClick={openInViewer}
                className="h-6 px-2 text-[10.5px]"
              >
                Open file
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-[11px]">
              Jump to the file at line {patch.startLine} — sanity-check the
              context before applying.
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="xs"
                variant={isApplied ? "outline" : "default"}
                disabled={state.kind === "applying" || isApplied}
                onClick={() => void onApply()}
                className="h-6 px-2 text-[10.5px]"
              >
                {state.kind === "applying"
                  ? "Applying…"
                  : isApplied
                    ? "Re-apply"
                    : "Apply"}
              </Button>
            </TooltipTrigger>
            <TooltipContent
              side="top"
              className="max-w-[280px] text-[11px] leading-relaxed"
            >
              {isApplied
                ? "Already applied. Click again to overwrite with the same patch (no-op if the file hasn't changed since)."
                : "Read the file, splice in this patch, write it back. No undo — review the preview first."}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}

function parsePatch(body: string):
  | { ok: true; value: PatchBody }
  | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(body) as Partial<PatchBody>;
    if (typeof parsed.path !== "string" || !parsed.path.trim()) {
      return { ok: false, error: "missing or empty 'path'" };
    }
    if (typeof parsed.startLine !== "number" || parsed.startLine < 1) {
      return { ok: false, error: "'startLine' must be a positive integer" };
    }
    if (typeof parsed.endLine !== "number") {
      return { ok: false, error: "'endLine' must be a number" };
    }
    if (typeof parsed.replacement !== "string") {
      return { ok: false, error: "'replacement' must be a string" };
    }
    return {
      ok: true,
      value: {
        path: parsed.path,
        startLine: parsed.startLine,
        endLine: parsed.endLine,
        replacement: parsed.replacement,
      },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Splice lines [startLine, endLine] (1-indexed, inclusive) with the
 *  replacement text. For pure-insert patches, the caller passes
 *  endLine < startLine so the slice is empty. Newlines are preserved. */
function spliceLines(
  source: string,
  startLine: number,
  endLine: number,
  replacement: string,
): string {
  const lines = source.split("\n");
  const startIdx = Math.max(0, startLine - 1);
  const endIdx = endLine < startLine ? startIdx : Math.min(lines.length, endLine);
  const before = lines.slice(0, startIdx).join("\n");
  const after = lines.slice(endIdx).join("\n");
  const middle = replacement;
  const parts: string[] = [];
  if (before) parts.push(before);
  parts.push(middle);
  if (after) parts.push(after);
  return parts.join("\n");
}

/** Same resolution rule the suite-chat fs tools use: absolute paths
 *  pass through; relative paths join against the source root using the
 *  platform's native separator. */
function resolveAgainstRoot(path: string, root: string): string {
  const trimmed = path.trim();
  if (/^([a-zA-Z]:[\\/]|[\\/])/.test(trimmed)) return trimmed;
  const sep = root.includes("\\") ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${sep}${trimmed.replace(/^[\\/]+/, "")}`;
}

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { TextDiff } from "@/components/diff/textDiff";
import type { AppliedPatchRecord } from "@/components/ChatMarkdown";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  Cancel01Icon,
  CheckmarkCircle02Icon,
  FileEditIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

/**
 * Inline "Apply this patch" card rendered by ChatMarkdown when the
 * reviewer emits a `code-review-patch` fenced JSON block.
 *
 * UX:
 *   - Header: path + line range badge.
 *   - Body: a real before/after diff (TextDiff, monospace) — the current
 *     file lines on the left, the proposed replacement on the right. Falls
 *     back to a replacement-only preview when the file can't be read.
 *   - Apply button: read current file, splice the line range with the
 *     replacement, write atomically. The applied state + the original
 *     "before" snapshot are reported up so the parent can persist them; the
 *     card then shows "Applied" and keeps the diff even after a reload.
 *   - "Open in code viewer" button: jump to the file at startLine so the
 *     user can sanity-check before pressing Apply.
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
  | { kind: "error"; message: string };

export function ApplyPatchCard({
  body,
  applied,
  onApplied,
}: {
  body: string;
  /** Persisted applied-state for this block (from the message). When set, the
   *  card shows the "Applied" state + a diff against the snapshotted original
   *  even after a reload. */
  applied?: AppliedPatchRecord | null;
  /** Called after a successful apply so the parent persists the record. */
  onApplied?: (record: AppliedPatchRecord) => void;
}) {
  const sourceRoot = usePreferencesStore((s) => s.sourceRoot);
  const [state, setState] = useState<ApplyState>({ kind: "idle" });
  // Local copy so the card reflects the apply instantly even if the parent
  // hasn't re-supplied `applied` yet (it does, on persist — this just avoids a
  // flash). Parent-supplied `applied` always wins on reload.
  const [localApplied, setLocalApplied] = useState<AppliedPatchRecord | null>(
    null,
  );
  // The current file's lines [startLine,endLine], read live so an un-applied
  // patch shows a real before/after. Null while loading; "" is a valid value
  // (insert patches have no "before").
  const [liveBefore, setLiveBefore] = useState<string | null>(null);
  const [beforeError, setBeforeError] = useState<string | null>(null);

  const parsed = parsePatch(body);
  const effectiveApplied = applied ?? localApplied;

  // Read the current file once per patch identity so the diff has a "before".
  // Skipped when already applied (the snapshot is authoritative and the file
  // on disk now holds the replacement anyway).
  const okPath = parsed.ok ? parsed.value.path : null;
  const okStart = parsed.ok ? parsed.value.startLine : 0;
  const okEnd = parsed.ok ? parsed.value.endLine : 0;
  useEffect(() => {
    if (!okPath || !sourceRoot || effectiveApplied) return;
    let cancelled = false;
    void (async () => {
      try {
        const absPath = resolveAgainstRoot(okPath, sourceRoot);
        const raw = await invoke<ReadResult>("fs_read_file", { path: absPath });
        if (cancelled) return;
        if (raw.kind !== "text") {
          setBeforeError(
            raw.kind === "binary" ? "file is binary" : "file is too large",
          );
          return;
        }
        setLiveBefore(sliceLinesText(raw.content, okStart, okEnd));
        setBeforeError(null);
      } catch (e) {
        if (!cancelled) {
          setBeforeError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [okPath, okStart, okEnd, sourceRoot, effectiveApplied]);

  if (!parsed.ok) {
    return (
      <div className="my-2 rounded-md border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">
        Couldn't parse this patch block: {parsed.error}
      </div>
    );
  }
  const patch = parsed.value;
  const replacedRangeText =
    patch.endLine < patch.startLine
      ? `insert before line ${patch.startLine}`
      : patch.startLine === patch.endLine
        ? `replace line ${patch.startLine}`
        : `replace lines ${patch.startLine}–${patch.endLine}`;

  // What the diff compares against: the snapshot for an applied patch, else
  // the live file read. Null => still loading or unreadable, so we fall back to
  // a replacement-only preview that still shows the proposed code.
  const beforeText = effectiveApplied ? effectiveApplied.beforeText : liveBefore;
  const hasDiff = beforeText !== null;

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
      // Preserve the ORIGINAL snapshot across re-applies so the historical
      // before/after never collapses to an empty diff.
      const snapshot =
        effectiveApplied?.beforeText ??
        sliceLinesText(raw.content, patch.startLine, patch.endLine);
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
      const record: AppliedPatchRecord = {
        appliedAt: new Date().toISOString(),
        path: patch.path,
        startLine: patch.startLine,
        endLine: patch.endLine,
        beforeText: snapshot,
      };
      setLocalApplied(record);
      onApplied?.(record);
      setState({ kind: "idle" });
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

  const isApplied = !!effectiveApplied;

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
      {hasDiff ? (
        <div className="max-h-[320px] overflow-y-auto bg-foreground/[0.02] py-1">
          <TextDiff before={beforeText} after={patch.replacement} mono />
        </div>
      ) : (
        <ReplacementPreview
          replacement={patch.replacement}
          startLine={patch.startLine}
        />
      )}
      <div className="flex items-center justify-between gap-2 border-t border-border/40 px-3 py-1.5">
        <div className="text-[10.5px] text-muted-foreground">
          {state.kind === "error" ? (
            <span className="inline-flex items-center gap-1 text-rose-600 dark:text-rose-400">
              <HugeiconsIcon icon={Cancel01Icon} size={10} strokeWidth={2} />
              {state.message}
            </span>
          ) : isApplied ? (
            <span>
              Wrote to disk at{" "}
              {new Date(effectiveApplied.appliedAt).toLocaleTimeString()}.
              Showing the diff against the original.
            </span>
          ) : beforeError ? (
            <span>
              Couldn't read the current file ({beforeError}) — showing the
              proposed replacement only.
            </span>
          ) : (
            <span>
              Review the diff above. Apply writes atomically; the file is
              replaced in one shot.
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
                disabled={state.kind === "applying"}
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
                : "Read the file, splice in this patch, write it back. No undo — review the diff first."}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}

/** Fallback body when the current file can't be read (loading, moved, binary):
 *  show the proposed replacement with line numbers, all-added green. */
function ReplacementPreview({
  replacement,
  startLine,
}: {
  replacement: string;
  startLine: number;
}) {
  const lines = replacement.split("\n");
  const capped = lines.length > 12;
  const visible = capped ? lines.slice(0, 12) : lines;
  return (
    <pre className="overflow-x-auto bg-foreground/[0.02] px-3 py-2 font-mono text-[11px] leading-relaxed">
      {visible.map((line, i) => (
        <span key={i} className="block">
          <span className="mr-3 inline-block w-6 select-none text-right text-muted-foreground/40">
            {(startLine + i).toString()}
          </span>
          <span className="text-emerald-700 dark:text-emerald-300">
            {line || " "}
          </span>
        </span>
      ))}
      {capped ? (
        <span className="block px-3 pt-1 text-[10.5px] text-muted-foreground/70">
          … {lines.length - 12} more lines hidden
        </span>
      ) : null}
    </pre>
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

/** The file's lines [startLine, endLine] (1-indexed, inclusive) as text — the
 *  "before" side of the diff. For an insert (endLine < startLine) the slice is
 *  empty, so the diff renders as all-added. */
function sliceLinesText(
  source: string,
  startLine: number,
  endLine: number,
): string {
  const lines = source.split("\n");
  const startIdx = Math.max(0, startLine - 1);
  const endIdx = endLine < startLine ? startIdx : Math.min(lines.length, endLine);
  return lines.slice(startIdx, endIdx).join("\n");
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

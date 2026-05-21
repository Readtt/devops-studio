import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { go } from "@codemirror/lang-go";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { EditorView, Decoration, type DecorationSet } from "@codemirror/view";
import { StateField, StateEffect } from "@codemirror/state";
import { tokyoNight } from "@uiw/codemirror-theme-tokyo-night";
import { githubDark, githubLight } from "@uiw/codemirror-theme-github";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { ExternalLink, RefreshIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

type Props = {
  /** Absolute path to the file inside the user's chosen source dir. */
  path: string;
  /** 1-based line to scroll to and (with `endLine`) highlight. */
  startLine?: number;
  endLine?: number;
};

type ReadResult =
  | { kind: "text"; content: string; size: number }
  | { kind: "binary"; size: number }
  | { kind: "toolarge"; size: number; limit: number };

export function CodeViewerPane({ path, startLine, endLine }: Props) {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ok"; content: string }
    | { kind: "binary" }
    | { kind: "toolarge"; size: number; limit: number }
    | { kind: "error"; message: string }
  >({ kind: "loading" });
  const viewRef = useRef<ReactCodeMirrorRef | null>(null);
  const themePref = usePreferencesStore((s) => s.theme);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    invoke<ReadResult>("fs_read_file", {
      path,
      workspace: { kind: "local" as const },
    })
      .then((r) => {
        if (cancelled) return;
        if (r.kind === "text") {
          setState({ kind: "ok", content: r.content });
        } else if (r.kind === "binary") {
          setState({ kind: "binary" });
        } else {
          setState({ kind: "toolarge", size: r.size, limit: r.limit });
        }
      })
      .catch((e) => {
        if (cancelled) return;
        setState({ kind: "error", message: String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  const langExt = useMemo(() => languageFor(path), [path]);
  const theme = useMemo(
    () => resolveTheme(themePref),
    [themePref],
  );

  // Once content is loaded, scroll to the linked range and apply the
  // range-highlight decoration. We do this in an effect on the imperative
  // handle rather than via initial state so re-loads behave the same.
  useEffect(() => {
    if (state.kind !== "ok") return;
    const view = viewRef.current?.view;
    if (!view) return;
    const start = clampLine(startLine ?? 1, view.state.doc.lines);
    const end = clampLine(endLine ?? startLine ?? 1, view.state.doc.lines);
    const fromPos = view.state.doc.line(start).from;
    const toPos = view.state.doc.line(end).to;
    view.dispatch({
      effects: [
        setHighlightedRange.of({ from: fromPos, to: toPos }),
        // EditorView.scrollIntoView accepts a numeric position or an
        // EditorSelection.range — single number lands the linked block in
        // view without requiring a selection on a read-only buffer.
        EditorView.scrollIntoView(fromPos, { y: "center" }),
      ],
    });
  }, [state, startLine, endLine]);

  const ext = useMemo(
    () => [langExt, rangeHighlightField, rangeHighlightTheme].filter(Boolean) as any,
    [langExt],
  );

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 bg-card/40 px-3">
        <span className="min-w-0 truncate font-mono text-[11.5px]">{path}</span>
        {startLine ? (
          <span className="rounded bg-foreground/[0.06] px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            {endLine && endLine !== startLine
              ? `lines ${startLine}–${endLine}`
              : `line ${startLine}`}
          </span>
        ) : null}
        <div className="ml-auto flex shrink-0 gap-1">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-[11px]"
            onClick={() => {
              setState({ kind: "loading" });
              // Re-trigger by changing key — easier than re-implementing the
              // load logic. Bumping a counter via state would also work.
              invoke<ReadResult>("fs_read_file", {
                path,
                workspace: { kind: "local" as const },
              })
                .then((r) => {
                  if (r.kind === "text") setState({ kind: "ok", content: r.content });
                  else if (r.kind === "binary") setState({ kind: "binary" });
                  else setState({ kind: "toolarge", size: r.size, limit: r.limit });
                })
                .catch((e) => setState({ kind: "error", message: String(e) }));
            }}
          >
            <HugeiconsIcon icon={RefreshIcon} size={12} strokeWidth={1.75} />
            Reload
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[11px]"
            onClick={() => void openUrl(`file://${path}`)}
          >
            <HugeiconsIcon icon={ExternalLink} size={12} strokeWidth={1.75} />
            Reveal
          </Button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-hidden">
        {state.kind === "loading" ? (
          <div className="flex flex-col gap-3 p-6">
            <Skeleton className="h-3 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : state.kind === "error" ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center text-[12px]">
            <p className="font-medium text-destructive">Couldn't open this file.</p>
            <p className="text-muted-foreground">{state.message}</p>
          </div>
        ) : state.kind === "binary" ? (
          <p className="px-6 py-4 text-[12px] italic text-muted-foreground">
            This is a binary file — preview isn't supported.
          </p>
        ) : state.kind === "toolarge" ? (
          <p className="px-6 py-4 text-[12px] italic text-muted-foreground">
            File is larger than {Math.round(state.limit / 1024)} KB ({Math.round(state.size / 1024)} KB) —
            preview skipped.
          </p>
        ) : (
          <CodeMirror
            ref={viewRef}
            value={state.content}
            theme={theme}
            extensions={ext}
            readOnly
            editable={false}
            basicSetup={{
              lineNumbers: true,
              foldGutter: true,
              highlightActiveLine: false,
              autocompletion: false,
              searchKeymap: false,
              tabSize: 2,
            }}
            height="100%"
            style={{ height: "100%", fontSize: "12.5px" }}
          />
        )}
      </div>
    </div>
  );
}

// --- Language detection -----------------------------------------------------

function languageFor(path: string) {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "ts":
    case "tsx":
      return javascript({ typescript: true, jsx: ext === "tsx" });
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return javascript({ jsx: ext === "jsx" });
    case "py":
    case "pyi":
      return python();
    case "rs":
      return rust();
    case "go":
      return go();
    case "json":
      return json();
    case "md":
    case "mdx":
    case "markdown":
      return markdown();
    case "html":
    case "htm":
      return html();
    case "css":
    case "scss":
    case "less":
      return css();
    default:
      return null;
  }
}

// --- Range highlight decoration --------------------------------------------

const setHighlightedRange = StateEffect.define<{ from: number; to: number } | null>();

const rangeHighlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setHighlightedRange)) {
        if (e.value === null) {
          deco = Decoration.none;
        } else {
          const { from, to } = e.value;
          deco = Decoration.set([
            Decoration.line({
              attributes: { class: "cm-linked-line" },
            }).range(from),
            ...rangeLineDecos(tr.state.doc.lineAt(from).number, tr.state.doc.lineAt(to).number, tr.state.doc),
          ]);
        }
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

function rangeLineDecos(
  startLine: number,
  endLine: number,
  doc: { line: (n: number) => { from: number } },
) {
  if (endLine <= startLine) return [];
  const out = [];
  for (let n = startLine + 1; n <= endLine; n++) {
    out.push(Decoration.line({ attributes: { class: "cm-linked-line" } }).range(doc.line(n).from));
  }
  return out;
}

const rangeHighlightTheme = EditorView.baseTheme({
  ".cm-linked-line": {
    backgroundColor: "rgba(99, 102, 241, 0.12)",
  },
  "&dark .cm-linked-line": {
    backgroundColor: "rgba(129, 140, 248, 0.18)",
  },
});

function clampLine(n: number, total: number): number {
  return Math.max(1, Math.min(n, total));
}

// --- Theme resolution -------------------------------------------------------

function resolveTheme(pref: string) {
  const dark = isDark(pref);
  // The user can change theme later via Settings; we re-render on every theme
  // change because the pref is a zustand subscription in the caller.
  return dark ? tokyoNight : githubLight;
  // (tokyo-night defaults to dark; githubLight is a clean light theme.
  //  Phase 6 can let users pick from the full list re-added to package.json.)
  // The unused import below keeps the option open without a build error.
  void githubDark;
}

function isDark(pref: string): boolean {
  if (pref === "dark") return true;
  if (pref === "light") return false;
  // "system" — fall back to media query
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  }
  return true;
}

import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { go } from "@codemirror/lang-go";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { StreamLanguage } from "@codemirror/language";
import { csharp } from "@codemirror/legacy-modes/mode/clike";
import { EditorView, Decoration, type DecorationSet } from "@codemirror/view";
import { StateField, StateEffect } from "@codemirror/state";
import { tokyoNight } from "@uiw/codemirror-theme-tokyo-night";
import { githubDark, githubLight } from "@uiw/codemirror-theme-github";
import { atomone } from "@uiw/codemirror-theme-atomone";
import { aura } from "@uiw/codemirror-theme-aura";
import { copilot } from "@uiw/codemirror-theme-copilot";
import { nord } from "@uiw/codemirror-theme-nord";
import { xcodeDark, xcodeLight } from "@uiw/codemirror-theme-xcode";
import { devopsStudioDark } from "./themes/devopsStudioDark";
import { displaySourcePath } from "./resolveSourcePath";
import { devopsStudioLight } from "./themes/devopsStudioLight";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { EditorThemeId } from "@/modules/settings/store";
import {
  CodeIcon,
  ExternalLink,
  FolderOpenIcon,
  RefreshIcon,
  Settings01Icon,
} from "@hugeicons/core-free-icons";
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
  // Bumped whenever an external request asks us to re-scroll + re-pulse the
  // SAME range (e.g. the user clicked the same code-ref chip again — the
  // tab is reused so props are identical, but the effect still needs to fire).
  const [pulseTick, setPulseTick] = useState(0);
  const themePref = usePreferencesStore((s) => s.theme);
  const editorThemeId = usePreferencesStore((s) => s.editorTheme);
  const editorFontSize = usePreferencesStore((s) => s.editorFontSize);
  const editorLineNumbers = usePreferencesStore((s) => s.editorLineNumbers);
  const editorWordWrap = usePreferencesStore((s) => s.editorWordWrap);
  const editorHighlightActiveLine = usePreferencesStore(
    (s) => s.editorHighlightActiveLine,
  );
  const editorTabSize = usePreferencesStore((s) => s.editorTabSize);

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
    () => resolveTheme(editorThemeId, themePref),
    [editorThemeId, themePref],
  );

  // Once content is loaded, scroll to the linked range, apply the highlight,
  // and pulse it briefly so the eye finds the line in a long file. We do
  // this in an effect on the imperative handle rather than via initial
  // state so re-loads behave the same.
  useEffect(() => {
    if (state.kind !== "ok") return;
    const view = viewRef.current?.view;
    if (!view) return;
    const start = clampLine(startLine ?? 1, view.state.doc.lines);
    const end = clampLine(endLine ?? startLine ?? 1, view.state.doc.lines);
    const fromPos = view.state.doc.line(start).from;
    const toPos = view.state.doc.line(end).to;
    // Setting `pulse: true` triggers the keyframe animation defined in
    // rangeHighlightTheme; the class is auto-removed by the next dispatch.
    view.dispatch({
      effects: [
        setHighlightedRange.of({ from: fromPos, to: toPos, pulse: true }),
        EditorView.scrollIntoView(fromPos, { y: "center" }),
      ],
    });
    // After the animation finishes, drop the pulse class but keep the
    // static highlight so the user can still see WHICH block we jumped to.
    const id = window.setTimeout(() => {
      const v = viewRef.current?.view;
      if (!v) return;
      v.dispatch({
        effects: [setHighlightedRange.of({ from: fromPos, to: toPos, pulse: false })],
      });
    }, 1600);
    return () => window.clearTimeout(id);
  }, [state, startLine, endLine, pulseTick]);

  // External re-pulse channel. Fired by the tab dispatcher when the user
  // clicks the same code-ref chip a second time — the tab is reused so the
  // props don't change, but the user still expects "jump back + pulse".
  useEffect(() => {
    const onPulse = (e: Event) => {
      const ce = e as CustomEvent<{
        path: string;
        startLine?: number;
        endLine?: number;
      }>;
      if (!ce.detail) return;
      if (ce.detail.path !== path) return;
      if ((ce.detail.startLine ?? null) !== (startLine ?? null)) return;
      if ((ce.detail.endLine ?? null) !== (endLine ?? null)) return;
      setPulseTick((t) => t + 1);
    };
    window.addEventListener("devops-studio:re-pulse-code-range", onPulse);
    return () =>
      window.removeEventListener(
        "devops-studio:re-pulse-code-range",
        onPulse,
      );
  }, [path, startLine, endLine]);

  const ext = useMemo(
    () =>
      [
        langExt,
        rangeHighlightField,
        rangeHighlightTheme,
        editorWordWrap ? EditorView.lineWrapping : null,
      ].filter(Boolean) as any,
    [langExt, editorWordWrap],
  );

  return (
    <div className="cv-pane flex h-full flex-col overflow-hidden">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 bg-card/40 px-3">
        <span className="min-w-0 truncate font-mono text-[11.5px]">
          {displaySourcePath(path)}
        </span>
        {startLine ? (
          <span className="rounded bg-foreground/[0.06] px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            {endLine && endLine !== startLine
              ? `lines ${startLine}–${endLine}`
              : `line ${startLine}`}
          </span>
        ) : null}
        <div className="ml-auto flex shrink-0 gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
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
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-[11px]">
              Re-read this file from disk
            </TooltipContent>
          </Tooltip>
          <OpenWithMenu
            path={path}
            startLine={startLine}
            endLine={endLine}
          />
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
          <div className="flex h-full flex-col items-center justify-center gap-1.5 px-6 text-center text-[12px]">
            <p className="font-medium text-destructive">Couldn't open this file.</p>
            <p className="max-w-md break-all font-mono text-[10.5px] text-muted-foreground">
              {displaySourcePath(path)}
            </p>
            {/(not found|no such file|cannot find|os error 2|enoent)/i.test(
              state.message,
            ) ? (
              <p className="max-w-md text-[11px] text-muted-foreground">
                The path couldn't be found on disk. If this came from an AI
                citation, your Source directory may point at a different repo —
                set it in Settings → General.
              </p>
            ) : (
              <p className="max-w-md text-muted-foreground">{state.message}</p>
            )}
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
              lineNumbers: editorLineNumbers,
              foldGutter: editorLineNumbers,
              highlightActiveLine: editorHighlightActiveLine,
              autocompletion: false,
              searchKeymap: false,
              tabSize: editorTabSize,
            }}
            height="100%"
            style={{ height: "100%", fontSize: `${editorFontSize}px` }}
          />
        )}
      </div>
    </div>
  );
}

/** Dropdown for opening the current file outside DevOps Studio.
 *
 *  Three actions:
 *    • Open in [configured editor]  — only shown when the user has set
 *      `externalEditorCommand` in General settings. Passes the file path
 *      and line range to the editor so it lands the user on the right
 *      block (most editors support `--goto file:line`).
 *    • Reveal in file manager      — opens Explorer / Finder / xdg
 *      with the file selected.
 *    • Open with OS default        — same behavior as the old Reveal
 *      button (file:// URL via tauri-plugin-opener).
 *
 *  When no external editor is configured, the trigger shows a hint that
 *  routes the user to settings — explains WHY the option is missing
 *  instead of just hiding it. */
function OpenWithMenu({
  path,
  startLine,
  endLine,
}: {
  path: string;
  startLine?: number;
  endLine?: number;
}) {
  const externalEditorCommand = usePreferencesStore(
    (s) => s.externalEditorCommand,
  );
  const hasEditor = externalEditorCommand.trim().length > 0;

  const openExternally = async () => {
    try {
      await invoke("open_external_editor", {
        commandTemplate: externalEditorCommand,
        filePath: path,
        startLine: startLine ?? null,
        endLine: endLine ?? null,
      });
    } catch (e) {
      console.error("[code-viewer] external editor launch failed:", e);
    }
  };

  const revealInFileManager = async () => {
    try {
      await invoke("reveal_in_file_manager", { filePath: path });
    } catch (e) {
      console.error("[code-viewer] reveal failed:", e);
    }
  };

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1.5 px-2 text-[11px]"
              aria-label="Open with…"
            >
              <HugeiconsIcon
                icon={ExternalLink}
                size={12}
                strokeWidth={1.75}
              />
              Open with…
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-[11px]">
          Pick how to open this file outside DevOps Studio
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-[260px]">
        {hasEditor ? (
          <DropdownMenuItem onClick={() => void openExternally()}>
            <HugeiconsIcon icon={CodeIcon} size={12} strokeWidth={1.75} />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-[12px]">Open in external editor</span>
              <span className="truncate font-mono text-[10px] text-muted-foreground">
                {ellipsizeCommand(externalEditorCommand)}
              </span>
            </div>
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem onClick={() => void openSettingsWindow("general")}>
            <HugeiconsIcon
              icon={Settings01Icon}
              size={12}
              strokeWidth={1.75}
            />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-[12px]">Configure external editor…</span>
              <span className="text-[10px] text-muted-foreground">
                Pick VS Code, Sublime, vim, etc. in General settings.
              </span>
            </div>
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => void revealInFileManager()}>
          <HugeiconsIcon icon={FolderOpenIcon} size={12} strokeWidth={1.75} />
          Reveal in file manager
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void openUrl(`file://${path}`)}>
          <HugeiconsIcon icon={ExternalLink} size={12} strokeWidth={1.75} />
          Open with OS default
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ellipsizeCommand(s: string, max = 40): string {
  const trimmed = s.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
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
    case "jsonc":
      return json();
    case "md":
    case "mdx":
    case "markdown":
      return markdown();
    case "html":
    case "htm":
    case "xml":
    case "xhtml":
    case "svg":
    case "vue":
    case "svelte":
      return html();
    case "css":
    case "scss":
    case "less":
    case "sass":
      return css();
    case "cs":
    case "csx":
      // C# via @codemirror/legacy-modes' clike. Not as full-fidelity as a
      // dedicated parser, but covers keywords, strings, comments, and
      // numbers — enough to read code at a glance.
      return StreamLanguage.define(csharp);
    case "razor":
    case "cshtml":
    case "vbhtml":
      // Razor pages are HTML with C# expression islands. We highlight as
      // HTML so the markup reads correctly; @code/@expr blocks fall back
      // to plain text inside the html() parser, which is acceptable for
      // a read-only viewer.
      return html();
    // No dedicated language packages installed for these; fall through to
    // plain text so the chosen theme's base colours still apply. Adding
    // proper modes is a follow-up that requires npm installs.
    default:
      return null;
  }
}

// --- Range highlight decoration --------------------------------------------

const setHighlightedRange = StateEffect.define<{
  from: number;
  to: number;
  pulse: boolean;
} | null>();

const rangeHighlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setHighlightedRange)) {
        if (e.value === null) {
          deco = Decoration.none;
        } else {
          const { from, to, pulse } = e.value;
          const cls = pulse
            ? "cm-linked-line cm-linked-line-pulse"
            : "cm-linked-line";
          const startLine = tr.state.doc.lineAt(from).number;
          const endLine = tr.state.doc.lineAt(to).number;
          deco = Decoration.set([
            Decoration.line({ attributes: { class: cls } }).range(from),
            ...rangeLineDecos(startLine, endLine, tr.state.doc, cls),
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
  cls: string,
) {
  if (endLine <= startLine) return [];
  const out = [];
  for (let n = startLine + 1; n <= endLine; n++) {
    out.push(Decoration.line({ attributes: { class: cls } }).range(doc.line(n).from));
  }
  return out;
}

/* The visual styling for `.cm-linked-line` and `.cm-linked-line-pulse` lives
 * in globals.css (under `.cv-pane`), not here. CodeMirror's baseTheme
 * injects rules into its CSS scope but `@keyframes` inside that scope
 * don't fire reliably — keeping the animation in plain CSS bypasses that
 * gotcha and lets dark-mode pairing flow through the `.dark` selector.
 *
 * The decoration field still injects the class names; this empty extension
 * stays in the array to preserve the call-site shape so older diffs still
 * apply cleanly during reviews. */
const rangeHighlightTheme = EditorView.baseTheme({});

function clampLine(n: number, total: number): number {
  return Math.max(1, Math.min(n, total));
}

// --- Theme resolution -------------------------------------------------------

/** Resolve the user's editor-theme preference to a CodeMirror Extension.
 *  Each theme family carries an analogous light/dark pair, so picking
 *  "DevOps Studio" or "Xcode" in dark mode and flipping the app to light
 *  swaps the editor to the *same family's* light variant — not a generic
 *  GitHub Light fallback. Dark-only upstream themes still degrade to a
 *  paired light theme so the editor never lands on white-on-white.
 */
function resolveTheme(editorThemeId: EditorThemeId, themePref: string) {
  const dark = isDark(themePref);
  const map: Record<EditorThemeId, { light: unknown; dark: unknown }> = {
    // Hand-tuned pair: matches the app's OLED chrome (dark) / paper (light).
    "devops-studio": { light: devopsStudioLight, dark: devopsStudioDark },
    // Both variants ship with the upstream theme — natural pairings.
    github: { light: githubLight, dark: githubDark },
    xcode: { light: xcodeLight, dark: xcodeDark },
    // Dark-only upstreams. Fall back to githubLight for a clean, neutral
    // light counterpart — the only goal is "stays readable when the app
    // flips to light", not perfect aesthetic mirroring (those themes are
    // canonically dark and the user is explicitly picking a dark theme).
    "atom-one": { light: githubLight, dark: atomone },
    aura: { light: githubLight, dark: aura },
    copilot: { light: githubLight, dark: copilot },
    nord: { light: githubLight, dark: nord },
    "tokyo-night": { light: githubLight, dark: tokyoNight },
  };
  const entry = map[editorThemeId] ?? map["devops-studio"];
  return (dark ? entry.dark : entry.light) as never;
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

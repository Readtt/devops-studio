import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { useTheme } from "@/modules/theme";
import {
  decodeFromPty,
  encodeForPty,
  killPty,
  listenPtyData,
  listenPtyExit,
  resizePty,
  spawnPty,
  writePty,
} from "./usePtySession";
import { useTabsStore } from "@/modules/tabs/store/useTabsStore";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { QuickPromptsStrip } from "./QuickPromptsStrip";
import {
  Copy01Icon,
  ClipboardPasteIcon,
  Eraser01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  disposeSession,
  getSession,
  registerSession,
  type TerminalSession,
} from "./terminalRegistry";

const DEFAULT_FONT_FAMILY =
  '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, "Cascadia Code", "Roboto Mono", monospace';

const THEME_DARK: ITheme = {
  background: "#000000",
  foreground: "#e6e3dd",
  cursor: "#e6e3dd",
  cursorAccent: "#000000",
  selectionBackground: "#3a3a3a",
  selectionForeground: "#f4f1ec",
  black: "#1a1a1a",
  red: "#e06c75",
  green: "#98c379",
  yellow: "#e5c07b",
  blue: "#61afef",
  magenta: "#c678dd",
  cyan: "#56b6c2",
  white: "#cbd1da",
  brightBlack: "#5c6370",
  brightRed: "#ef8b95",
  brightGreen: "#b1d68f",
  brightYellow: "#f0d098",
  brightBlue: "#7cc4ff",
  brightMagenta: "#dd8df1",
  brightCyan: "#6ed1de",
  brightWhite: "#f4f6fa",
};

const THEME_LIGHT: ITheme = {
  background: "#fafaf7",
  foreground: "#1f1d1a",
  cursor: "#1f1d1a",
  cursorAccent: "#fafaf7",
  selectionBackground: "#d6dbe5",
  selectionForeground: "#1f1d1a",
  black: "#0f0f0f",
  red: "#b22a37",
  green: "#3e8a2c",
  yellow: "#8a6d1f",
  blue: "#2266c2",
  magenta: "#8c2dbf",
  cyan: "#147a85",
  white: "#3a3a3a",
  brightBlack: "#6e6e6e",
  brightRed: "#cc4651",
  brightGreen: "#5aa446",
  brightYellow: "#a78532",
  brightBlue: "#3d80d6",
  brightMagenta: "#a443d6",
  brightCyan: "#2a96a3",
  brightWhite: "#fafaf7",
};

type Props = {
  tabId: number;
  sessionId: string;
  cwd: string | null;
  /** Reserved — see ShellBrandIcon comment in the previous diff. */
  shellId: string | null;
};

/**
 * Terminal pane.
 *
 * Terminal + PTY ownership lives OUTSIDE React in `terminalRegistry.ts`.
 * Why: when the user splits the workspace pane, the React tree restructures
 * and React unmounts everything under the leaf — including TerminalPane.
 * If we owned the xterm Terminal here, that unmount would dispose it and
 * kill the PTY, blanking the user's session mid-keystroke. The registry
 * keeps the Terminal + PTY alive across remounts; this component just
 * attaches xterm's DOM to whichever container React happens to give us.
 *
 * Disposal happens on real lifecycle events:
 *   - tab close   → `useTabsStore` no longer has our tabId → dispose
 *   - PTY exit    → user typed `exit`; component stays mounted, registry
 *                   entry stays alive (exited=true) until tab close
 *   - app close   → Rust-side `PtyState::kill_all` handles it
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- shellId reserved
export function TerminalPane({ tabId, sessionId, cwd, shellId: _shellId }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Local-only mirror of the registry's exited flag — drives the
  // QuickPromptsStrip visibility without forcing every consumer to peek
  // into the registry.
  const [exited, setExited] = useState(
    () => getSession(sessionId)?.exited ?? false,
  );

  const { resolvedTheme } = useTheme();
  const fontSize = usePreferencesStore((s) => s.terminalFontSize);
  const fontFamilyOverride = usePreferencesStore((s) => s.terminalFontFamily);
  const letterSpacing = usePreferencesStore((s) => s.terminalLetterSpacing);
  const scrollback = usePreferencesStore((s) => s.terminalScrollback);
  const webglEnabled = usePreferencesStore((s) => s.terminalWebglEnabled);
  const defaultShellPath = usePreferencesStore((s) => s.defaultShellPath);
  const renameTab = useTabsStore((s) => s.renameTab);

  const fontFamily = useMemo(
    () =>
      fontFamilyOverride && fontFamilyOverride.trim().length > 0
        ? `"${fontFamilyOverride.replace(/"/g, "")}", ${DEFAULT_FONT_FAMILY}`
        : DEFAULT_FONT_FAMILY,
    [fontFamilyOverride],
  );

  // Effect runs on every mount. If the registry already has a live
  // session for this id (because we're remounting after a pane split),
  // we just re-attach xterm's DOM and keep going. Otherwise we create
  // the session from scratch.
  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;

    let session = getSession(sessionId);
    const isNew = !session;

    if (!session) {
      // ── Fresh session ─────────────────────────────────────────────
      const term = new Terminal({
        fontFamily,
        fontSize,
        letterSpacing,
        scrollback,
        cursorBlink: true,
        cursorStyle: "block",
        allowProposedApi: true,
        convertEol: false,
        theme: resolvedTheme === "light" ? THEME_LIGHT : THEME_DARK,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.loadAddon(new WebLinksAddon());
      term.open(container);

      let webgl: WebglAddon | null = null;
      if (webglEnabled) {
        try {
          const w = new WebglAddon();
          w.onContextLoss(() => {
            w.dispose();
            const cur = getSession(sessionId);
            if (cur) cur.webgl = null;
          });
          term.loadAddon(w);
          webgl = w;
        } catch (e) {
          console.warn("[terminal] webgl addon failed, using canvas:", e);
        }
      }

      // PTY listeners — these stay alive for the entire session
      // lifetime regardless of remounts. We store the unlisten fns in
      // the registry so disposeSession can tear them down at tab close.
      const sessionForCallbacks: { ref: TerminalSession | null } = { ref: null };
      const listenersReady = (async () => {
        const unlistenData = await listenPtyData(sessionId, ({ data }) => {
          const s = sessionForCallbacks.ref;
          if (!s) return;
          s.term.write(decodeFromPty(data));
        });
        const unlistenExit = await listenPtyExit(sessionId, (payload) => {
          const s = sessionForCallbacks.ref;
          if (!s) return;
          s.exited = true;
          setExited(true);
          const tag =
            payload.killed
              ? "\r\n\x1b[2m[terminal closed]\x1b[0m\r\n"
              : `\r\n\x1b[2m[process exited${
                  payload.exitCode == null ? "" : ` with code ${payload.exitCode}`
                }]\x1b[0m\r\n`;
          s.term.write(tag);
          const { tabs } = useTabsStore.getState();
          const t = tabs[tabId];
          if (t && !t.title.endsWith(" (exited)")) {
            renameTab(tabId, `${t.title} (exited)`);
          }
        });
        return { unlistenData, unlistenExit };
      })();

      const spawnPromise = (async () => {
        const { unlistenData, unlistenExit } = await listenersReady;
        const s: TerminalSession = {
          sessionId,
          term,
          fit,
          webgl,
          lastChipTypedLength: 0,
          unlistenData,
          unlistenExit,
          exited: false,
          spawnPromise: null as unknown as Promise<{ shellPath: string; shellKind: string }>,
        };
        sessionForCallbacks.ref = s;
        // Wait one paint so the container has measured.
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        try {
          fit.fit();
        } catch {
          // ignore
        }
        const { cols = 80, rows = 24 } = term;
        const result = await spawnPty({
          sessionId,
          shellPath: defaultShellPath,
          cwd,
          cols,
          rows,
        });
        const cwdBase = cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() : null;
        const titleParts = [shellKindLabel(result.shellKind)];
        if (cwdBase) titleParts.push(cwdBase);
        renameTab(tabId, titleParts.join(" · "));
        return result;
      })();

      // Place a placeholder entry in the registry BEFORE spawn resolves
      // so a fast pane-restructure that remounts the component finds
      // the in-flight session and doesn't double-spawn.
      const placeholder: TerminalSession = {
        sessionId,
        term,
        fit,
        webgl,
        unlistenData: () => undefined,
        unlistenExit: () => undefined,
        exited: false,
        spawnPromise,
        lastChipTypedLength: 0,
      };
      registerSession(placeholder);
      void listenersReady.then(({ unlistenData, unlistenExit }) => {
        const s = getSession(sessionId);
        if (s) {
          s.unlistenData = unlistenData;
          s.unlistenExit = unlistenExit;
          sessionForCallbacks.ref = s;
        }
      });
      session = placeholder;
    } else {
      // ── Existing session: re-attach xterm DOM to the new container ──
      // We do NOT call term.open(container) again — xterm.js v6 doesn't
      // safely support being re-opened, and calling it twice was making
      // the terminal "absolutely die" on resize / pane split. Instead we
      // physically move the existing root element to the new container.
      // The xterm renderer keeps painting into the same element
      // regardless of which DOM ancestor it sits under, so the scrollback
      // survives.
      //
      // WebGL is the exception: its canvas-backed framebuffer doesn't
      // tolerate being moved between DOM contexts (the GL context tied
      // to the old container goes invalid). Dispose the addon on
      // re-attach and let xterm fall back to the canvas renderer. The
      // user can reload the tab to get WebGL back if they want it.
      if (session.webgl) {
        try {
          session.webgl.dispose();
        } catch {
          // ignore
        }
        session.webgl = null;
      }
      const el = session.term.element;
      if (el && el.parentElement !== container) {
        try {
          container.appendChild(el);
        } catch (e) {
          console.warn("[terminal] DOM re-attach failed:", e);
        }
      }
      if (session.exited !== exited) setExited(session.exited);
    }

    // Keystroke pipe — recreated per mount so the closure captures the
    // current sessionId. (sessionId is stable, but this also makes the
    // disposable clean up cleanly on every unmount.)
    const dataSub = session.term.onData((data) => {
      // The user typed something — invalidate our chip-typed-length
      // tracker so the next Quick Prompts click doesn't backspace over
      // the user's keystrokes. Best-effort: if the user appended just
      // a single char, we still skip the backspace path, which leaves
      // a messy concatenated line they can fix manually.
      const s = getSession(sessionId);
      if (s) s.lastChipTypedLength = 0;
      void writePty(sessionId, encodeForPty(data)).catch((e) => {
        console.warn("[terminal] write failed:", e);
      });
    });

    // ── Resize handling (same robustness fixes as before) ─────────────
    let rafId = 0;
    let settleTimer: number | undefined;
    const runFit = () => {
      const s = getSession(sessionId);
      if (!s) return;
      // The container may not be in this component's DOM tree anymore by
      // the time a queued rAF fires (fast pane swaps can outpace our
      // cleanup). Guard against fitting a stranded terminal.
      if (!s.term.element || !s.term.element.isConnected) return;
      try {
        const dims = s.fit.proposeDimensions();
        if (
          !dims ||
          !Number.isFinite(dims.cols) ||
          !Number.isFinite(dims.rows) ||
          dims.cols < 2 ||
          dims.rows < 2
        ) {
          return;
        }
        s.fit.fit();
        void resizePty(sessionId, s.term.cols, s.term.rows);
      } catch {
        // proposeDimensions / fit threw — usually the container hasn't
        // settled yet. The next ResizeObserver tick will catch it.
      }
    };
    const scheduleFit = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        runFit();
      });
      if (settleTimer) window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(runFit, 120);
    };
    scheduleFit();

    const ro = new ResizeObserver(scheduleFit);
    ro.observe(container);
    if (container.parentElement) ro.observe(container.parentElement);

    // Tab-store subscription serves two purposes:
    //   1. Trigger a re-fit on pane-tree changes that don't resize our
    //      container (tab swap, sibling pane split, etc).
    //   2. Detect when our tab has been closed and dispose the session.
    const unsubTabs = useTabsStore.subscribe((s) => {
      if (!s.tabs[tabId]) {
        // Tab is gone. Kill PTY + dispose xterm + registry entry.
        void killPty(sessionId);
        disposeSession(sessionId);
      } else {
        scheduleFit();
      }
    });

    if (isNew) {
      // Surface spawn errors in the viewport once.
      void session.spawnPromise.catch((e: unknown) => {
        const s = getSession(sessionId);
        if (!s) return;
        s.term.write(
          `\r\n\x1b[31mFailed to start terminal:\x1b[0m ${
            e instanceof Error ? e.message : String(e)
          }\r\n`,
        );
      });
    }

    return () => {
      // Detach but DO NOT dispose — the session lives in the registry
      // until the tab closes. ResizeObserver and the keystroke pipe are
      // mount-scoped, so those get cleaned up here.
      ro.disconnect();
      if (rafId) cancelAnimationFrame(rafId);
      if (settleTimer) window.clearTimeout(settleTimer);
      unsubTabs();
      dataSub.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Live-update font / spacing / scrollback / theme without re-spawning.
  useEffect(() => {
    const s = getSession(sessionId);
    if (!s) return;
    s.term.options.fontFamily = fontFamily;
    s.term.options.fontSize = fontSize;
    s.term.options.letterSpacing = letterSpacing;
    s.term.options.scrollback = scrollback;
    s.term.options.theme = resolvedTheme === "light" ? THEME_LIGHT : THEME_DARK;
    try {
      s.fit.fit();
    } catch {
      // ignore — the container may be momentarily detached
    }
  }, [sessionId, fontFamily, fontSize, letterSpacing, scrollback, resolvedTheme]);

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-background">
      {!exited ? <QuickPromptsStrip sessionId={sessionId} /> : null}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={containerRef}
            className={cn(
              "relative min-h-0 flex-1 overflow-hidden px-1.5 pt-1",
              "[&_.xterm-viewport]:!bg-transparent",
            )}
          />
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-44">
          <ContextMenuItem
            icon={<HugeiconsIcon icon={Copy01Icon} size={12} strokeWidth={1.75} />}
            description="Copy the current selection to the clipboard."
            onSelect={() => {
              const s = getSession(sessionId);
              if (!s || !s.term.hasSelection()) return;
              void navigator.clipboard.writeText(s.term.getSelection()).catch((e) => {
                console.warn("[terminal] clipboard write failed:", e);
              });
            }}
          >
            Copy
          </ContextMenuItem>
          <ContextMenuItem
            icon={
              <HugeiconsIcon
                icon={ClipboardPasteIcon}
                size={12}
                strokeWidth={1.75}
              />
            }
            description="Paste clipboard contents into the shell at the cursor. Some shells treat multi-line pastes as separate commands — check before pressing Enter."
            onSelect={() => {
              void (async () => {
                try {
                  const text = await navigator.clipboard.readText();
                  if (!text) return;
                  await writePty(sessionId, encodeForPty(text));
                } catch (e) {
                  console.warn("[terminal] clipboard read failed:", e);
                }
              })();
            }}
          >
            Paste
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            icon={
              <HugeiconsIcon icon={Eraser01Icon} size={12} strokeWidth={1.75} />
            }
            description="Wipe the viewport and scrollback. The running shell isn't restarted — the next command keeps running where it left off."
            onSelect={() => {
              const s = getSession(sessionId);
              s?.term.clear();
            }}
          >
            Clear viewport
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
}

function shellKindLabel(kind: string): string {
  switch (kind) {
    case "pwsh":
      return "pwsh";
    case "powershell":
      return "powershell";
    case "cmd":
      return "cmd";
    case "git-bash":
      return "git-bash";
    case "bash":
      return "bash";
    case "zsh":
      return "zsh";
    case "fish":
      return "fish";
    case "sh":
      return "sh";
    default:
      return "shell";
  }
}

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

// Default monospace stack — matches the editor / chat code fences so users
// who don't override `terminalFontFamily` get the app's house font.
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
  /** Tab id — used to look up the tab in the tabs store for cwd / shellId
   *  config. */
  tabId: number;
  /** Stable session id minted when the tab was opened. */
  sessionId: string;
  /** Working directory the shell launches in. */
  cwd: string | null;
  /** Selected shell id (matches `ShellCandidate.id`). Reserved for a future
   *  "open with X shell" entry point — today we resolve against the user's
   *  `defaultShellPath` preference only. */
  shellId: string | null;
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- shellId reserved
export function TerminalPane({ tabId, sessionId, cwd, shellId: _shellId }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const webglRef = useRef<WebglAddon | null>(null);
  // `exited` is the only piece of UI state we keep — the header chrome is
  // gone, but the QuickPromptsStrip hides once the shell ends (no point
  // typing prompts into a dead terminal) so we need this signal.
  const [exited, setExited] = useState(false);

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

  // Spawn + mount. Runs once per session — sessionId is stable for the tab
  // lifetime, so depending on it is correct AND defensive.
  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;

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

    if (webglEnabled) {
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          // Lost the GPU context (e.g. driver crash). Drop the addon and let
          // xterm fall back to canvas — terminal stays usable.
          webgl.dispose();
          webglRef.current = null;
        });
        term.loadAddon(webgl);
        webglRef.current = webgl;
      } catch (e) {
        console.warn("[terminal] webgl addon failed, using canvas:", e);
      }
    }

    termRef.current = term;
    fitRef.current = fit;

    // ── Resize handling ────────────────────────────────────────────────
    //
    // The split-pane case used to break the terminal: when the user
    // dragged the resize handle, xterm's FitAddon would measure mid-drag
    // (sometimes with dimensions of 0) and either throw or paint cells at
    // the wrong size. The fix has three parts:
    //
    //   1. Guard via `proposeDimensions` — if the proposed size is too
    //      small (or zero), skip the fit and try again next frame.
    //   2. After every fit, call `term.refresh(0, rows-1)` to force xterm
    //      to repaint cells against the new metrics — without this, the
    //      WebGL renderer leaves stale tiles around the edges.
    //   3. Run a second fit on a small delay after the burst settles, so
    //      anything the mid-drag fit got wrong is corrected once the user
    //      releases the handle.
    let rafId = 0;
    let settleTimer: number | undefined;
    const runFit = () => {
      const t = termRef.current;
      const f = fitRef.current;
      if (!t || !f) return;
      try {
        const dims = f.proposeDimensions();
        if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) {
          return;
        }
        if (dims.cols < 2 || dims.rows < 2) return;
        f.fit();
        // refresh() forces a re-render of the visible rows so the WebGL
        // / canvas backbuffer matches the new layout. Without it,
        // resize-during-drag leaves smeared cells until the next keystroke.
        try {
          t.refresh(0, Math.max(0, t.rows - 1));
        } catch {
          // ignore — refresh on a disposed terminal throws, which is
          // already covered by the disposed flag in the teardown path.
        }
        void resizePty(sessionId, t.cols, t.rows);
      } catch {
        // proposeDimensions / fit threw — usually the container hasn't
        // measured yet. The next ResizeObserver tick will catch it.
      }
    };
    const scheduleFit = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        runFit();
      });
      // Belt-and-braces: also fire once after the resize burst settles.
      // 120ms covers a normal release-of-pane-handle.
      if (settleTimer) window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => {
        runFit();
      }, 120);
    };

    // Initial paint may race with the parent's layout — schedule rather
    // than calling fit() inline.
    scheduleFit();

    // Subscribe to PTY events BEFORE spawning so we can't miss the first
    // chunk of output. Tauri's `listen` returns a promise to the unlisten
    // fn; we accumulate them and run on teardown.
    let unlistenData: (() => void) | undefined;
    let unlistenExit: (() => void) | undefined;
    let disposed = false;

    void (async () => {
      try {
        unlistenData = await listenPtyData(sessionId, ({ data }) => {
          if (disposed) return;
          term.write(decodeFromPty(data));
        });
        unlistenExit = await listenPtyExit(sessionId, (payload) => {
          if (disposed) return;
          setExited(true);
          const tag =
            payload.killed
              ? "\r\n\x1b[2m[terminal closed]\x1b[0m\r\n"
              : `\r\n\x1b[2m[process exited${
                  payload.exitCode == null ? "" : ` with code ${payload.exitCode}`
                }]\x1b[0m\r\n`;
          term.write(tag);
          // Reflect exit in the tab title so the strip carries the signal
          // without us putting a chrome bar back.
          const { tabs } = useTabsStore.getState();
          const t = tabs[tabId];
          if (t && !t.title.endsWith(" (exited)")) {
            renameTab(tabId, `${t.title} (exited)`);
          }
        });

        // Wait one frame so the container has measured before we propose
        // dimensions to the PTY. Spawning at 80×24 and then resizing
        // works, but starts the shell drawing at the wrong size which
        // looks janky for the first 100ms.
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        const { cols = 80, rows = 24 } = term;

        const result = await spawnPty({
          sessionId,
          shellPath: defaultShellPath,
          cwd,
          cols,
          rows,
        });
        if (disposed) {
          void killPty(sessionId);
          return;
        }
        const cwdBase = cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() : null;
        const titleParts = [shellKindLabel(result.shellKind)];
        if (cwdBase) titleParts.push(cwdBase);
        renameTab(tabId, titleParts.join(" · "));
        // Fit one more time after the shell starts — the first prompt may
        // have shifted the visible area (e.g. PS1 with a newline above).
        scheduleFit();
      } catch (e) {
        console.error("[terminal] spawn failed:", e);
        term.write(
          `\r\n\x1b[31mFailed to start terminal:\x1b[0m ${
            e instanceof Error ? e.message : String(e)
          }\r\n`,
        );
      }
    })();

    const dataSub = term.onData((data) => {
      void writePty(sessionId, encodeForPty(data)).catch((e) => {
        console.warn("[terminal] write failed:", e);
      });
    });

    // ResizeObserver covers pane-split resize, window resize, and the
    // initial-mount race where the container takes a frame to settle.
    const ro = new ResizeObserver(scheduleFit);
    ro.observe(container);

    // Also watch the *parent* — when a sibling pane is split or its
    // resizable handle is dragged, the parent's layout shifts before
    // our container's contentRect does. Observing the parent picks up
    // the upstream change one frame earlier and avoids visible jitter.
    if (container.parentElement) {
      ro.observe(container.parentElement);
    }

    // Subscribe to tab-store changes too — splits/merges/tab swaps may
    // not change our container's content-rect (tabs use visibility:hidden,
    // not display:none, so dimensions stay constant). Fires on every
    // tabs-store update; scheduleFit is rAF-coalesced so the extra wakes
    // are cheap.
    const unsubTabs = useTabsStore.subscribe(() => {
      scheduleFit();
    });

    return () => {
      disposed = true;
      ro.disconnect();
      if (rafId) cancelAnimationFrame(rafId);
      if (settleTimer) window.clearTimeout(settleTimer);
      unsubTabs();
      dataSub.dispose();
      if (unlistenData) unlistenData();
      if (unlistenExit) unlistenExit();
      void killPty(sessionId);
      try {
        term.dispose();
      } catch {
        // ignore — addon disposal can throw on partial mounts.
      }
      termRef.current = null;
      fitRef.current = null;
      webglRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Live-update font / spacing / scrollback / theme without re-spawning.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontFamily = fontFamily;
    term.options.fontSize = fontSize;
    term.options.letterSpacing = letterSpacing;
    term.options.scrollback = scrollback;
    term.options.theme = resolvedTheme === "light" ? THEME_LIGHT : THEME_DARK;
    try {
      fitRef.current?.fit();
      term.refresh(0, Math.max(0, term.rows - 1));
    } catch {
      // ignore — same race as on mount
    }
  }, [fontFamily, fontSize, letterSpacing, scrollback, resolvedTheme]);

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-background">
      {!exited ? <QuickPromptsStrip sessionId={sessionId} /> : null}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={containerRef}
            className={cn(
              "relative min-h-0 flex-1 overflow-hidden px-1.5 pt-1",
              // Terminal owns its own scrollbar; suppress the app's themed one.
              "[&_.xterm-viewport]:!bg-transparent",
            )}
          />
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-44">
          <ContextMenuItem
            icon={<HugeiconsIcon icon={Copy01Icon} size={12} strokeWidth={1.75} />}
            description="Copy the current selection to the clipboard."
            onSelect={() => {
              const t = termRef.current;
              if (!t || !t.hasSelection()) return;
              const text = t.getSelection();
              void navigator.clipboard.writeText(text).catch((e) => {
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
              const t = termRef.current;
              t?.clear();
            }}
          >
            Clear viewport
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
}

/** Human label for a shell kind from `pty_spawn`'s response. */
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

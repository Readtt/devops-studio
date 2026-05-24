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
  type PtySpawnResult,
} from "./usePtySession";
import { useTabsStore } from "@/modules/tabs/store/useTabsStore";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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

// ANSI palettes tuned for the app's aesthetic.
//
//   Dark:  pure-black bg (matches OLED theme), warm-neutral foreground.
//          The 16 ANSI colours are a hand-picked accessible palette — slightly
//          desaturated reds/greens to avoid the eye-bleed of stock xterm.
//   Light: cream-white bg, ink foreground. Same 16 hues, darkened for
//          contrast on a light surface.
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
   *  `defaultShellPath` preference only. The prop is in the type so callers
   *  can already pass it without an ABI bump when the feature lands. */
  shellId: string | null;
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- shellId reserved
export function TerminalPane({ tabId, sessionId, cwd, shellId: _shellId }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const webglRef = useRef<WebglAddon | null>(null);
  // We hold the spawn result so the header can show shell name + cwd, and so
  // a "Restart Session" action in Phase 6 has the resolved path to reuse.
  const [spawn, setSpawn] = useState<PtySpawnResult | null>(null);
  const [exitInfo, setExitInfo] = useState<{
    code: number | null;
    killed: boolean;
  } | null>(null);

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

  // Spawn + mount. This effect runs once per session — re-running it would
  // open a second PTY for the same tab, which is exactly the bug. The
  // session_id is stable for the lifetime of the tab, so depending on it
  // is correct but defensive.
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
      // Respect line wrapping the same way real terminals do. The PTY tells
      // us its size via resize; xterm just renders what comes back.
      convertEol: false,
      theme: resolvedTheme === "light" ? THEME_LIGHT : THEME_DARK,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());

    term.open(container);

    // WebGL renderer is optional — falls back to canvas on failure. We only
    // attach if the preference is on; the addon has its own internal probe
    // for support, but instantiating it unconditionally has been known to
    // throw on machines where the WebGL context can't be created.
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

    // Initial fit before spawn so the PTY opens at the actual viewport size.
    // Wrapped in try because xterm throws if the container has 0 dimensions
    // (race with first paint).
    try {
      fit.fit();
    } catch {
      // ignore — first ResizeObserver tick will fix it.
    }

    const { cols = 80, rows = 24 } = term;

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
          setExitInfo({ code: payload.exitCode, killed: payload.killed });
          // Print a soft footer so the user sees the shell ended without
          // having to read the tab chrome.
          const tag =
            payload.killed
              ? "\r\n\x1b[2m[terminal closed]\x1b[0m\r\n"
              : `\r\n\x1b[2m[process exited${
                  payload.exitCode == null ? "" : ` with code ${payload.exitCode}`
                }]\x1b[0m\r\n`;
          term.write(tag);
        });

        const result = await spawnPty({
          sessionId,
          shellPath: defaultShellPath,
          cwd,
          cols,
          rows,
        });
        if (disposed) {
          // The tab was closed before spawn returned. Tear the child down
          // immediately so we don't leak a shell.
          void killPty(sessionId);
          return;
        }
        setSpawn(result);
        // Rename the tab so the user sees "pwsh · projectName" instead of
        // a bare "Terminal" — keeps the tab strip readable when several
        // shells are open.
        const cwdBase = cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() : null;
        const titleParts = [shellKindLabel(result.shellKind)];
        if (cwdBase) titleParts.push(cwdBase);
        renameTab(tabId, titleParts.join(" · "));
      } catch (e) {
        console.error("[terminal] spawn failed:", e);
        term.write(
          `\r\n\x1b[31mFailed to start terminal:\x1b[0m ${
            e instanceof Error ? e.message : String(e)
          }\r\n`,
        );
      }
    })();

    // Keystrokes → PTY. xterm.onData fires with a JS string; encodeForPty
    // UTF-8s and base64s for the wire.
    const dataSub = term.onData((data) => {
      void writePty(sessionId, encodeForPty(data)).catch((e) => {
        console.warn("[terminal] write failed:", e);
      });
    });

    // ResizeObserver covers both window resize and pane resize. Coalesce
    // with rAF so a fast drag doesn't fan out to a dozen pty_resize calls.
    let rafId = 0;
    const ro = new ResizeObserver(() => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        try {
          fit.fit();
        } catch {
          return;
        }
        const { cols: c, rows: r } = term;
        void resizePty(sessionId, c, r);
      });
    });
    ro.observe(container);

    return () => {
      disposed = true;
      ro.disconnect();
      if (rafId) cancelAnimationFrame(rafId);
      dataSub.dispose();
      if (unlistenData) unlistenData();
      if (unlistenExit) unlistenExit();
      // Kill the PTY first, then dispose the terminal. Reversing this order
      // can race — xterm might receive a final exit-event chunk while it's
      // being torn down, which is harmless but spams the console.
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
  // xterm exposes `.options` as a setter — assigning re-renders without
  // losing scroll buffer.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontFamily = fontFamily;
    term.options.fontSize = fontSize;
    term.options.letterSpacing = letterSpacing;
    term.options.scrollback = scrollback;
    term.options.theme = resolvedTheme === "light" ? THEME_LIGHT : THEME_DARK;
    // Re-fit after font change — character width may have shifted.
    try {
      fitRef.current?.fit();
    } catch {
      // ignore — same race as on mount
    }
  }, [fontFamily, fontSize, letterSpacing, scrollback, resolvedTheme]);

  // Header bits.
  const shellLabel = spawn ? shellKindLabel(spawn.shellKind) : "Starting…";
  const cwdLabel = cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd : "—";
  const headerSubtle =
    "text-[10.5px] font-medium tracking-[0.01em] text-muted-foreground";

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-background">
      <div
        className={cn(
          "flex h-7 shrink-0 items-center gap-2 border-b border-border/50 px-3",
          "bg-card/40",
        )}
      >
        <span className={cn(headerSubtle, "font-mono")}>{shellLabel}</span>
        <span className={headerSubtle}>·</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className={cn(
                "min-w-0 truncate font-mono text-[10.5px] text-foreground/75",
              )}
            >
              {cwdLabel}
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-[11px]">
            {cwd ?? "Working directory not set"}
          </TooltipContent>
        </Tooltip>
        {exitInfo && (
          <span className="ml-auto rounded-sm bg-muted/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            {exitInfo.killed
              ? "Closed"
              : exitInfo.code == null
                ? "Exited"
                : `Exit ${exitInfo.code}`}
          </span>
        )}
      </div>
      {!exitInfo ? <QuickPromptsStrip sessionId={sessionId} /> : null}
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

// Module-scoped registry of live xterm + PTY sessions.
//
// Why: react-resizable-panels restructures the React tree whenever the
// user splits a pane (move a leaf inside a split node, etc). That
// restructure unmounts everything underneath, including TerminalPane —
// which used to dispose xterm and kill the PTY on unmount. The user
// experienced this as "type a command, split the pane, terminal goes
// blank". Bad data loss.
//
// The fix: terminal ownership lives outside the component tree. The
// pane component just attaches xterm's existing DOM to whatever container
// React happens to give it this render. Disposal is triggered by tab
// close (a real lifecycle event the user controls), not by React
// re-parenting.

import type { FitAddon } from "@xterm/addon-fit";
import type { WebglAddon } from "@xterm/addon-webgl";
import type { Terminal } from "@xterm/xterm";

/** What we hang on to per live terminal. The unlisten callbacks are
 *  the Tauri-event subscribers we set up at spawn time — we keep them
 *  so a future `disposeSession` can shut them down cleanly. */
export type TerminalSession = {
  sessionId: string;
  term: Terminal;
  fit: FitAddon;
  webgl: WebglAddon | null;
  /** Unlisten for `pty:{id}:data`. */
  unlistenData: () => void;
  /** Unlisten for `pty:{id}:exit`. */
  unlistenExit: () => void;
  /** True once the PTY has emitted its exit event. The UI uses this to
   *  decide whether to show Quick Prompts (only when alive) and whether
   *  the tab title should carry "(exited)". */
  exited: boolean;
  /** Promise that resolves once `pty_spawn` returns. Lets the pane
   *  component await spawn completion when it needs to know shell kind
   *  for the tab title. */
  spawnPromise: Promise<{ shellPath: string; shellKind: string }>;
  /** Number of characters the Quick Prompts strip last typed into this
   *  session. Used to compute how many backspaces to send before the
   *  NEXT chip's text so chips replace each other cleanly instead of
   *  stacking. Reset to 0 whenever the user types anything (we don't
   *  want to backspace over their input). Reset to 0 after a newline is
   *  written too (a fresh prompt line resets the editing scope).
   *
   *  Why backspaces and not Ctrl-U (\x15): PowerShell and cmd don't
   *  honour Ctrl-U as kill-to-start-of-line — they type the literal `^U`
   *  characters. Backspace, by contrast, is a universal "delete one char
   *  to the left" in every shell line editor (readline, PSReadLine, cmd
   *  COOKED mode). */
  lastChipTypedLength: number;
};

const registry = new Map<string, TerminalSession>();

export function getSession(sessionId: string): TerminalSession | undefined {
  return registry.get(sessionId);
}

export function registerSession(s: TerminalSession): void {
  registry.set(s.sessionId, s);
}

export function disposeSession(sessionId: string): void {
  const s = registry.get(sessionId);
  if (!s) return;
  registry.delete(sessionId);
  try {
    s.unlistenData();
  } catch {
    // ignore
  }
  try {
    s.unlistenExit();
  } catch {
    // ignore
  }
  try {
    s.term.dispose();
  } catch {
    // ignore — addon disposal can throw on partial mounts
  }
}

/** Iterate over all known sessions. The Phase 6 app-close path could
 *  use this to call `pty_kill` on each, though today it's the Rust
 *  side that handles app shutdown via PtyState::kill_all. */
export function knownSessionIds(): string[] {
  return Array.from(registry.keys());
}

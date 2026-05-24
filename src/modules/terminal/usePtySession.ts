import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * Thin wrappers around the four PTY commands in `src-tauri/src/modules/pty.rs`.
 * The TerminalPane component drives this — there's no React state in here on
 * purpose. xterm.js owns the viewport state, the PTY backend owns the session
 * state, and this file is just the IPC seam between them.
 */

export type ShellCandidate = {
  id: string;
  label: string;
  path: string;
  kind: string;
};

export type PtySpawnInput = {
  sessionId: string;
  shellPath?: string | null;
  cwd?: string | null;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
};

export type PtySpawnResult = {
  sessionId: string;
  shellPath: string;
  shellKind: string;
};

export type PtyExitEvent = {
  /** Process exit code, when available. Null when the wait failed or the
   *  shell was killed before we could capture it. */
  exitCode: number | null;
  /** True when `pty_kill` was issued — the UI uses this to distinguish a
   *  clean shell exit from a force-close. */
  killed: boolean;
};

export type PtyDataEvent = {
  /** Base64-encoded chunk. Decode to Uint8Array before piping into
   *  `xterm.write(...)`. */
  data: string;
};

export async function spawnPty(input: PtySpawnInput): Promise<PtySpawnResult> {
  return invoke<PtySpawnResult>("pty_spawn", { input });
}

export async function writePty(sessionId: string, dataBase64: string): Promise<void> {
  await invoke("pty_write", {
    input: { sessionId, data: dataBase64 },
  });
}

export async function resizePty(
  sessionId: string,
  cols: number,
  rows: number,
): Promise<void> {
  await invoke("pty_resize", {
    input: { sessionId, cols, rows },
  });
}

export async function killPty(sessionId: string): Promise<void> {
  await invoke("pty_kill", { input: { sessionId } });
}

export async function listenPtyData(
  sessionId: string,
  cb: (payload: PtyDataEvent) => void,
): Promise<UnlistenFn> {
  return listen<PtyDataEvent>(`pty:${sessionId}:data`, (e) => cb(e.payload));
}

export async function listenPtyExit(
  sessionId: string,
  cb: (payload: PtyExitEvent) => void,
): Promise<UnlistenFn> {
  return listen<PtyExitEvent>(`pty:${sessionId}:exit`, (e) => cb(e.payload));
}

// ────────────────────────────────────────────────────────────────────────
// Base64 helpers — small, browser-native, no external dep.
//
// xterm.js's `onData` fires with a JavaScript string (UTF-16). For keystrokes
// that's fine — they round-trip cleanly. But a paste from the OS clipboard
// might include surrogate halves or non-printable bytes; encoding via
// TextEncoder + base64 keeps the wire payload aligned with what the Rust
// side expects (it base64-decodes straight to bytes and writes to the PTY).
// ────────────────────────────────────────────────────────────────────────

/** UTF-8 encode a string and base64-encode the bytes. */
export function encodeForPty(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  // chunked because `String.fromCharCode(...arr)` blows the call stack at
  // ~64k args on V8. 8k chunks are fine and the overhead is negligible.
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Decode a base64 payload from the PTY into a Uint8Array suitable for
 *  `xterm.write(...)`. xterm accepts both strings and Uint8Arrays — we use
 *  bytes so escape sequences with high-bit characters render correctly. */
export function decodeFromPty(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

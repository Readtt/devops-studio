import { Channel, invoke } from "@tauri-apps/api/core";

/** Result of the cross-platform git-install probe (Rust `git_check_installed`). */
export type GitInstalled = {
  installed: boolean;
  /** A git path was found but isn't usable (macOS stub without CLT, bad
   *  `--version`). Shown with install guidance, same as `installed: false`. */
  presentButBroken: boolean;
  version: string | null;
  path: string | null;
};

export type CloneAuth =
  | { kind: "adoPat" }
  | { kind: "basic"; username: string; password: string }
  | { kind: "none" };

/** Streamed while a clone runs. `pct` is null until git reports a percentage. */
export type CloneProgress = { kind: "phase"; phase: string; pct: number | null };

export type CloneStatus =
  | "cloned"
  | "no-git"
  | "auth-failed"
  | "offline"
  | "exists"
  | "cancelled"
  | "error";

export type GitCloneResult = {
  status: CloneStatus;
  path: string | null;
  message: string;
};

export type CloneArgs = {
  url: string;
  destParent: string;
  dirName: string;
  auth: CloneAuth;
  /** Persist credentials (seed the OS credential helper, else write a scoped
   *  http.extraHeader) so later pulls succeed. */
  persistAuth: boolean;
  requestId: number;
};

/** Detect whether git is usable on this machine (probes install locations, not
 *  just PATH, since a GUI-launched app doesn't inherit the shell PATH). */
export async function checkGitInstalled(): Promise<GitInstalled> {
  return invoke<GitInstalled>("git_check_installed");
}

/** Set (or clear, with null) the manual git-executable override, then re-probe. */
export async function setGitPath(path: string | null): Promise<GitInstalled> {
  return invoke<GitInstalled>("git_set_path", { path });
}

/** Clone a repo, streaming progress. Resolves with the terminal outcome. */
export async function cloneRepo(
  args: CloneArgs,
  onProgress: (p: CloneProgress) => void,
): Promise<GitCloneResult> {
  const channel = new Channel<CloneProgress>();
  channel.onmessage = onProgress;
  return invoke<GitCloneResult>("git_clone", {
    url: args.url,
    destParent: args.destParent,
    dirName: args.dirName,
    auth: args.auth,
    persistAuth: args.persistAuth,
    requestId: args.requestId,
    onEvent: channel,
  });
}

/** Ask the backend to kill an in-flight clone. Safe to call after it ended. */
export async function cancelClone(requestId: number): Promise<void> {
  await invoke("git_clone_cancel", { requestId }).catch(() => {
    /* clone already finished — registry entry is gone */
  });
}

// Monotonic id linking a clone to its Rust-side cancel handle.
let nextCloneRequestId = 1;
export function nextCloneId(): number {
  return nextCloneRequestId++;
}

import { invoke } from "@tauri-apps/api/core";

let cached: string | undefined;

export async function initLaunchDir(): Promise<void> {
  const dir = await invoke<string | null>("get_launch_dir").catch(() => null);
  cached = dir ? dir.replace(/\\/g, "/") : undefined;
}

export function getLaunchDir(): string | undefined {
  return cached;
}

/** Return the launch dir and clear it, so it's applied exactly once (e.g. as
 *  the source root at startup). Consuming it means a later re-hydration can't
 *  replay the launched folder over a source the user has since changed. */
export function consumeLaunchDir(): string | undefined {
  const v = cached;
  cached = undefined;
  return v;
}

// One shared git poll per reader, for every subscriber in the window.
//
// Each of these reads is a git SUBPROCESS per repo — on Windows a full
// CreateProcess. Polling per component multiplied that by however many
// consumers happened to be mounted: the status bar, every open generator tab in
// its input phase, every confidence panel, the Settings repo list. At ten repos
// and five consumers a single 30 s tick was fifty spawns, and a branch switch
// (which fires `source-git-changed` two or three times) several times that.
//
// Same pattern, and the same reason, as `terminalRegistry`: the expensive thing
// lives outside React and components attach to it. Kept out of the hook file so
// the sharing rules can be tested without rendering anything.

import { getCurrentWindow } from "@tauri-apps/api/window";

import { sameRoot } from "@/modules/settings/store";
import { onSourceGitChanged } from "./gitOps";

export const REFRESH_MS = 30_000;

type Reader<T> = (root: string) => Promise<T>;

type Channel<T> = {
  read: Reader<T>;
  empty: T;
  /** Replaced wholesale on every update, never mutated — subscribers compare
   *  by identity to decide whether to re-render. */
  values: Map<string, T>;
  subscribers: Map<symbol, { roots: string[]; notify: () => void }>;
  timer: number | null;
  unlistenFocus: (() => void) | null;
  unlistenGit: (() => void) | null;
};

/** Keyed by the reader function, which is why those must be module-level
 *  constants. Entries outlive their last subscriber so a remounted pane paints
 *  the last known branch instead of a skeleton; only the timers stop. */
const channels = new Map<unknown, Channel<unknown>>();

function channelFor<T>(read: Reader<T>, empty: T): Channel<T> {
  const existing = channels.get(read) as Channel<T> | undefined;
  if (existing) return existing;
  const created: Channel<T> = {
    read,
    empty,
    values: new Map(),
    subscribers: new Map(),
    timer: null,
    unlistenFocus: null,
    unlistenGit: null,
  };
  channels.set(read, created as Channel<unknown>);
  return created;
}

/** Every root any current subscriber cares about, deduped. */
function subscribedRoots<T>(channel: Channel<T>): string[] {
  const out = new Set<string>();
  for (const { roots } of channel.subscribers.values()) {
    for (const root of roots) out.add(root);
  }
  return [...out];
}

async function refreshChannel<T>(channel: Channel<T>, only?: string | string[]) {
  const all = subscribedRoots(channel);
  const wanted = only === undefined ? null : Array.isArray(only) ? only : [only];
  const targets = wanted
    ? all.filter((r) => wanted.some((w) => sameRoot(r, w)))
    : all;
  if (targets.length === 0) return;
  const results = await Promise.all(
    targets.map((root) =>
      channel
        .read(root)
        .then((v) => v ?? channel.empty)
        .catch(() => channel.empty),
    ),
  );
  if (channel.subscribers.size === 0) return;
  const next = new Map(channel.values);
  targets.forEach((root, i) => next.set(root, results[i]));
  // Recomputed rather than reusing `all`: a repo can leave the registry while
  // its own read is in flight, and its stale value must not survive.
  const live = new Set(subscribedRoots(channel));
  for (const root of next.keys()) {
    if (!live.has(root)) next.delete(root);
  }
  channel.values = next;
  for (const { notify } of channel.subscribers.values()) notify();
}

function startChannel<T>(channel: Channel<T>) {
  channel.timer = window.setInterval(() => void refreshChannel(channel), REFRESH_MS);
  // Focus catches branch switches made in an external terminal.
  void getCurrentWindow()
    .onFocusChanged(({ payload: focused }) => {
      if (focused) void refreshChannel(channel);
    })
    .then((un) => {
      if (channel.subscribers.size === 0) un();
      else channel.unlistenFocus = un;
    })
    .catch(() => {});
  channel.unlistenGit = onSourceGitChanged((root) => void refreshChannel(channel, root));
}

function stopChannel<T>(channel: Channel<T>) {
  if (channel.timer !== null) window.clearInterval(channel.timer);
  channel.timer = null;
  channel.unlistenFocus?.();
  channel.unlistenFocus = null;
  channel.unlistenGit?.();
  channel.unlistenGit = null;
}

/**
 * Subscribe to `read` for `roots`, sharing one poll with every other
 * subscriber. Returns the channel's current values plus an unsubscribe.
 *
 * Reads only the roots nobody has a value for yet, so mounting a fifth consumer
 * of an already-polled repo costs zero subprocesses. `read` must be a
 * module-level constant — it is the channel's identity.
 */
export function subscribeRootPoll<T>(
  read: Reader<T>,
  empty: T,
  roots: string[],
  notify: (values: Map<string, T>) => void,
): { values: Map<string, T>; unsubscribe: () => void } {
  const channel = channelFor(read, empty);
  const id = Symbol("poll");
  channel.subscribers.set(id, { roots, notify: () => notify(channel.values) });
  // Guarded on the timer, not on "am I the first subscriber": a first
  // subscriber that had no repos yet leaves the channel idle, and the one that
  // brings roots has to be what starts it.
  if (channel.timer === null && subscribedRoots(channel).length > 0) {
    startChannel(channel);
  }

  // Fill only the gaps — one refresh for the whole set, so N new roots is one
  // batch of reads rather than N racing passes.
  const missing = roots.filter((root) => !channel.values.has(root));
  if (missing.length > 0) void refreshChannel(channel, missing);

  return {
    values: channel.values,
    unsubscribe: () => {
      channel.subscribers.delete(id);
      if (channel.subscribers.size === 0) stopChannel(channel);
    },
  };
}

/** Drop every channel. Tests only — the registry is process-lifetime state. */
export function __resetRootPolls() {
  for (const channel of channels.values()) stopChannel(channel as Channel<unknown>);
  channels.clear();
}

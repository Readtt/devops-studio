// Where the live model catalogue lives, and how both windows see the same one.
//
// Its own store file, not the settings file: a few hundred OpenRouter listings
// are ~150 KB of cache, and the settings file — which holds the repo registry
// and the ADO binding — is rewritten whole on every settings change.
//
// One writer: the main window. Settings' "Check now" asks it to run the check
// (`requestModelCatalogCheck`) instead of writing itself, and hears back when
// it's done (`onModelCatalogCheckFinished`). Two windows each reading the
// catalogue, checking providers and writing the whole thing back would let the
// later write erase the earlier one's results.
//
// Both windows hold the same store resource (the plugin shares one per path
// across windows), so a re-read sees the writer's latest `set` even before it
// reaches disk. What each window needs is to know WHEN to re-read: the writer
// emits CHANGED_EVENT with a stamp that only ever goes up, and a window ignores
// any stamp it has already seen or passed — including its own echo, and a slow
// re-read that would otherwise land after a newer one.

import { create } from "zustand";
import { LazyStore } from "@tauri-apps/plugin-store";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  discoveredModelsForCatalog,
  normalizeModelCatalog,
  setDiscoveredModels,
  type ModelCatalog,
} from "../config";

const STORE_PATH = "devops-studio-models.json";
const KEY = "catalog";
const CHANGED_EVENT = "devops-studio://model-catalog-changed";
const CHECK_REQUESTED_EVENT = "devops-studio://model-catalog-check-requested";
const CHECK_FINISHED_EVENT = "devops-studio://model-catalog-check-finished";

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: false });

type State = {
  catalog: ModelCatalog;
  hydrated: boolean;
  /** Load the saved catalogue and follow the writer's changes. Idempotent. */
  init: () => Promise<void>;
};

let initialized = false;
/** Newest stamp this window has loaded or written. */
let seenStamp = 0;

export const useModelCatalogStore = create<State>(() => ({
  catalog: {},
  hydrated: false,
  init: async () => {
    if (initialized) return;
    initialized = true;
    // Listen BEFORE the first read: a save landing between the two would
    // otherwise go unseen until the next one, up to 12 h later.
    await listen<{ stamp?: number } | null>(CHANGED_EVENT, (e) => {
      const stamp = e.payload?.stamp;
      if (typeof stamp === "number" && stamp <= seenStamp) return;
      void reload();
    });
    await reload();
  },
}));

async function reload(): Promise<void> {
  let raw: unknown;
  try {
    raw = await store.get(KEY);
  } catch {
    raw = undefined;
  }
  const doc = raw as { stamp?: unknown; catalog?: unknown } | undefined;
  const stamp = typeof doc?.stamp === "number" ? doc.stamp : 0;
  // A re-read that raced a newer save and came back with the older value must
  // not move this window backwards. (The first load always applies.)
  if (useModelCatalogStore.getState().hydrated && stamp < seenStamp) return;
  seenStamp = Math.max(seenStamp, stamp);
  useModelCatalogStore.setState({
    catalog: normalizeModelCatalog(doc?.catalog),
    hydrated: true,
  });
}

// Registered at module load, so it runs before any component re-renders on the
// same change: `getModel` answers with a model's real listing by the time a
// picker asks.
useModelCatalogStore.subscribe((state, prev) => {
  if (state.catalog !== prev.catalog) {
    setDiscoveredModels(discoveredModelsForCatalog(state.catalog));
  }
});

/** Persist a new catalogue and tell every window. Main window only. */
export async function saveModelCatalog(catalog: ModelCatalog): Promise<void> {
  // Strictly increasing, even for two saves inside one millisecond or across a
  // clock step back — windows use it to tell newer from older.
  const stamp = Math.max(Date.now(), seenStamp + 1);
  seenStamp = stamp;
  useModelCatalogStore.setState({ catalog });
  await store.set(KEY, { stamp, catalog });
  try {
    await store.save();
  } finally {
    // The shared store already holds the new value; tell the other window even
    // if writing it to disk failed (the app retries the save on exit).
    await emit(CHANGED_EVENT, { stamp });
  }
}

/** Ask the main window to re-read every connected provider's list now. */
export async function requestModelCatalogCheck(): Promise<void> {
  await emit(CHECK_REQUESTED_EVENT);
}

export function onModelCatalogCheckRequested(
  cb: () => void,
): Promise<UnlistenFn> {
  return listen(CHECK_REQUESTED_EVENT, () => cb());
}

/** The main window's answer to a check request — sent when the check is done,
 *  or at once when there was nothing it could check. */
export async function announceModelCatalogCheckFinished(): Promise<void> {
  await emit(CHECK_FINISHED_EVENT);
}

export function onModelCatalogCheckFinished(
  cb: () => void,
): Promise<UnlistenFn> {
  return listen(CHECK_FINISHED_EVENT, () => cb());
}

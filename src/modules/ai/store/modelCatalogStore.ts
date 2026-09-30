// Where the live model catalogue lives, and how both windows see the same one.
//
// Its own store file, not the settings file: a few hundred OpenRouter listings
// are ~150 KB of cache, and the settings file — which holds the repo registry
// and the ADO binding — is rewritten whole on every settings change.
//
// One writer: the main window. Settings' "Check now" asks it to run the check
// (`requestModelCatalogCheck`) instead of writing itself. Two windows each
// reading the catalogue, checking providers and writing the whole thing back
// would let the later write erase the earlier one's results.
//
// Every window re-reads the file when the writer says it changed. The shared
// store's own change notifications aren't relied on for that — they don't
// cross windows the way the app needs (see settings/store.ts's writePref).

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

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: false });

type State = {
  catalog: ModelCatalog;
  hydrated: boolean;
  /** Load the saved catalogue and follow the writer's changes. Idempotent. */
  init: () => Promise<void>;
};

let initialized = false;
/** Stamp of the last catalogue this window loaded or wrote. The writer hears
 *  its own change event too; matching stamps skip the redundant re-read. */
let seenStamp: number | null = null;

export const useModelCatalogStore = create<State>(() => ({
  catalog: {},
  hydrated: false,
  init: async () => {
    if (initialized) return;
    initialized = true;
    await reload();
    void listen<{ stamp?: number } | null>(CHANGED_EVENT, (e) => {
      const stamp = e.payload?.stamp ?? null;
      if (stamp !== null && stamp === seenStamp) return;
      void reload();
    });
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
  seenStamp = typeof doc?.stamp === "number" ? doc.stamp : null;
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
  const stamp = Date.now();
  seenStamp = stamp;
  useModelCatalogStore.setState({ catalog });
  await store.set(KEY, { stamp, catalog });
  await store.save();
  await emit(CHANGED_EVENT, { stamp });
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

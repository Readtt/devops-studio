// The main window's side of the model catalogue: when to run a refresh pass
// without being asked, and running the one Settings asks for. The main window
// is the catalogue's only writer (see modelCatalogStore.ts).

import { DISCOVERABLE_PROVIDERS, type DiscoverableProvider } from "../config";
import { useChatStore } from "../store/chatStore";
import {
  announceModelCatalogCheckFinished,
  onModelCatalogCheckRequested,
  useModelCatalogStore,
} from "../store/modelCatalogStore";
import { refreshModelCatalog, type Keys } from "./modelCatalog";

/** How often an open app re-checks staleness. The check itself is free; a
 *  list is only fetched once it's due (see modelCatalog.ts). */
const STALENESS_CHECK_EVERY_MS = 60 * 60 * 1000;

/** Providers whose saved list should go: they have one, and their key is gone.
 *
 *  Only on a read that still has SOME key. The keychain can't tell "removed"
 *  from "couldn't read" — every error comes back as no key — and a failed read
 *  loses all of them at once, which no single removal does. So a read with no
 *  keys at all drops nothing. The cost: removing your last key leaves its list
 *  behind, unused (the pickers only offer providers you have a key for). */
export function providersToDrop(keys: Keys): DiscoverableProvider[] {
  const anyKey = DISCOVERABLE_PROVIDERS.some((p) => keys[p]?.trim());
  if (!anyKey) return [];
  return DISCOVERABLE_PROVIDERS.filter((p) => !keys[p]?.trim());
}

/** Keep the catalogue current from this window: once the saved catalogue and
 *  the keys are both loaded, on any key change (fetching just the providers
 *  whose key changed), hourly for anything due, and whenever Settings asks —
 *  answering Settings when that check is done. Returns the stop. */
export function startModelCatalogSync(): () => void {
  let stopped = false;
  let seenKeys: Keys | null = null;

  const ready = () =>
    !stopped &&
    useChatStore.getState().keysLoaded &&
    useModelCatalogStore.getState().hydrated;

  /** Resolves when the pass is done, or at once when it couldn't run. */
  const refresh = (
    force?: boolean | readonly DiscoverableProvider[],
  ): Promise<unknown> => {
    if (!ready()) return Promise.resolve();
    const keys = useChatStore.getState().apiKeys;
    return refreshModelCatalog({
      keys,
      force,
      drop: providersToDrop(keys),
    }).catch(() => undefined);
  };

  const onKeys = () => {
    const { keysLoaded, apiKeys } = useChatStore.getState();
    if (!keysLoaded) return;
    if (!seenKeys) {
      seenKeys = apiKeys;
      void refresh();
      return;
    }
    const before = seenKeys;
    seenKeys = apiKeys;
    const changed = DISCOVERABLE_PROVIDERS.filter(
      (p) => (apiKeys[p] ?? null) !== (before[p] ?? null),
    );
    if (changed.length > 0) void refresh(changed.filter((p) => !!apiKeys[p]));
  };

  const unsubKeys = useChatStore.subscribe((s, prev) => {
    if (s.apiKeys !== prev.apiKeys || s.keysLoaded !== prev.keysLoaded) onKeys();
  });
  const unsubCatalog = useModelCatalogStore.subscribe((s, prev) => {
    if (s.hydrated && !prev.hydrated) void refresh();
  });
  let unlistenCheck: (() => void) | undefined;
  void onModelCatalogCheckRequested(() => {
    void refresh(true).finally(() => {
      void announceModelCatalogCheckFinished().catch(() => undefined);
    });
  }).then((un) => {
    if (stopped) un();
    else unlistenCheck = un;
  });
  onKeys();
  const timer = setInterval(() => void refresh(), STALENESS_CHECK_EVERY_MS);

  return () => {
    stopped = true;
    unsubKeys();
    unsubCatalog();
    unlistenCheck?.();
    clearInterval(timer);
  };
}

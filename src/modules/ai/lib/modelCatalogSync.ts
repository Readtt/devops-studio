// The main window's side of the model catalogue: when to run a refresh pass
// without being asked. Separate from modelCatalog.ts so the Settings window —
// which only ever refreshes on "Check now" — doesn't load the chat store.

import { DISCOVERABLE_PROVIDERS, type DiscoverableProvider } from "../config";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { useChatStore } from "../store/chatStore";
import { refreshModelCatalog, type Keys } from "./modelCatalog";

/** How often an open app re-checks staleness. The check itself is free; a
 *  list is only fetched once it's past CATALOG_STALE_AFTER_MS. */
const STALENESS_CHECK_EVERY_MS = 60 * 60 * 1000;

/** Keep the catalogue current from this window: once keys and preferences are
 *  both loaded, on any key change (just the providers whose key changed), and
 *  hourly for anything gone stale. Main window only. Returns the stop. */
export function startModelCatalogSync(): () => void {
  let stopped = false;
  let seenKeys: Keys | null = null;

  const refresh = (force?: readonly DiscoverableProvider[]) => {
    const { keysLoaded, apiKeys } = useChatStore.getState();
    if (stopped || !keysLoaded || !usePreferencesStore.getState().hydrated) {
      return;
    }
    void refreshModelCatalog({ keys: apiKeys, force }).catch(() => undefined);
  };

  const onKeys = () => {
    const { keysLoaded, apiKeys } = useChatStore.getState();
    if (!keysLoaded) return;
    if (!seenKeys) {
      seenKeys = apiKeys;
      refresh();
      return;
    }
    const before = seenKeys;
    const changedKeys = DISCOVERABLE_PROVIDERS.filter(
      (p) => (apiKeys[p] ?? null) !== (before[p] ?? null),
    );
    seenKeys = apiKeys;
    if (changedKeys.length > 0) refresh(changedKeys);
  };

  const unsubKeys = useChatStore.subscribe((s, prev) => {
    if (s.apiKeys !== prev.apiKeys || s.keysLoaded !== prev.keysLoaded) onKeys();
  });
  const unsubPrefs = usePreferencesStore.subscribe((s, prev) => {
    if (s.hydrated && !prev.hydrated) refresh();
  });
  onKeys();
  const timer = window.setInterval(() => refresh(), STALENESS_CHECK_EVERY_MS);

  return () => {
    stopped = true;
    unsubKeys();
    unsubPrefs();
    window.clearInterval(timer);
  };
}

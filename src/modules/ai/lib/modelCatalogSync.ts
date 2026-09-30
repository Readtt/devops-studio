// The main window's side of the model catalogue: when to run a refresh pass
// without being asked, and running the one Settings asks for. The main window
// is the catalogue's only writer (see modelCatalogStore.ts).

import { DISCOVERABLE_PROVIDERS, type DiscoverableProvider } from "../config";
import { useChatStore } from "../store/chatStore";
import {
  onModelCatalogCheckRequested,
  useModelCatalogStore,
} from "../store/modelCatalogStore";
import { refreshModelCatalog, type Keys } from "./modelCatalog";

/** How often an open app re-checks staleness. The check itself is free; a
 *  list is only fetched once it's due (see modelCatalog.ts). */
const STALENESS_CHECK_EVERY_MS = 60 * 60 * 1000;

/** Keep the catalogue current from this window: once the saved catalogue and
 *  the keys are both loaded, on any key change (fetching just the providers
 *  whose key changed, dropping those whose key was removed), hourly for
 *  anything due, and whenever Settings asks. Returns the stop. */
export function startModelCatalogSync(): () => void {
  let stopped = false;
  let seenKeys: Keys | null = null;

  const ready = () =>
    !stopped &&
    useChatStore.getState().keysLoaded &&
    useModelCatalogStore.getState().hydrated;

  const refresh = (
    opts: {
      force?: boolean | readonly DiscoverableProvider[];
      drop?: readonly DiscoverableProvider[];
    } = {},
  ) => {
    if (!ready()) return;
    const keys = useChatStore.getState().apiKeys;
    void refreshModelCatalog({ keys, ...opts }).catch(() => undefined);
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
    seenKeys = apiKeys;
    const changed = DISCOVERABLE_PROVIDERS.filter(
      (p) => (apiKeys[p] ?? null) !== (before[p] ?? null),
    );
    if (changed.length === 0) return;
    // A key seen this session and now gone was removed on purpose; one that
    // was never seen may just not have loaded, and must not cost its list.
    const drop = changed.filter((p) => before[p] && !apiKeys[p]);
    const force = changed.filter((p) => !!apiKeys[p]);
    refresh({ force, drop });
  };

  const unsubKeys = useChatStore.subscribe((s, prev) => {
    if (s.apiKeys !== prev.apiKeys || s.keysLoaded !== prev.keysLoaded) onKeys();
  });
  const unsubCatalog = useModelCatalogStore.subscribe((s, prev) => {
    if (s.hydrated && !prev.hydrated) refresh();
  });
  let unlistenCheck: (() => void) | undefined;
  void onModelCatalogCheckRequested(() => refresh({ force: true })).then((un) => {
    if (stopped) un();
    else unlistenCheck = un;
  });
  onKeys();
  const timer = window.setInterval(() => refresh(), STALENESS_CHECK_EVERY_MS);

  return () => {
    stopped = true;
    unsubKeys();
    unsubCatalog();
    unlistenCheck?.();
    window.clearInterval(timer);
  };
}

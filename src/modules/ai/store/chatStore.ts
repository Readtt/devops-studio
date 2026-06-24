import { create } from "zustand";
import {
  DEFAULT_MODEL_ID,
  getModel,
  providerNeedsKey,
  type ModelId,
  type ProviderId,
} from "../config";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setDefaultModel, onKeysChanged } from "@/modules/settings/store";
import {
  EMPTY_PROVIDER_KEYS,
  getAllKeys,
  type ProviderKeys,
} from "../lib/keyring";
import { pushRecentModel } from "../lib/modelPrefs";

// Pared down to a model + API-key holder. The general chat/agent surface
// (sessions, transport, plan/todo stores, personas) was removed when the app
// consolidated on the four read-only BYOK surfaces (Generator, Suite Chat,
// Code Review, Confidence). Each of those owns its own run loop; all they need
// from here is the selected model and the provider keys.
type StoreState = {
  apiKeys: ProviderKeys;
  /** True once the OS-keychain keys have been read into the store at least
   *  once. Stays false on a cold start until `initApiKeys` resolves, so the
   *  run surfaces can tell "keys not loaded yet" apart from "key missing". */
  keysLoaded: boolean;
  setApiKeys: (keys: ProviderKeys) => void;
  setApiKey: (provider: ProviderId, key: string | null) => void;
  /** Hydrate `apiKeys` from the OS keychain and keep them live by re-reading
   *  whenever the Settings window saves or clears a key. Call exactly once at
   *  app boot (App.tsx). Returns the unlisten for the keys-changed
   *  subscription so the caller can detach on unmount.
   *
   *  This is THE source that the four BYOK surfaces (Generator, Suite Chat,
   *  Commit Review, Confidence) read from at run time — without it every
   *  key-requiring provider reports a false "missing key". */
  initApiKeys: () => Promise<() => void>;
  /** Return the provider keys, first awaiting the keychain hydration if it
   *  hasn't completed. Run surfaces call THIS rather than reading `apiKeys`
   *  directly, so a run dispatched in the brief cold-start window (before
   *  `initApiKeys` resolves) can't read the all-null placeholder and report a
   *  false "missing key". After hydration it resolves instantly. */
  ensureApiKeys: () => Promise<ProviderKeys>;

  selectedModelId: ModelId;
  setSelectedModelId: (id: ModelId) => void;
};

export const useChatStore = create<StoreState>((set, get) => ({
  apiKeys: { ...EMPTY_PROVIDER_KEYS },
  keysLoaded: false,
  setApiKeys: (keys) => set({ apiKeys: keys, keysLoaded: true }),
  setApiKey: (provider, key) => {
    set({ apiKeys: { ...get().apiKeys, [provider]: key } });
  },
  initApiKeys: async () => {
    await reloadApiKeys();
    // Re-hydrate whenever a key is saved/cleared in the Settings window, so a
    // freshly-pasted key works in the open main window without a restart.
    return onKeysChanged(() => {
      void reloadApiKeys();
    });
  },
  ensureApiKeys: async () => {
    if (!get().keysLoaded) await (hydrationPromise ?? reloadApiKeys());
    return get().apiKeys;
  },

  selectedModelId: DEFAULT_MODEL_ID,
  setSelectedModelId: (id) => {
    // Single source of truth: the persisted default-model preference. Status
    // bar, settings, and the generator's per-run picker all read from the
    // same place, so writing through here is what keeps them coherent. The
    // preferences subscription below mirrors back into `selectedModelId`
    // (and into other windows via the prefs-changed Tauri event).
    set({ selectedModelId: id });
    void pushRecentModel(id);
    void setDefaultModel(id);
  },
}));

// Shared keychain loader. Module-level so boot hydration (initApiKeys) and a
// cold-start run (ensureApiKeys) share ONE in-flight fetch instead of racing
// two reads. `hydrationPromise` holds the latest load so concurrent callers
// await the same work; the keys-changed listener resets it on each save.
let hydrationPromise: Promise<void> | null = null;
function reloadApiKeys(): Promise<void> {
  hydrationPromise = (async () => {
    try {
      const keys = await getAllKeys();
      useChatStore.setState({ apiKeys: keys, keysLoaded: true });
    } catch {
      // Keychain unreadable (locked / denied) — mark loaded so callers stop
      // waiting; the per-run guard still catches an actually-missing key.
      useChatStore.setState({ keysLoaded: true });
    }
  })();
  return hydrationPromise;
}

export function getActiveProviderKey(): string | null {
  const { selectedModelId, apiKeys } = useChatStore.getState();
  return apiKeys[getModel(selectedModelId).provider] ?? null;
}

export function hasKeyForModel(modelId: ModelId): boolean {
  const { apiKeys } = useChatStore.getState();
  const provider = getModel(modelId).provider;
  return providerNeedsKey(provider) ? !!apiKeys[provider] : true;
}

// Mirror preferences.defaultModelId → chatStore.selectedModelId. This makes
// the chat store a live read-through of the persisted default: when the
// settings window writes a new default (or hydration completes), the status
// bar and generator pick it up without an explicit refresh. Writes from
// `setSelectedModelId` already go the other direction via setDefaultModel().
let lastSyncedDefault: ModelId | null = null;
usePreferencesStore.subscribe((state) => {
  const next = state.defaultModelId;
  if (next === lastSyncedDefault) return;
  lastSyncedDefault = next;
  if (useChatStore.getState().selectedModelId !== next) {
    useChatStore.setState({ selectedModelId: next });
  }
});

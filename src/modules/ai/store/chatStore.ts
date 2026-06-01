import { create } from "zustand";
import {
  DEFAULT_MODEL_ID,
  getModel,
  providerNeedsKey,
  type ModelId,
  type ProviderId,
} from "../config";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setDefaultModel } from "@/modules/settings/store";
import { EMPTY_PROVIDER_KEYS, type ProviderKeys } from "../lib/keyring";
import { pushRecentModel } from "../lib/modelPrefs";

// Pared down to a model + API-key holder. The general chat/agent surface
// (sessions, transport, plan/todo stores, personas) was removed when the app
// consolidated on the four read-only BYOK surfaces (Generator, Suite Chat,
// Code Review, Confidence). Each of those owns its own run loop; all they need
// from here is the selected model and the provider keys.
type StoreState = {
  apiKeys: ProviderKeys;
  setApiKeys: (keys: ProviderKeys) => void;
  setApiKey: (provider: ProviderId, key: string | null) => void;

  selectedModelId: ModelId;
  setSelectedModelId: (id: ModelId) => void;
};

export const useChatStore = create<StoreState>((set, get) => ({
  apiKeys: { ...EMPTY_PROVIDER_KEYS },
  setApiKeys: (keys) => set({ apiKeys: keys }),
  setApiKey: (provider, key) => {
    set({ apiKeys: { ...get().apiKeys, [provider]: key } });
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

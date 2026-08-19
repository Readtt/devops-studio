import { create } from "zustand";
import type { LocalProviderConfig } from "@/modules/ai/lib/agent";
import {
  DEFAULT_PREFERENCES,
  loadPreferences,
  onPreferencesChange,
  primaryRepoRoot,
  type Preferences,
  type WorkspaceRepo,
} from "./store";

/** Project the local-provider settings into the shape the AI runner needs to
 *  resolve a local model (LM Studio / MLX / Ollama / OpenAI-compatible). The
 *  surfaces pass this so the runner can resolve the user-configured model id —
 *  without it, a local provider throws "no model id set". */
export function localProviderConfig(p: Preferences): LocalProviderConfig {
  return {
    lmstudioBaseURL: p.lmstudioBaseURL,
    lmstudioModelId: p.lmstudioModelId,
    mlxBaseURL: p.mlxBaseURL,
    mlxModelId: p.mlxModelId,
    ollamaBaseURL: p.ollamaBaseURL,
    ollamaModelId: p.ollamaModelId,
    openaiCompatibleBaseURL: p.openaiCompatibleBaseURL,
    openaiCompatibleModelId: p.openaiCompatibleModelId,
  };
}

type State = Preferences & {
  hydrated: boolean;
  /** Subscribe & hydrate. Idempotent — safe to call from multiple windows. */
  init: () => Promise<void>;
};

let initialized = false;

export const usePreferencesStore = create<State>((set) => ({
  ...DEFAULT_PREFERENCES,
  hydrated: false,
  init: async () => {
    if (initialized) return;
    initialized = true;
    const prefs = await loadPreferences();
    set({ ...prefs, hydrated: true });
    void onPreferencesChange((key, value) => {
      set({ [key]: value } as Partial<State>);
    });
  },
}));

/** The registry, outside React — event handlers and module-level helpers. */
export function getRepos(): WorkspaceRepo[] {
  return usePreferencesStore.getState().repos;
}

/** The single root the pre-registry surfaces read. See `primaryRepoRoot`:
 *  `repos[0]` is a default, not a designation. */
export function usePrimaryRepoRoot(): string | null {
  return usePreferencesStore((s) => primaryRepoRoot(s.repos));
}

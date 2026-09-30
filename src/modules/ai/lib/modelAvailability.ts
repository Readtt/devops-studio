// Reactive availability check for models. A model is "available" when the
// user can actually run it right now — that means the engine accepts the
// model's provider AND the provider is configured (cloud key in keychain,
// or local base URL + model id set). Settings, the status bar and the
// generator all share the same predicate so they agree on what's pickable.

import { useEffect, useMemo, useState } from "react";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  discoveredModelsForCatalog,
  getModel,
  MODELS,
  type ModelId,
  type ModelInfo,
} from "../config";
import { getAllKeys, type ProviderKeys } from "./keyring";
import { onKeysChanged } from "@/modules/settings/store";
import { useModelCatalogStore } from "../store/modelCatalogStore";

/** Every model a picker can offer: the curated list, then whatever the
 *  connected providers' own lists add. Re-renders when a list refresh lands. */
export function useSelectableModels(): readonly ModelInfo[] {
  const catalog = useModelCatalogStore((s) => s.catalog);
  return useMemo(
    () => [...(MODELS as readonly ModelInfo[]), ...discoveredModelsForCatalog(catalog)],
    [catalog],
  );
}

export type ModelAvailability = {
  available: boolean;
  /** Short user-facing reason when unavailable. */
  reason: string | null;
};

type PrefsSnapshot = {
  lmstudioModelId?: string;
  mlxModelId?: string;
  ollamaModelId?: string;
  openaiCompatibleBaseURL?: string;
  openaiCompatibleModelId?: string;
};

export function isModelAvailable(
  modelId: ModelId,
  ctx: { keys: ProviderKeys; prefs: PrefsSnapshot },
): ModelAvailability {
  const m = getModel(modelId);
  const { keys, prefs } = ctx;

  switch (m.provider) {
    case "openai-compatible": {
      const ok =
        !!prefs.openaiCompatibleBaseURL?.trim() &&
        !!prefs.openaiCompatibleModelId?.trim();
      return {
        available: ok,
        reason: ok ? null : "Set base URL and model id in Settings.",
      };
    }
    case "lmstudio": {
      const ok = !!prefs.lmstudioModelId?.trim();
      return {
        available: ok,
        reason: ok ? null : "Set LM Studio model id in Settings.",
      };
    }
    case "mlx": {
      const ok = !!prefs.mlxModelId?.trim();
      return {
        available: ok,
        reason: ok ? null : "Set MLX model id in Settings.",
      };
    }
    case "ollama": {
      const ok = !!prefs.ollamaModelId?.trim();
      return {
        available: ok,
        reason: ok ? null : "Set Ollama model id in Settings.",
      };
    }
    default: {
      const ok = !!keys[m.provider];
      return {
        available: ok,
        reason: ok ? null : `Connect a ${m.provider} key in Settings.`,
      };
    }
  }
}

export type Availability = {
  isAvailable: (id: ModelId) => boolean;
  reason: (id: ModelId) => string | null;
  hasAny: boolean;
  /** Ids of the models that the current configuration can drive. */
  available: ReadonlySet<ModelId>;
};

/** Live availability view. Subscribes to preferences (engine, local cfg) and
 *  to OS-keychain change events so the picker updates the moment a user
 *  pastes a key from the Settings window. */
export function useModelAvailability(): Availability {
  const lmstudioModelId = usePreferencesStore((s) => s.lmstudioModelId);
  const mlxModelId = usePreferencesStore((s) => s.mlxModelId);
  const ollamaModelId = usePreferencesStore((s) => s.ollamaModelId);
  const openaiCompatibleBaseURL = usePreferencesStore(
    (s) => s.openaiCompatibleBaseURL,
  );
  const openaiCompatibleModelId = usePreferencesStore(
    (s) => s.openaiCompatibleModelId,
  );
  const models = useSelectableModels();
  const [keys, setKeys] = useState<ProviderKeys | null>(null);

  useEffect(() => {
    let alive = true;
    void getAllKeys().then((k) => {
      if (alive) setKeys(k);
    });
    const unsubPromise = onKeysChanged(() => {
      void getAllKeys().then((k) => {
        if (alive) setKeys(k);
      });
    });
    return () => {
      alive = false;
      void unsubPromise.then((un) => un());
    };
  }, []);

  const ctx = useMemo(
    () => ({
      keys: keys ?? ({} as ProviderKeys),
      prefs: {
        lmstudioModelId,
        mlxModelId,
        ollamaModelId,
        openaiCompatibleBaseURL,
        openaiCompatibleModelId,
      } satisfies PrefsSnapshot,
    }),
    [
      keys,
      lmstudioModelId,
      mlxModelId,
      ollamaModelId,
      openaiCompatibleBaseURL,
      openaiCompatibleModelId,
    ],
  );
  // Memoised: OpenRouter alone can add hundreds of models, and this hook runs
  // in every picker on every render.
  const available = useMemo(() => {
    const set = new Set<ModelId>();
    if (!keys) return set;
    for (const m of models) {
      if (isModelAvailable(m.id, ctx).available) set.add(m.id);
    }
    return set;
  }, [keys, models, ctx]);

  // By id rather than set membership, so a saved discovered model whose
  // provider hasn't answered yet this launch isn't reported as disconnected.
  const check = (id: ModelId): ModelAvailability | null => {
    try {
      return isModelAvailable(id, ctx);
    } catch {
      return null;
    }
  };

  return {
    // Until keys load (very brief), be permissive so we don't flash an empty
    // picker. The run engine still validates at request time.
    isAvailable: (id) => (keys ? (check(id)?.available ?? false) : true),
    reason: (id) => (keys ? (check(id)?.reason ?? null) : null),
    hasAny: keys ? available.size > 0 : true,
    available,
  };
}

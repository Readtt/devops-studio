// Reactive availability check for models. A model is "available" when the
// user can actually run it right now — that means the engine accepts the
// model's provider AND the provider is configured (cloud key in keychain,
// or local base URL + model id set). Settings, the status bar and the
// generator all share the same predicate so they agree on what's pickable.

import { useEffect, useState } from "react";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { getModel, MODELS, type ModelId } from "../config";
import { getAllKeys, type ProviderKeys } from "./keyring";
import { onKeysChanged } from "@/modules/settings/store";

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

  const prefs: PrefsSnapshot = {
    lmstudioModelId,
    mlxModelId,
    ollamaModelId,
    openaiCompatibleBaseURL,
    openaiCompatibleModelId,
  };

  const ctx = { keys: keys ?? ({} as ProviderKeys), prefs };
  const available = new Set<ModelId>();
  if (keys) {
    for (const m of MODELS) {
      if (isModelAvailable(m.id as ModelId, ctx).available) {
        available.add(m.id as ModelId);
      }
    }
  }

  return {
    // Until keys load (very brief), be permissive so we don't flash an empty
    // picker. The run engine still validates at request time.
    isAvailable: (id) => (keys ? available.has(id) : true),
    reason: (id) =>
      keys ? isModelAvailable(id, ctx).reason : null,
    hasAny: keys ? available.size > 0 : true,
    available,
  };
}

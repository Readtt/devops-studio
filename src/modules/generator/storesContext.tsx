import { createContext, useContext, useEffect, useMemo, useRef } from "react";
import type { MutableRefObject, ReactNode } from "react";
import { useTabsStore } from "@/modules/tabs/store/useTabsStore";
import {
  createGenerationSessionStore,
  type GenerationSessionStore,
} from "./store/useGenerationSession";

type GeneratorStoresApi = {
  /** Live ref to the Map. Kept stable across re-renders so consumers can
   *  pass it straight to the legacy GeneratorStack `storesRef` prop. */
  ref: MutableRefObject<Map<number, GenerationSessionStore>>;
  /** Returns the existing store for a generator tab, or creates a fresh
   *  one (and remembers it) if none exists. The cache survives tab moves
   *  between panes — they key by tabId, not pane id. */
  getOrCreate: (tabId: number) => GenerationSessionStore;
  /** Attach a pre-built store (used when "Open in review" hydrates a
   *  store before the tab even renders). */
  attach: (tabId: number, store: GenerationSessionStore) => void;
  /** Drop a specific tab's store (called explicitly by closeTab paths). */
  detach: (tabId: number) => void;
};

const GeneratorStoresContext = createContext<GeneratorStoresApi | null>(null);

/** Parity with commit-review's disposeTab: a closed tab must not keep an
 *  invisible model run streaming (and billing). cancel() aborts an in-flight
 *  analyze AND flushes a "cancelled" checkpoint — which is exactly what makes
 *  a tab closed mid-run resurface as interrupted in History instead of
 *  vanishing unrecoverably. The cancel actions are tolerant no-ops when
 *  nothing is running. */
function disposeStore(store: GenerationSessionStore): void {
  const s = store.getState();
  s.cancel();
  s.cancelRefine();
  s.cancelChat();
}

export function GeneratorStoresProvider({ children }: { children: ReactNode }) {
  const ref = useRef<Map<number, GenerationSessionStore>>(new Map());

  const api = useMemo<GeneratorStoresApi>(
    () => ({
      ref,
      getOrCreate: (tabId) => {
        let store = ref.current.get(tabId);
        if (!store) {
          store = createGenerationSessionStore();
          ref.current.set(tabId, store);
        }
        return store;
      },
      attach: (tabId, store) => {
        ref.current.set(tabId, store);
      },
      detach: (tabId) => {
        const store = ref.current.get(tabId);
        if (store) disposeStore(store);
        ref.current.delete(tabId);
      },
    }),
    [],
  );

  // Garbage-collect stores whose tabs have disappeared. Subscribes to the
  // tabs store outside React's render cycle so unrelated tab activity
  // doesn't churn this provider.
  useEffect(() => {
    const unsub = useTabsStore.subscribe((state, prev) => {
      if (state.tabs === prev.tabs) return;
      for (const id of Array.from(ref.current.keys())) {
        if (!state.tabs[id]) {
          const store = ref.current.get(id);
          if (store) disposeStore(store);
          ref.current.delete(id);
        }
      }
    });
    return unsub;
  }, []);

  return (
    <GeneratorStoresContext.Provider value={api}>
      {children}
    </GeneratorStoresContext.Provider>
  );
}

export function useGeneratorStoresApi(): GeneratorStoresApi {
  const ctx = useContext(GeneratorStoresContext);
  if (!ctx) {
    throw new Error(
      "useGeneratorStoresApi must be called inside <GeneratorStoresProvider>",
    );
  }
  return ctx;
}

export function useGeneratorStoresRef(): MutableRefObject<
  Map<number, GenerationSessionStore>
> {
  return useGeneratorStoresApi().ref;
}

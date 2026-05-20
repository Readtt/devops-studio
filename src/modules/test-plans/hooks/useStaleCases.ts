import { create } from "zustand";
import {
  scanStaleness,
  toAdoError,
  type AdoError,
  type StaleCaseInfo,
} from "@/modules/ado";

type State = {
  loading: boolean;
  error: AdoError | null;
  cases: StaleCaseInfo[];
  lastScannedAt: number | null;

  scan: () => Promise<void>;
  acknowledge: (caseId: number) => void;
};

export const useStaleCases = create<State>((set, get) => ({
  loading: false,
  error: null,
  cases: [],
  lastScannedAt: null,

  scan: async () => {
    if (get().loading) return;
    set({ loading: true, error: null });
    try {
      const cases = await scanStaleness();
      set({ cases, loading: false, lastScannedAt: Date.now() });
    } catch (e) {
      set({ error: toAdoError(e), loading: false });
    }
  },

  acknowledge: (caseId: number) => {
    set((s) => ({ cases: s.cases.filter((c) => c.caseId !== caseId) }));
  },
}));

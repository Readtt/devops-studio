import { create } from "zustand";
import {
  getConnection,
  listPlans,
  listSuiteCases,
  listSuites,
  toAdoError,
  type AdoError,
  type SuiteRef,
  type TestCaseRef,
  type TestPlanRef,
} from "@/modules/ado";

export type SuiteLoad = {
  loading: boolean;
  error: AdoError | null;
  suites: SuiteRef[];
  cases: Map<number, TestCaseRef[]>;
  loadingCases: Set<number>;
};

type State = {
  initialized: boolean;
  configured: boolean;
  plans: TestPlanRef[];
  plansLoading: boolean;
  plansError: AdoError | null;
  bySuite: Map<number, SuiteLoad>;

  refreshConnection: () => Promise<void>;
  refreshPlans: () => Promise<void>;
  loadSuites: (planId: number) => Promise<void>;
  loadSuiteCases: (planId: number, suiteId: number) => Promise<void>;
  reset: () => void;
};

const initialSuiteLoad = (): SuiteLoad => ({
  loading: false,
  error: null,
  suites: [],
  cases: new Map(),
  loadingCases: new Set(),
});

export const useTestPlans = create<State>((set, get) => ({
  initialized: false,
  configured: false,
  plans: [],
  plansLoading: false,
  plansError: null,
  bySuite: new Map(),

  refreshConnection: async () => {
    try {
      const s = await getConnection();
      set({ configured: s.configured, initialized: true });
      if (s.configured && get().plans.length === 0) {
        await get().refreshPlans();
      }
    } catch {
      set({ configured: false, initialized: true });
    }
  },

  refreshPlans: async () => {
    set({ plansLoading: true, plansError: null });
    try {
      const plans = await listPlans();
      set({ plans, plansLoading: false });
    } catch (e) {
      set({ plansError: toAdoError(e), plansLoading: false });
    }
  },

  loadSuites: async (planId: number) => {
    const curr = get().bySuite.get(planId) ?? initialSuiteLoad();
    if (curr.loading || curr.suites.length > 0) return;
    set((s) => {
      const next = new Map(s.bySuite);
      next.set(planId, { ...curr, loading: true, error: null });
      return { bySuite: next };
    });
    try {
      const suites = await listSuites(planId);
      set((s) => {
        const next = new Map(s.bySuite);
        const prev = next.get(planId) ?? initialSuiteLoad();
        next.set(planId, { ...prev, loading: false, suites });
        return { bySuite: next };
      });
    } catch (e) {
      set((s) => {
        const next = new Map(s.bySuite);
        const prev = next.get(planId) ?? initialSuiteLoad();
        next.set(planId, { ...prev, loading: false, error: toAdoError(e) });
        return { bySuite: next };
      });
    }
  },

  loadSuiteCases: async (planId: number, suiteId: number) => {
    const curr = get().bySuite.get(planId);
    if (curr?.cases.has(suiteId) || curr?.loadingCases.has(suiteId)) return;
    set((s) => {
      const next = new Map(s.bySuite);
      const prev = next.get(planId) ?? initialSuiteLoad();
      const loadingCases = new Set(prev.loadingCases);
      loadingCases.add(suiteId);
      next.set(planId, { ...prev, loadingCases });
      return { bySuite: next };
    });
    try {
      const cases = await listSuiteCases(planId, suiteId);
      set((s) => {
        const next = new Map(s.bySuite);
        const prev = next.get(planId) ?? initialSuiteLoad();
        const casesMap = new Map(prev.cases);
        casesMap.set(suiteId, cases);
        const loadingCases = new Set(prev.loadingCases);
        loadingCases.delete(suiteId);
        next.set(planId, { ...prev, cases: casesMap, loadingCases });
        return { bySuite: next };
      });
    } catch (e) {
      set((s) => {
        const next = new Map(s.bySuite);
        const prev = next.get(planId) ?? initialSuiteLoad();
        const loadingCases = new Set(prev.loadingCases);
        loadingCases.delete(suiteId);
        next.set(planId, {
          ...prev,
          loadingCases,
          error: toAdoError(e),
        });
        return { bySuite: next };
      });
    }
  },

  reset: () =>
    set({
      initialized: false,
      configured: false,
      plans: [],
      plansLoading: false,
      plansError: null,
      bySuite: new Map(),
    }),
}));

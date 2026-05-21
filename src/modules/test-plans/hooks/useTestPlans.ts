import { create } from "zustand";
import {
  getCase,
  getConnection,
  listPlans,
  listSuiteCases,
  listSuites,
  toAdoError,
  type AdoError,
  type SuiteRef,
  type TestCase,
  type TestCaseRef,
  type TestPlanRef,
} from "@/modules/ado";

/** Per-suite load state. Errors are tracked on each suite key so a single
 *  failing suite doesn't blank an entire plan's subtree. */
export type SuiteCasesState = {
  cases: TestCaseRef[] | null;
  loading: boolean;
  error: AdoError | null;
};

export type SuiteLoad = {
  loading: boolean;
  error: AdoError | null;
  suites: SuiteRef[];
  /** Suite-id → per-suite case load state. */
  suiteCases: Map<number, SuiteCasesState>;
  /**
   * Back-compat shim — old call-sites read `.cases` (map of id → cases) and
   * `.loadingCases` (set of suite-ids currently fetching). Kept as derived
   * views so we don't have to touch TestPlansPanel's read paths.
   */
  cases: Map<number, TestCaseRef[]>;
  loadingCases: Set<number>;
};

/** Per-case detail load state, populated lazily when the user expands a
 *  case row in the explorer to peek at linked work items. */
export type CaseDetailsState = {
  data: TestCase | null;
  loading: boolean;
  error: AdoError | null;
};

type State = {
  initialized: boolean;
  configured: boolean;
  plans: TestPlanRef[];
  plansLoading: boolean;
  plansError: AdoError | null;
  bySuite: Map<number, SuiteLoad>;
  caseDetails: Map<number, CaseDetailsState>;

  refreshConnection: () => Promise<void>;
  refreshPlans: () => Promise<void>;
  loadSuites: (planId: number) => Promise<void>;
  loadSuiteCases: (planId: number, suiteId: number) => Promise<void>;
  /** Fetch full case data (state, priority, linked work items, etc.) on
   *  demand. Idempotent — repeat calls return the cached value. */
  loadCaseDetails: (caseId: number) => Promise<void>;
  /** Cancel any in-flight suite or case loads for this plan and forget the
   *  fact that we were loading. Called when the user collapses a plan. */
  cancelPlanLoads: (planId: number) => void;
  reset: () => void;
};

const initialSuiteLoad = (): SuiteLoad => ({
  loading: false,
  error: null,
  suites: [],
  suiteCases: new Map(),
  cases: new Map(),
  loadingCases: new Set(),
});

// AbortControllers and in-flight markers live OUTSIDE the zustand state so
// they don't get serialized or trigger re-renders. Keyed by planId for suite
// loads and by `${planId}:${suiteId}` for case loads.
const suiteAborts = new Map<number, AbortController>();
const caseAborts = new Map<string, AbortController>();
const inFlightSuites = new Set<number>();
const inFlightCases = new Set<string>();
const inFlightCaseDetails = new Set<number>();

function caseKey(planId: number, suiteId: number): string {
  return `${planId}:${suiteId}`;
}

/** Recompute the back-compat `cases` map + `loadingCases` set from the
 *  authoritative `suiteCases` map. Cheap — runs whenever we mutate. */
function refreshCompatViews(load: SuiteLoad): SuiteLoad {
  const cases = new Map<number, TestCaseRef[]>();
  const loadingCases = new Set<number>();
  for (const [sid, s] of load.suiteCases) {
    if (s.cases !== null) cases.set(sid, s.cases);
    if (s.loading) loadingCases.add(sid);
  }
  return { ...load, cases, loadingCases };
}

export const useTestPlans = create<State>((set, get) => ({
  initialized: false,
  configured: false,
  plans: [],
  plansLoading: false,
  plansError: null,
  bySuite: new Map(),
  caseDetails: new Map(),

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
    // Concurrent-call guard: if a load is already in-flight, just await it
    // (implicitly — return without re-firing). The first caller wins.
    if (inFlightSuites.has(planId)) return;
    const curr = get().bySuite.get(planId) ?? initialSuiteLoad();
    if (curr.suites.length > 0 && !curr.error) return; // cached + clean

    const controller = new AbortController();
    suiteAborts.set(planId, controller);
    inFlightSuites.add(planId);

    set((s) => {
      const next = new Map(s.bySuite);
      next.set(planId, { ...curr, loading: true, error: null });
      return { bySuite: next };
    });

    try {
      const suites = await listSuites(planId);
      // If the user collapsed this plan mid-flight, abort: don't overwrite
      // state with stale data.
      if (controller.signal.aborted) return;
      set((s) => {
        const next = new Map(s.bySuite);
        const prev = next.get(planId) ?? initialSuiteLoad();
        next.set(
          planId,
          refreshCompatViews({ ...prev, loading: false, error: null, suites }),
        );
        return { bySuite: next };
      });
    } catch (e) {
      if (controller.signal.aborted) return;
      set((s) => {
        const next = new Map(s.bySuite);
        const prev = next.get(planId) ?? initialSuiteLoad();
        next.set(planId, { ...prev, loading: false, error: toAdoError(e) });
        return { bySuite: next };
      });
    } finally {
      inFlightSuites.delete(planId);
      suiteAborts.delete(planId);
    }
  },

  loadSuiteCases: async (planId: number, suiteId: number) => {
    const key = caseKey(planId, suiteId);
    if (inFlightCases.has(key)) return;

    const curr = get().bySuite.get(planId);
    const existing = curr?.suiteCases.get(suiteId);
    if (existing?.cases !== undefined && existing?.cases !== null && !existing?.error) {
      return; // already loaded
    }

    const controller = new AbortController();
    caseAborts.set(key, controller);
    inFlightCases.add(key);

    set((s) => {
      const next = new Map(s.bySuite);
      const prev = next.get(planId) ?? initialSuiteLoad();
      const sc = new Map(prev.suiteCases);
      sc.set(suiteId, { cases: existing?.cases ?? null, loading: true, error: null });
      next.set(planId, refreshCompatViews({ ...prev, suiteCases: sc }));
      return { bySuite: next };
    });

    try {
      const cases = await listSuiteCases(planId, suiteId);
      if (controller.signal.aborted) return;
      set((s) => {
        const next = new Map(s.bySuite);
        const prev = next.get(planId) ?? initialSuiteLoad();
        const sc = new Map(prev.suiteCases);
        sc.set(suiteId, { cases, loading: false, error: null });
        next.set(planId, refreshCompatViews({ ...prev, suiteCases: sc }));
        return { bySuite: next };
      });
    } catch (e) {
      if (controller.signal.aborted) return;
      set((s) => {
        const next = new Map(s.bySuite);
        const prev = next.get(planId) ?? initialSuiteLoad();
        const sc = new Map(prev.suiteCases);
        const prevSuite = sc.get(suiteId);
        sc.set(suiteId, {
          cases: prevSuite?.cases ?? null,
          loading: false,
          error: toAdoError(e),
        });
        next.set(planId, refreshCompatViews({ ...prev, suiteCases: sc }));
        return { bySuite: next };
      });
    } finally {
      inFlightCases.delete(key);
      caseAborts.delete(key);
    }
  },

  loadCaseDetails: async (caseId: number) => {
    if (inFlightCaseDetails.has(caseId)) return;
    const existing = get().caseDetails.get(caseId);
    if (existing?.data && !existing.error) return; // cached, clean

    inFlightCaseDetails.add(caseId);
    set((s) => {
      const next = new Map(s.caseDetails);
      next.set(caseId, { data: existing?.data ?? null, loading: true, error: null });
      return { caseDetails: next };
    });

    try {
      const data = await getCase(caseId);
      set((s) => {
        const next = new Map(s.caseDetails);
        next.set(caseId, { data, loading: false, error: null });
        return { caseDetails: next };
      });
    } catch (e) {
      set((s) => {
        const next = new Map(s.caseDetails);
        const prev = next.get(caseId);
        next.set(caseId, {
          data: prev?.data ?? null,
          loading: false,
          error: toAdoError(e),
        });
        return { caseDetails: next };
      });
    } finally {
      inFlightCaseDetails.delete(caseId);
    }
  },

  cancelPlanLoads: (planId: number) => {
    suiteAborts.get(planId)?.abort();
    suiteAborts.delete(planId);
    inFlightSuites.delete(planId);
    for (const [key, ctrl] of caseAborts) {
      if (key.startsWith(`${planId}:`)) {
        ctrl.abort();
        caseAborts.delete(key);
        inFlightCases.delete(key);
      }
    }
  },

  reset: () => {
    for (const ctrl of suiteAborts.values()) ctrl.abort();
    for (const ctrl of caseAborts.values()) ctrl.abort();
    suiteAborts.clear();
    caseAborts.clear();
    inFlightSuites.clear();
    inFlightCases.clear();
    inFlightCaseDetails.clear();
    set({
      initialized: false,
      configured: false,
      plans: [],
      plansLoading: false,
      plansError: null,
      bySuite: new Map(),
      caseDetails: new Map(),
    });
  },
}));

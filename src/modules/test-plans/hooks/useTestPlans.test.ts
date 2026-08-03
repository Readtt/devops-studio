import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the ADO IPC wrappers the store talks to. Only the four connection /
// project / plan calls matter for these tests; the rest are present so the
// module import resolves.
const getConnection = vi.fn();
const listPlans = vi.fn();
const listProjects = vi.fn();
const setConnection = vi.fn();
const updateSuiteName = vi.fn();

vi.mock("@/modules/ado", () => ({
  getConnection: (...a: unknown[]) => getConnection(...a),
  listPlans: (...a: unknown[]) => listPlans(...a),
  listProjects: (...a: unknown[]) => listProjects(...a),
  setConnection: (...a: unknown[]) => setConnection(...a),
  listSuiteCases: vi.fn(),
  listSuites: vi.fn(),
  listSuitesForCase: vi.fn(),
  getCase: vi.fn(),
  updatePlanName: vi.fn(),
  updateSuiteName: (...a: unknown[]) => updateSuiteName(...a),
  toAdoError: (e: unknown) => ({ kind: "local", message: String(e) }),
  // Real implementations, not stubs: the store's rename guard asks these what
  // Azure DevOps permits, and a stub would make the guard vacuously pass.
  suiteCapabilities: (s: { suiteType?: string | null }) =>
    realSuiteCapabilities(s as never),
  suiteRestriction: (
    s: { suiteType?: string | null; requirementId?: number | null },
    action: "addCases" | "nestSuites" | "rename",
  ) => realSuiteRestriction(s as never, action),
}));

import {
  suiteCapabilities as realSuiteCapabilities,
  suiteRestriction as realSuiteRestriction,
} from "@/modules/ado/lib/suiteType";

import { useTestPlans } from "./useTestPlans";

function conn(over: Record<string, unknown> = {}) {
  return {
    configured: true,
    hasPat: true,
    identityName: null,
    orgUrl: "https://dev.azure.com/org",
    project: "",
    defaultTrackingBranch: "$current",
    ...over,
  };
}

beforeEach(() => {
  getConnection.mockReset();
  listPlans.mockReset();
  listProjects.mockReset();
  setConnection.mockReset();
  updateSuiteName.mockReset();
  listPlans.mockResolvedValue([]);
  setConnection.mockResolvedValue(undefined);
  useTestPlans.getState().reset();
});

/** Seed the store's suite cache for one plan without going through loadSuites. */
function seedSuites(
  planId: number,
  suites: Array<Record<string, unknown>>,
): void {
  useTestPlans.setState({
    bySuite: new Map([
      [
        planId,
        {
          loading: false,
          error: null,
          suites: suites as never,
          suiteCases: new Map(),
          cases: new Map(),
          loadingCases: new Set(),
        },
      ],
    ]),
  } as never);
}

describe("useTestPlans.renameSuite", () => {
  it("refuses a requirement-based suite before touching ADO", async () => {
    // ADO derives a requirement suite's name from its work item, so the PATCH
    // would fail server-side. Guarding in the store (not just the menu) matters
    // because a context menu rendered before a refresh can still fire this.
    seedSuites(1, [
      {
        id: 10,
        name: "4821 : Bulk archive",
        suiteType: "requirementTestSuite",
        requirementId: 4821,
        parentSuiteId: null,
      },
    ]);

    const err = await useTestPlans.getState().renameSuite(1, 10, "Renamed");

    expect(updateSuiteName).not.toHaveBeenCalled();
    expect(err).toMatchObject({ kind: "local" });
    expect((err as { message: string }).message).toContain("#4821");
    // The optimistic patch must not have run either.
    expect(useTestPlans.getState().bySuite.get(1)?.suites[0].name).toBe(
      "4821 : Bulk archive",
    );
  });

  it("still renames a static suite", async () => {
    seedSuites(1, [
      { id: 11, name: "Smoke", suiteType: "staticTestSuite", parentSuiteId: null },
    ]);
    updateSuiteName.mockResolvedValue({
      id: 11,
      name: "Smoke tests",
      suiteType: "staticTestSuite",
    });

    const err = await useTestPlans.getState().renameSuite(1, 11, "Smoke tests");

    expect(err).toBeNull();
    expect(updateSuiteName).toHaveBeenCalledWith(1, 11, "Smoke tests");
    expect(useTestPlans.getState().bySuite.get(1)?.suites[0].name).toBe(
      "Smoke tests",
    );
  });

  it("still renames a suite whose type we failed to parse", async () => {
    // Unknown must stay permissive — degrade to previous behaviour rather than
    // locking the user out of a suite they can actually rename.
    seedSuites(1, [
      { id: 12, name: "Odd", suiteType: "unknown", parentSuiteId: null },
    ]);
    updateSuiteName.mockResolvedValue({ id: 12, name: "Odd renamed" });

    expect(await useTestPlans.getState().renameSuite(1, 12, "Odd renamed")).toBeNull();
    expect(updateSuiteName).toHaveBeenCalled();
  });
});

describe("useTestPlans.refreshConnection", () => {
  it("marks NOT connected when the backend says so — and never touches projects/plans", async () => {
    getConnection.mockResolvedValue(conn({ configured: false }));
    await useTestPlans.getState().refreshConnection();
    const s = useTestPlans.getState();
    expect(s.configured).toBe(false);
    expect(s.initialized).toBe(true);
    expect(listProjects).not.toHaveBeenCalled();
    expect(listPlans).not.toHaveBeenCalled();
  });

  it("connected WITH a project loads that project's plans (no project lookup)", async () => {
    getConnection.mockResolvedValue(conn({ project: "Proj" }));
    listPlans.mockResolvedValue([{ id: 1, name: "Plan" }]);
    await useTestPlans.getState().refreshConnection();
    const s = useTestPlans.getState();
    expect(s.configured).toBe(true);
    expect(s.project).toBe("Proj");
    expect(listPlans).toHaveBeenCalledTimes(1);
    expect(listProjects).not.toHaveBeenCalled();
    expect(s.plans).toHaveLength(1);
  });

  // The regression that broke first-time setup: connected but no project. The
  // org has exactly one project, so we adopt it automatically and load plans.
  it("connected with NO project auto-adopts the only project", async () => {
    getConnection.mockResolvedValue(conn({ project: "" }));
    listProjects.mockResolvedValue([{ id: "a", name: "OnlyProj" }]);
    await useTestPlans.getState().refreshConnection();
    const s = useTestPlans.getState();
    expect(s.configured).toBe(true);
    expect(listProjects).toHaveBeenCalledTimes(1);
    expect(setConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        orgUrl: "https://dev.azure.com/org",
        project: "OnlyProj",
        defaultTrackingBranch: "$current",
      }),
    );
    expect(s.project).toBe("OnlyProj");
    expect(listPlans).toHaveBeenCalledTimes(1);
  });

  it("connected with NO project and MANY projects does not guess — leaves the picker to the user", async () => {
    getConnection.mockResolvedValue(conn({ project: "" }));
    listProjects.mockResolvedValue([
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ]);
    await useTestPlans.getState().refreshConnection();
    const s = useTestPlans.getState();
    expect(s.configured).toBe(true);
    expect(setConnection).not.toHaveBeenCalled();
    expect(s.project).toBe("");
    expect(listPlans).not.toHaveBeenCalled();
  });
});

describe("useTestPlans.refreshPlans", () => {
  it("is a no-op when no project is selected (avoids a malformed project-scoped request)", async () => {
    useTestPlans.setState({ configured: true, project: "" });
    await useTestPlans.getState().refreshPlans();
    expect(listPlans).not.toHaveBeenCalled();
    expect(useTestPlans.getState().plans).toEqual([]);
  });

  it("lists plans once a project is selected", async () => {
    useTestPlans.setState({ configured: true, project: "Proj" });
    listPlans.mockResolvedValue([{ id: 7, name: "P" }]);
    await useTestPlans.getState().refreshPlans();
    expect(listPlans).toHaveBeenCalledTimes(1);
    expect(useTestPlans.getState().plans).toHaveLength(1);
  });
});

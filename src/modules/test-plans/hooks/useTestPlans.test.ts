import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the ADO IPC wrappers the store talks to. Only the four connection /
// project / plan calls matter for these tests; the rest are present so the
// module import resolves.
const getConnection = vi.fn();
const listPlans = vi.fn();
const listProjects = vi.fn();
const setConnection = vi.fn();

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
  updateSuiteName: vi.fn(),
  toAdoError: (e: unknown) => ({ kind: "local", message: String(e) }),
}));

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
  listPlans.mockResolvedValue([]);
  setConnection.mockResolvedValue(undefined);
  useTestPlans.getState().reset();
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

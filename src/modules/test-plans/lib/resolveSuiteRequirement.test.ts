import { beforeEach, describe, expect, it, vi } from "vitest";

const listSuites = vi.fn();
const getBug = vi.fn();
vi.mock("@/modules/ado", async () => {
  const actual =
    await vi.importActual<typeof import("@/modules/ado")>("@/modules/ado");
  return {
    ...actual,
    // Real capability helpers, faked network — stubbing `isRequirementSuite`
    // would defeat the point of testing which suites get a fetch.
    listSuites: (...a: unknown[]) => listSuites(...a),
    getBug: (...a: unknown[]) => getBug(...a),
  };
});

const { resolveSuiteRequirement } = await import("./resolveSuiteRequirement");

const workItem = {
  id: 4821,
  title: "Bulk-archive contacts",
  state: "Active",
  workItemType: "User Story",
  reproStepsHtml: "",
  descriptionHtml: "<p>Archive many at once.</p>",
  acceptanceCriteriaHtml: "<p>Undo works</p>",
  tags: [],
  url: "",
};

beforeEach(() => {
  listSuites.mockReset();
  getBug.mockReset();
});

describe("resolveSuiteRequirement", () => {
  it("resolves the tracked work item for a requirement suite", async () => {
    listSuites.mockResolvedValue([
      { id: 2, name: "S", suiteType: "requirementTestSuite", requirementId: 4821 },
    ]);
    getBug.mockResolvedValue(workItem);

    const out = await resolveSuiteRequirement(1, 2);

    expect(getBug).toHaveBeenCalledWith(4821);
    expect(out.requirementId).toBe(4821);
    // Projected and HTML-stripped, so no markup can reach a prompt.
    expect(out.requirement?.description).toBe("Archive many at once.");
    expect(out.requirement?.acceptanceCriteria).toBe("Undo works");
  });

  it("gates on the suite TYPE, not merely on a requirementId being present", async () => {
    // The fixture deliberately carries a requirementId while being static.
    // Without it this test passes even if the `isRequirementSuite` check is
    // deleted — `requirementId == null` would short-circuit on its own, and
    // the assertion would certify a check that isn't running. ADO does return
    // stray fields, and a static suite must never be grounded in one.
    listSuites.mockResolvedValue([
      { id: 2, name: "S", suiteType: "staticTestSuite", requirementId: 4821 },
    ]);

    const out = await resolveSuiteRequirement(1, 2);

    expect(getBug).not.toHaveBeenCalled();
    expect(out).toEqual({ requirement: null, requirementId: null });
  });

  it("does not fetch anything for a query suite", async () => {
    // The single-case Evaluate button calls this on every click; a suite that
    // can't have a requirement must not pay for a work-item round-trip.
    listSuites.mockResolvedValue([
      { id: 2, name: "S", suiteType: "dynamicTestSuite", requirementId: 4821 },
    ]);

    const out = await resolveSuiteRequirement(1, 2);

    expect(getBug).not.toHaveBeenCalled();
    expect(out.requirementId).toBeNull();
  });

  it("keeps the id when the work-item body fetch fails", async () => {
    // This is the whole reason the id is carried separately: the prompt can
    // then name the requirement it couldn't read instead of going silent.
    listSuites.mockResolvedValue([
      { id: 2, name: "S", suiteType: "requirementTestSuite", requirementId: 4821 },
    ]);
    getBug.mockRejectedValue(new Error("403"));

    const out = await resolveSuiteRequirement(1, 2);

    expect(out.requirementId).toBe(4821);
    expect(out.requirement).toBeNull();
  });

  it("degrades to empty rather than throwing when ADO is unreachable", async () => {
    // Callers are mid-run (a bulk confidence loop, an Evaluate click). A throw
    // here would take out work that would otherwise have completed.
    listSuites.mockRejectedValue(new Error("network down"));
    await expect(resolveSuiteRequirement(1, 2)).resolves.toEqual({
      requirement: null,
      requirementId: null,
    });
  });

  it("short-circuits without a plan or suite id", async () => {
    expect(await resolveSuiteRequirement(null, 2)).toEqual({
      requirement: null,
      requirementId: null,
    });
    expect(await resolveSuiteRequirement(1, null)).toEqual({
      requirement: null,
      requirementId: null,
    });
    expect(listSuites).not.toHaveBeenCalled();
  });

  it("returns empty when the suite id isn't in the plan", async () => {
    listSuites.mockResolvedValue([{ id: 99, name: "Other" }]);
    const out = await resolveSuiteRequirement(1, 2);
    expect(out.requirementId).toBeNull();
    expect(getBug).not.toHaveBeenCalled();
  });
});

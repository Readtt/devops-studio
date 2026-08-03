import { describe, expect, it } from "vitest";
import { SuiteRefSchema } from "../types";
import {
  isQuerySuite,
  isRequirementSuite,
  isStaticSuite,
  normalizeSuiteType,
  suiteCapabilities,
  suiteRestriction,
} from "./suiteType";

describe("normalizeSuiteType", () => {
  it("accepts the camelCase ADO returns", () => {
    expect(normalizeSuiteType("requirementTestSuite")).toBe("requirementTestSuite");
    expect(normalizeSuiteType("dynamicTestSuite")).toBe("dynamicTestSuite");
    expect(normalizeSuiteType("staticTestSuite")).toBe("staticTestSuite");
  });

  it("accepts the PascalCase we send on create", () => {
    // ADO parses suiteType case-insensitively, so a POST echo (or a suite ref
    // restored from an old persisted draft) can carry either casing.
    expect(normalizeSuiteType("StaticTestSuite")).toBe("staticTestSuite");
    expect(normalizeSuiteType("RequirementTestSuite")).toBe("requirementTestSuite");
  });

  it("falls back to unknown rather than throwing", () => {
    expect(normalizeSuiteType("someFutureType")).toBe("unknown");
    expect(normalizeSuiteType(null)).toBe("unknown");
    expect(normalizeSuiteType(undefined)).toBe("unknown");
    expect(normalizeSuiteType("  ")).toBe("unknown");
  });
});

describe("SuiteRefSchema", () => {
  it("does not throw on a suite type ADO adds later", () => {
    // A throw here would reject the whole listSuites array and blank the plans
    // tree — the single worst failure mode of typing suiteType at all.
    const parsed = SuiteRefSchema.parse({
      id: 7,
      name: "Future",
      suiteType: "someFutureType",
    });
    expect(parsed.suiteType).toBe("unknown");
  });

  it("defaults suiteType when the field is absent entirely", () => {
    expect(SuiteRefSchema.parse({ id: 1, name: "Old" }).suiteType).toBe("unknown");
  });

  it("carries requirementId and queryString through", () => {
    const req = SuiteRefSchema.parse({
      id: 2,
      name: "Story suite",
      suiteType: "requirementTestSuite",
      requirementId: 4821,
    });
    expect(req.requirementId).toBe(4821);

    const dyn = SuiteRefSchema.parse({
      id: 3,
      name: "All smoke",
      suiteType: "dynamicTestSuite",
      queryString: "SELECT [System.Id] FROM WorkItems",
    });
    expect(dyn.queryString).toContain("SELECT");
  });
});

describe("suiteCapabilities", () => {
  it("lets requirement suites take cases but not children or renames", () => {
    // Adding a case to a requirement suite is exactly how ADO creates the
    // "Tested By" link — gating it would break the whole feature.
    const caps = suiteCapabilities({ suiteType: "requirementTestSuite" });
    expect(caps.canAddCases).toBe(true);
    expect(caps.canNestSuites).toBe(false);
    expect(caps.canRename).toBe(false);
    expect(caps.badge).toBe("REQ");
  });

  it("makes query suites read-only", () => {
    const caps = suiteCapabilities({ suiteType: "dynamicTestSuite" });
    expect(caps.canAddCases).toBe(false);
    expect(caps.canRemoveCases).toBe(false);
    expect(caps.badge).toBe("QUERY");
  });

  it("treats unknown and none permissively", () => {
    // A suite type we failed to parse must degrade to the app's previous
    // behaviour, never lock the user out of a suite they can actually use.
    for (const t of ["unknown", "none", undefined, null]) {
      const caps = suiteCapabilities({ suiteType: t as never });
      expect(caps.canAddCases).toBe(true);
      expect(caps.canNestSuites).toBe(true);
      expect(caps.canRename).toBe(true);
      expect(caps.badge).toBeNull();
    }
  });

  it("is case-insensitive at the predicate level too", () => {
    expect(isStaticSuite({ suiteType: "StaticTestSuite" })).toBe(true);
    expect(isRequirementSuite({ suiteType: "RequirementTestSuite" })).toBe(true);
    expect(isQuerySuite({ suiteType: "DynamicTestSuite" })).toBe(true);
  });
});

describe("suiteRestriction", () => {
  it("names the requirement in the rename reason when we know it", () => {
    expect(
      suiteRestriction(
        { suiteType: "requirementTestSuite", requirementId: 4821 },
        "rename",
      ),
    ).toContain("#4821");
  });

  it("degrades gracefully when requirementId is missing", () => {
    // Some org/API-revision combinations omit requirementId from the flat
    // suite list; the copy must still read as a sentence.
    const msg = suiteRestriction({ suiteType: "requirementTestSuite" }, "rename");
    expect(msg).toContain("its work item");
    expect(msg).not.toContain("#null");
  });

  it("returns null for allowed actions", () => {
    expect(suiteRestriction({ suiteType: "staticTestSuite" }, "rename")).toBeNull();
    expect(suiteRestriction({ suiteType: "staticTestSuite" }, "addCases")).toBeNull();
    expect(suiteRestriction({ suiteType: "requirementTestSuite" }, "addCases")).toBeNull();
  });
});

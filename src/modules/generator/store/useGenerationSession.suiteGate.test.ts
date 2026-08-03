import { describe, expect, it, vi } from "vitest";
import { createGenerationSessionStore } from "./useGenerationSession";
import type { ReviewedCase } from "../lib/draftBatchSchema";

// Neutralize the debounced draft autosave (and any other Tauri IPC) so calling
// real store actions in node doesn't reach for a backend that isn't there.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

const createCaseInSuite = vi.fn();
const listSuites = vi.fn();
vi.mock("@/modules/ado", async () => {
  const actual =
    await vi.importActual<typeof import("@/modules/ado")>("@/modules/ado");
  return {
    ...actual,
    // Capability helpers stay REAL — a test that stubs the table it's meant to
    // be exercising proves nothing. Only the network is faked.
    createCaseInSuite: (...args: unknown[]) => createCaseInSuite(...args),
    listSuites: (...args: unknown[]) => listSuites(...args),
  };
});

/** Did the capability gate stop the publish? Getting PAST it and failing on
 *  the (unmocked) ADO call is a pass here — `error` is an AdoError object in
 *  that case, not the gate's string, so match on the gate's own wording. */
function gateFired(error: unknown): boolean {
  return typeof error === "string" && /query-based/i.test(error);
}

function mkCase(uid: string): ReviewedCase {
  return {
    uid,
    decision: "keep",
    similarMatches: [],
    title: `Case ${uid}`,
    steps: [],
  } as unknown as ReviewedCase;
}

describe("useGenerationSession — a query-based suite never receives cases", () => {
  it("publish() refuses and creates nothing in Azure DevOps", async () => {
    // The failure this guards: ADO fills a dynamic suite from its own query
    // and rejects every hand-added case, so publishing would error per case
    // AFTER already creating orphan work items.
    const store = createGenerationSessionStore();
    createCaseInSuite.mockClear();
    store.setState({
      phase: "review",
      cases: [mkCase("c0")],
      bugs: [],
      planId: 1,
      suiteId: 2,
      targetSuiteType: "dynamicTestSuite",
    });

    await store.getState().publish();

    expect(store.getState().phase).toBe("error");
    expect(store.getState().errorPhase).toBe("publish");
    expect(store.getState().error).toMatch(/query-based/i);
    expect(createCaseInSuite).not.toHaveBeenCalled();
  });

  it("publish() re-resolves an unknown suite type instead of trusting it", async () => {
    // A draft saved before suite types existed carries `targetSuiteType: null`,
    // which `suiteCapabilities` treats as PERMISSIVE. That's right for a badge
    // and wrong here: publish is where orphan work items get created. The gate
    // must go and look rather than wave it through.
    const store = createGenerationSessionStore();
    createCaseInSuite.mockClear();
    listSuites.mockResolvedValue([
      { id: 2, name: "Filled by query", suiteType: "dynamicTestSuite" },
    ]);
    store.setState({
      phase: "review",
      cases: [mkCase("c0")],
      bugs: [],
      planId: 1,
      suiteId: 2,
      targetSuiteType: null,
    });

    await store.getState().publish();

    expect(listSuites).toHaveBeenCalledWith(1);
    expect(gateFired(store.getState().error)).toBe(true);
    expect(createCaseInSuite).not.toHaveBeenCalled();
  });

  it("publish() falls back to permissive when the re-resolve fails", async () => {
    // Best-effort: an ADO outage must not block a publish that would have
    // worked. Failing closed here would strand every legacy draft.
    const store = createGenerationSessionStore();
    createCaseInSuite.mockClear();
    listSuites.mockRejectedValue(new Error("network down"));
    store.setState({
      phase: "review",
      cases: [mkCase("c0")],
      bugs: [],
      planId: 1,
      suiteId: 2,
      targetSuiteType: null,
    });

    await store.getState().publish();
    expect(gateFired(store.getState().error)).toBe(false);
  });

  it("publish() skips the re-resolve when the type is already known", async () => {
    // The extra round-trip is only justified by ignorance. A known-static
    // target must not pay for it on every publish.
    const store = createGenerationSessionStore();
    listSuites.mockClear();
    store.setState({
      phase: "review",
      cases: [mkCase("c0")],
      bugs: [],
      planId: 1,
      suiteId: 2,
      targetSuiteType: "staticTestSuite",
    });

    await store.getState().publish();
    expect(listSuites).not.toHaveBeenCalled();
  });

  it("publish() lets a static suite through and actually creates the case", async () => {
    // POSITIVE CONTROL. Without this, every `not.toHaveBeenCalled()` above
    // would still pass if publish() were broken outright — they'd be asserting
    // that nothing happened for the wrong reason.
    const store = createGenerationSessionStore();
    createCaseInSuite.mockClear();
    createCaseInSuite.mockResolvedValue({ id: 999, url: "" });
    store.setState({
      phase: "review",
      cases: [mkCase("c0")],
      bugs: [],
      planId: 1,
      suiteId: 2,
      targetSuiteType: "staticTestSuite",
    });

    await store.getState().publish();

    expect(gateFired(store.getState().error)).toBe(false);
    expect(createCaseInSuite).toHaveBeenCalledTimes(1);
    expect(createCaseInSuite).toHaveBeenCalledWith(1, 2, expect.anything());
  });

  it("an unknown suite type stays permissive", async () => {
    // "Never gate on ignorance": a type we failed to parse degrades to the
    // app's previous behaviour rather than locking the user out.
    const store = createGenerationSessionStore();
    store.setState({
      phase: "review",
      cases: [mkCase("c0")],
      bugs: [],
      planId: 1,
      suiteId: 2,
      targetSuiteType: "unknown",
    });

    await store.getState().publish();
    expect(gateFired(store.getState().error)).toBe(false);
  });
});

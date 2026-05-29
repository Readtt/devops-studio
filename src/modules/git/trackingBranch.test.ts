import { describe, expect, it } from "vitest";
import {
  CURRENT_BRANCH_SENTINEL,
  isDynamicTrackingBranch,
  resolveTrackingBranch,
} from "./trackingBranch";

describe("isDynamicTrackingBranch", () => {
  it("is true only for the $current sentinel", () => {
    expect(isDynamicTrackingBranch(CURRENT_BRANCH_SENTINEL)).toBe(true);
    expect(isDynamicTrackingBranch("  $current  ")).toBe(true);
    expect(isDynamicTrackingBranch("main")).toBe(false);
    expect(isDynamicTrackingBranch(null)).toBe(false);
    expect(isDynamicTrackingBranch(undefined)).toBe(false);
  });
});

describe("resolveTrackingBranch", () => {
  it("returns a saved fixed branch verbatim (trimmed)", () => {
    expect(resolveTrackingBranch("release/2.0", "feature/x")).toBe("release/2.0");
    expect(resolveTrackingBranch("  develop  ", null)).toBe("develop");
  });

  it("resolves $current to the live source-dir branch", () => {
    expect(resolveTrackingBranch(CURRENT_BRANCH_SENTINEL, "feature/login")).toBe(
      "feature/login",
    );
  });

  it("falls back to main when $current has no source-dir branch", () => {
    expect(resolveTrackingBranch(CURRENT_BRANCH_SENTINEL, null)).toBe("main");
    expect(resolveTrackingBranch(CURRENT_BRANCH_SENTINEL, "   ")).toBe("main");
  });

  it("falls back to main when nothing is saved", () => {
    expect(resolveTrackingBranch(null, "feature/x")).toBe("main");
    expect(resolveTrackingBranch("", null)).toBe("main");
  });
});

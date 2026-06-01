import { describe, expect, it } from "vitest";
import { DEFAULT_PREFERENCES } from "./store";

// The global code-search switch gates source access for every AI surface.
// These guard its contract: default ON, and it's a real boolean preference.
describe("codeSearchEnabled preference", () => {
  it("defaults to true (code search on out of the box)", () => {
    expect(DEFAULT_PREFERENCES.codeSearchEnabled).toBe(true);
  });

  it("is declared on the Preferences default shape", () => {
    expect(typeof DEFAULT_PREFERENCES.codeSearchEnabled).toBe("boolean");
  });
});

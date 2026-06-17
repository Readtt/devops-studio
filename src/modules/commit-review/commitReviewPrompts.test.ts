import { describe, expect, it } from "vitest";
import {
  INVESTIGATE_SYSTEM_PROMPT,
  VERIFY_SYSTEM_PROMPT,
  investigateSystemPrompt,
  verifySystemPrompt,
} from "./commitReviewPrompts";

describe("commit-review system prompts", () => {
  it("uses the single-commit base prompt unchanged for one commit", () => {
    expect(investigateSystemPrompt(1)).toBe(INVESTIGATE_SYSTEM_PROMPT);
    expect(verifySystemPrompt(1)).toBe(VERIFY_SYSTEM_PROMPT);
    // 0 (defensive — run() never calls with an empty selection) also stays put.
    expect(investigateSystemPrompt(0)).toBe(INVESTIGATE_SYSTEM_PROMPT);
  });

  it("prepends an authoritative multi-commit preamble for N>1, keeping the base", () => {
    const p = investigateSystemPrompt(3);
    expect(p).not.toBe(INVESTIGATE_SYSTEM_PROMPT);
    expect(p).toContain("3 git commits");
    expect(p).toContain("ONE combined change");
    // The full single-commit instructions still follow the preamble verbatim.
    expect(p.endsWith(INVESTIGATE_SYSTEM_PROMPT)).toBe(true);
    // The preamble comes first so it carries system-level authority.
    expect(p.indexOf("MULTI-COMMIT REVIEW")).toBeLessThan(
      p.indexOf(INVESTIGATE_SYSTEM_PROMPT),
    );
  });

  it("applies the same multi-commit framing to the verify stage", () => {
    const p = verifySystemPrompt(2);
    expect(p).toContain("2 git commits");
    expect(p.endsWith(VERIFY_SYSTEM_PROMPT)).toBe(true);
  });
});

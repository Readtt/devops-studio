import { describe, expect, it } from "vitest";
import {
  INVESTIGATE_SYSTEM_PROMPT,
  VERIFY_SYSTEM_PROMPT,
  investigateSystemPrompt,
  verifySystemPrompt,
} from "./commitReviewPrompts";
import type { WorkspaceRepo } from "@/modules/settings/store";

const REPOS: WorkspaceRepo[] = [
  { id: "r1", name: "repo-one", root: "C:\\src\\repo-one", ado: null },
  { id: "r2", name: "repo-two", root: "C:\\src\\repo-two", ado: null },
];

describe("commit-review system prompts", () => {
  it("uses the single-commit base prompt unchanged for one commit", () => {
    expect(investigateSystemPrompt(1, [])).toBe(INVESTIGATE_SYSTEM_PROMPT);
    expect(verifySystemPrompt(1, [])).toBe(VERIFY_SYSTEM_PROMPT);
    // 0 (defensive — run() never calls with an empty selection) also stays put.
    expect(investigateSystemPrompt(0, [])).toBe(INVESTIGATE_SYSTEM_PROMPT);
  });

  it("prepends an authoritative multi-commit preamble for N>1, keeping the base", () => {
    const p = investigateSystemPrompt(3, []);
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
    const p = verifySystemPrompt(2, []);
    expect(p).toContain("2 git commits");
    expect(p.endsWith(VERIFY_SYSTEM_PROMPT)).toBe(true);
  });
});

// Both stages read across every configured repo, so both have to be told which
// repos exist and how a path names one. The roster rides on the SYSTEM prompt
// because a resume re-sends that intact while compacting the turn it replays.
describe("commit-review prompts · repo addressing", () => {
  it("names every repo, with its path, on both stages", () => {
    for (const p of [
      investigateSystemPrompt(1, REPOS),
      verifySystemPrompt(1, REPOS),
    ]) {
      expect(p).toContain("SOURCE REPOS you can read:");
      expect(p).toContain("- repo-one: C:\\src\\repo-one");
      expect(p).toContain("- repo-two: C:\\src\\repo-two");
    }
  });

  it("adds no roster when code search is off", () => {
    expect(investigateSystemPrompt(1, [])).not.toContain("SOURCE REPOS");
  });

  it("keeps the roster last, after the multi-commit preamble and the base", () => {
    const p = investigateSystemPrompt(2, REPOS);
    expect(p.indexOf(INVESTIGATE_SYSTEM_PROMPT)).toBeLessThan(
      p.indexOf("SOURCE REPOS you can read:"),
    );
  });

  it("teaches the prefixed path form on both stages", () => {
    for (const p of [INVESTIGATE_SYSTEM_PROMPT, VERIFY_SYSTEM_PROMPT]) {
      expect(p).toContain("<repo>/<path within repo>");
    }
  });

  // The raw patch's own paths are repo-relative; echoing one back as a citation
  // is ambiguous the moment a second repo is configured.
  it("tells the investigator not to cite the patch header's bare path", () => {
    expect(INVESTIGATE_SYSTEM_PROMPT).toMatch(
      /raw patch's own .* headers are repo-relative and carry NO prefix/,
    );
    expect(INVESTIGATE_SYSTEM_PROMPT).toContain(
      "prefix those with the repo named at the top of that section",
    );
  });
});

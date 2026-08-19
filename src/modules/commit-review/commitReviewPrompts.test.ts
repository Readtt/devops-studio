import { describe, expect, it } from "vitest";
import {
  FINDING_WRITING_RULES,
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

// The writing contract exists because developers reported spending more time
// deciphering findings than fixing them. Every phrase pinned below is
// load-bearing — each survived (or came out of) two adversarial review rounds.
describe("commit-review prompts · finding writing contract", () => {
  it("embeds the whole contract in the investigate stage only", () => {
    expect(INVESTIGATE_SYSTEM_PROMPT.includes(FINDING_WRITING_RULES)).toBe(true);
    // Verify contributes no user-visible prose — the contract there would be
    // dead weight re-sent on every verify step.
    expect(VERIFY_SYSTEM_PROMPT.includes(FINDING_WRITING_RULES)).toBe(false);
    expect(VERIFY_SYSTEM_PROMPT).not.toContain("HOW TO WRITE FINDINGS");
  });

  it("sits between SUGGESTED FIXES and OUTPUT", () => {
    // Anchored on a block-unique sentence: the heading itself is
    // cross-referenced from HOW-TO-WORK step 4 (before the block) and the
    // OUTPUT hints (after), so its indexOf proves nothing.
    const at = INVESTIGATE_SYSTEM_PROMPT.indexOf(
      "The reader is a developer in a hurry",
    );
    expect(at).toBeGreaterThan(
      INVESTIGATE_SYSTEM_PROMPT.indexOf("SUGGESTED FIXES"),
    );
    expect(at).toBeLessThan(INVESTIGATE_SYSTEM_PROMPT.indexOf("\nOUTPUT"));
  });

  it("pins the rules the adversarial rounds proved load-bearing", () => {
    for (const phrase of [
      // flexed so a maintainability finding needn't invent a failure
      "WHAT goes wrong or what it costs",
      // user feedback: simpler words on average, not formal register
      "prefer everyday words",
      // anti-slop: kills sentences that merely sound helpful
      "could move to a different finding unchanged",
      // FindingCard renders prose raw — backticks would display literally
      "no markdown, no backticks",
      // rewrite pressure must never become drop pressure
      "complexity in the prose is a reason to rewrite it",
      "at most 3 sentences",
      "at most 6 lines",
      // titles hedge to "can …" only when a precondition went unconfirmed
      "phrase it as a capability",
      "never a hypothetical attack story",
      "Never invent a failure scenario or a number you did not trace",
      // multi-commit attribution rides inside the first sentence
      "never as a separate sentence",
      // diff-only runs (code search off) must not fabricate a tool trace
      "never imply a check you could not run",
      "Shorten prose within these shapes before you ever drop a real finding",
    ]) {
      expect(FINDING_WRITING_RULES).toContain(phrase);
    }
  });

  it("teaches the literal \\n\\n JSON escape in the worked example", () => {
    // The example must show the two-character escape the model emits inside a
    // JSON string — a real newline here would teach invalid JSON.
    expect(FINDING_WRITING_RULES).toContain(
      "orders to the other.\\n\\nBoth call sites",
    );
  });

  it("replaces the old field hints instead of stacking a second contract", () => {
    expect(INVESTIGATE_SYSTEM_PROMPT).not.toContain("short, specific");
    expect(INVESTIGATE_SYSTEM_PROMPT).not.toContain(
      "why it's a bug + the blast radius",
    );
    expect(INVESTIGATE_SYSTEM_PROMPT).not.toContain("what you read/grepped");
    expect(INVESTIGATE_SYSTEM_PROMPT).not.toContain(
      "file:line refs + a one-line trace",
    );
  });
});

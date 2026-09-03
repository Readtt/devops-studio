import { describe, expect, it } from "vitest";
import {
  FINDING_WRITING_RULES,
  INPUT_SCENARIO_RULES,
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
    // The clause that pointed at a since-removed heading went with it.
    expect(p).not.toContain("frame a lens");
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
    expect(p).not.toContain("frame a lens");
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
      // ...and reproSteps renders the same way, so it is under the same rule
      "evidence, and reproSteps all render as plain text",
      // the change→failure sentence has no honest form for an absence
      "an absence is never attributed to the change",
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
    // The repro example carries the same escape, one per step.
    expect(FINDING_WRITING_RULES).toContain("kiosk-7.\\n2. Call GET");
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

// The forward lens: every other section reasons backward from the change, so
// missing handling — an absence with no changed line to cite — was previously
// unreportable. The section only fires because of the two supporting edits
// pinned below it; without them it lands and does nothing.
describe("commit-review prompts · input-scenario lens", () => {
  it("ships in the investigate stage, with the other lenses", () => {
    expect(INVESTIGATE_SYSTEM_PROMPT.includes(INPUT_SCENARIO_RULES)).toBe(true);
    const at = INVESTIGATE_SYSTEM_PROMPT.indexOf("INPUT SCENARIOS");
    expect(at).toBeGreaterThan(
      INVESTIGATE_SYSTEM_PROMPT.indexOf("CROSS-MODULE CONSISTENCY"),
    );
    expect(at).toBeLessThan(
      INVESTIGATE_SYSTEM_PROMPT.indexOf("REQUIREMENTS CONFORMANCE"),
    );
    // Verify judges claims; it does not author them.
    expect(VERIFY_SYSTEM_PROMPT).not.toContain("INPUT SCENARIOS");
  });

  it("pins the four paragraphs that make the section fire", () => {
    for (const phrase of [
      // forward, not backward — the whole point of the section
      "work forward from what can ARRIVE",
      // scoping: without it the model reads until the step cap
      "Start where a value crosses a boundary",
      // ...and the model cannot see its step cap, so "room" is not a signal
      "Widen from there only once those are covered.",
      // derivation, not a remembered checklist
      "rather than working from a remembered checklist",
      // an absence is reportable at all
      "either name the code that handles it or establish that nothing does",
      // ...but only with damage behind it, or every absent check is a finding
      "an absent check with no consequence behind it is not a finding",
      // rated by damage, so it doesn't sort as a nit
      "data that comes out wrong is correctness, not maintainability",
      // how to evidence a search that came back empty
      "the looking is your evidence",
      // the literal input, which is also the repro
      "the literal value rather than its category",
    ]) {
      expect(INPUT_SCENARIO_RULES).toContain(phrase);
    }
  });

  // Nothing tells the model its step cap, so a section billed as "the
  // highest-value lens" is where a budget it cannot measure gets spent — and
  // the forward lens carried no billing at all.
  it("gives neither lens top billing, and says why both get worked", () => {
    expect(INVESTIGATE_SYSTEM_PROMPT).not.toContain("highest-value lens");
    expect(INPUT_SCENARIO_RULES).toContain(
      "They find close to disjoint sets of defects, so work both",
    );
  });

  // A checklist of input classes would be worked through as a checklist and
  // would anchor every future review on whatever shapes happened to be in it.
  it("names no fixed list of input classes", () => {
    for (const token of ["null", "empty string", "Unicode", "boundary value"]) {
      expect(INPUT_SCENARIO_RULES).not.toContain(token);
    }
  });

  // Read literally, the old scope sentence suppressed exactly what the lens
  // produces: missing handling lives in code the commit did not change.
  it("widens PRECISION OVER RECALL to the touched code's input surface", () => {
    expect(INVESTIGATE_SYSTEM_PROMPT).toContain(
      "The input surface of the code this commit touches is in scope too: a missing check there, with damage behind it, is a finding, not padding.",
    );
    // The counterweights stay, or this becomes a noise machine.
    expect(INVESTIGATE_SYSTEM_PROMPT).toContain(
      "False positives destroy trust faster than misses",
    );
    expect(INVESTIGATE_SYSTEM_PROMPT).toContain(
      "Zero findings is a valid, good result",
    );
  });

  // Absence findings look thin, so the standing tie-break would delete them
  // all — silently. The carve-out edits that tie-break rather than sitting
  // beside it: with two tie-breaks in one prompt, the standing one wins.
  it("carves absence claims out of verify's refute-when-in-doubt tie-break", () => {
    expect(VERIFY_SYSTEM_PROMPT).toContain(
      "to refute a claim that some handling is MISSING, cite what makes the claim false",
    );
    // Every refutation route step 2 already allows, not only a handler.
    expect(VERIFY_SYSTEM_PROMPT).toContain(
      "the guard that keeps that input from reaching it, or the constraint that stops the source producing it",
    );
    expect(VERIFY_SYSTEM_PROMPT).toContain(
      'A search that finds none of those is confirmation, not refutation; a search you could not run is "uncertain".',
    );
    // In place: the exception sits on step 4's own line, not as a rule beside it.
    const step4 = VERIFY_SYSTEM_PROMPT.split("\n").find((l) =>
      l.startsWith("4. Recalibrate"),
    );
    expect(step4).toContain("handling is MISSING");
    // One tie-break, amended in place — not a second rule beside the first.
    expect(
      VERIFY_SYSTEM_PROMPT.match(/prefer "refuted"/g)?.length ?? 0,
    ).toBe(1);
    // The writing contract still belongs to stage 1 only.
    expect(VERIFY_SYSTEM_PROMPT).not.toContain("HOW TO WRITE FINDINGS");
  });
});

// The developer has to see the bug happen, not just read a claim about it.
// Naming the triggering input is work the input-scenario lens already does, so
// the repro rides along with it rather than costing a second pass.
describe("commit-review prompts · reproduction steps", () => {
  it("puts the REPRO bullet after EVIDENCE and before the worked example", () => {
    const at = FINDING_WRITING_RULES.indexOf("- REPRO:");
    expect(at).toBeGreaterThan(FINDING_WRITING_RULES.indexOf("- EVIDENCE:"));
    expect(at).toBeLessThan(
      FINDING_WRITING_RULES.indexOf("EXAMPLE of the shape"),
    );
    // Not after the closing line, where it reads as contradicting the block's
    // own prose caps.
    expect(at).toBeLessThan(
      FINDING_WRITING_RULES.indexOf("Shorten prose within these shapes"),
    );
  });

  it("asks for literal values, traced from code rather than watched", () => {
    for (const phrase of [
      "the exact literal input that triggers it",
      "Use real values",
      // The block already forbids inventing a failure. A repro written as a
      // session someone ran IS that invention, and with the two rules fighting
      // the model resolves it by writing no repro at all.
      "You read the code, you did not run the product",
      "never write a step as something you watched happen on a screen",
      // ...and one plain line beats invented steps when nothing external
      // reaches the defect.
      "When the defect cannot be triggered from outside",
      // "real values" must not fight "never invent a number you did not trace"
      "The literal values in the steps are yours to choose",
    ]) {
      expect(FINDING_WRITING_RULES).toContain(phrase);
    }
  });

  // A rule with no example in front of it gets skipped, and a field missing
  // from the OUTPUT shape never gets emitted at all.
  it("shows reproSteps in both the worked example and the OUTPUT shape", () => {
    expect(FINDING_WRITING_RULES).toContain(
      '"reproSteps": "1. Sign in as user 41',
    );
    expect(INVESTIGATE_SYSTEM_PROMPT).toContain(
      '"reproSteps": "numbered steps per HOW TO WRITE FINDINGS"',
    );
  });
});

// The forward lens only pays off if the new findings are rated and reported
// honestly: rated by shape they under-rate, and gated behind attached
// requirements they never fire.
describe("commit-review prompts · rating and reporting the new findings", () => {
  it("rates missing handling by its damage, not as a flat medium", () => {
    // The old line ("medium: missing error handling, ...") rated by the shape
    // of the defect, which under-rates exactly what the input lens finds.
    expect(INVESTIGATE_SYSTEM_PROMPT).not.toContain(
      "medium: missing error handling",
    );
    expect(INVESTIGATE_SYSTEM_PROMPT).toContain(
      "rate a finding by what it DOES, not by the shape it takes",
    );
    expect(INVESTIGATE_SYSTEM_PROMPT).toContain(
      "Missing handling has no severity of its own",
    );
    // An ordered ladder: damage first, then one level off for an unconfirmed
    // precondition — never two answers for one case.
    expect(INVESTIGATE_SYSTEM_PROMPT).toContain(
      "a whole batch or request that stops on one bad item, is high",
    );
    expect(INVESTIGATE_SYSTEM_PROMPT).toContain(
      "then drop one level when reaching it needs a precondition you did not confirm",
    );
  });

  it("keeps requirements conservative about intent, not about size", () => {
    // The anti-speculation stance stands — models over-flag intent.
    expect(INVESTIGATE_SYSTEM_PROMPT).toContain(
      "never speculate that intent is unmet",
    );
    expect(INVESTIGATE_SYSTEM_PROMPT).toContain(
      "Reporting a non-existent requirement gap is worse than missing one.",
    );
    // ...but a mismatch visible in the code is reportable however small.
    expect(INVESTIGATE_SYSTEM_PROMPT).toContain(
      "a mismatch you CAN point at in the code is worth reporting at whatever severity its damage deserves, including low, and is never padding",
    );
  });

  // The sweep must fire on every run, so it cannot live inside the section
  // gated on "only when the user provided context/ticket/requirements".
  it("runs the rename sweep outside the requirements gate", () => {
    const sweep = INVESTIGATE_SYSTEM_PROMPT.indexOf("RENAMES AND RELABELS");
    expect(sweep).toBeGreaterThan(-1);
    expect(sweep).toBeLessThan(
      INVESTIGATE_SYSTEM_PROMPT.indexOf("REQUIREMENTS CONFORMANCE"),
    );
    expect(INVESTIGATE_SYSTEM_PROMPT).toContain(
      "Do this on every review, requirements attached or not.",
    );
    expect(INVESTIGATE_SYSTEM_PROMPT).toContain("search the OLD string");
    // A recall rule inside a precision prompt needs its own carve-out.
    expect(INVESTIGATE_SYSTEM_PROMPT).toContain(
      "A reader kept for old persisted data, or a changelog line, is not a leftover.",
    );
  });
});

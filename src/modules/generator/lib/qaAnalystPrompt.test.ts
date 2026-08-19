import { describe, expect, it } from "vitest";
import { QA_ANALYST_PROMPT } from "./qaAnalystPrompt";

// A prompt's effect on model behavior can't be regression-tested here; what
// CAN regress silently is the presence of its load-bearing sections. These pin
// the proportionality rule added after a spec-less request ("generate 5
// example test cases") burned 14 steps and ~640k tokens reading a codebase the
// request never asked about — the rest of the prompt pushes grounding hard
// (STEP SPECIFICITY, codeRefs), and without this counterweight "trace the
// spec across real files" applies even when there is no spec to trace.
describe("QA_ANALYST_PROMPT — proportionality", () => {
  it("instructs the model to scale investigation to the request", () => {
    expect(QA_ANALYST_PROMPT).toContain("PROPORTIONALITY");
    expect(QA_ANALYST_PROMPT).toMatch(
      /Match investigation depth to the substance of the request/,
    );
    // The spec-less case is named concretely, with the cheap alternative
    // (orient briefly, pick one small area) rather than a bare "don't".
    expect(QA_ANALYST_PROMPT).toMatch(/names no concrete feature/);
    expect(QA_ANALYST_PROMPT).toMatch(/pick ONE\s+small real area/);
    // And the stop rule that ends a run the moment the batch is writable.
    expect(QA_ANALYST_PROMPT).toMatch(/stop reading and write/);
  });

  // The first cut of the block above narrowed the run without bounding what it
  // cost or protecting what it returned: "generate 5 example test cases" came
  // back with TWO cases after 24 tool calls. Both halves failed — "a handful of
  // tool calls at most" wasn't a number the model could check itself against,
  // and nothing anywhere said an explicitly requested count has to be met. The
  // two budgets are now stated separately so a small reading budget can't be
  // read as licence to write a small batch.
  it("splits the reading budget from the batch size", () => {
    expect(QA_ANALYST_PROMPT).toMatch(/HOW MUCH YOU READ/);
    expect(QA_ANALYST_PROMPT).toMatch(/HOW MANY CASES YOU WRITE/);
    expect(QA_ANALYST_PROMPT).toMatch(
      /A small reading budget never shrinks the batch/,
    );
  });

  it("makes an explicitly requested case count a target it must hit", () => {
    // The quantity rule, with the shapes a tester actually types.
    expect(QA_ANALYST_PROMPT).toMatch(/TARGET YOU ARE EXPECTED TO HIT/);
    expect(QA_ANALYST_PROMPT).toMatch(/fewer\s+cases than the user asked for/);
    expect(QA_ANALYST_PROMPT).toMatch(/"5 test cases"/);
    expect(QA_ANALYST_PROMPT).toMatch(/"about ten"/);
    // Dedup is the one rule that could legitimately eat the count, so it is
    // scoped to WHICH cases rather than how many — the batch stays whole.
    expect(QA_ANALYST_PROMPT).toMatch(
      /DUPLICATION RULE below governs WHICH cases you write, never how many/,
    );
  });

  it("gives the thin-request reading budget a number, not an adjective", () => {
    expect(QA_ANALYST_PROMPT).toMatch(/roughly five tool calls/);
  });

  it("keeps the bare-JSON output contract the runner validates against", () => {
    expect(QA_ANALYST_PROMPT).toMatch(/Respond with ONLY a single JSON object/);
  });
});

// Every path the analyst reads or emits is `<repo>/<path>`. The schema no
// longer carries the repo separately, so a path that loses its prefix loses
// the binding with it — the link publishes against the wrong repo's branch, or
// gets dropped for naming no repo at all.
describe("QA_ANALYST_PROMPT — repo-prefixed paths", () => {
  it("states the addressing rule once", () => {
    expect(QA_ANALYST_PROMPT).toContain("PATHS ARE REPO-PREFIXED");
    expect(QA_ANALYST_PROMPT).toContain("<repo>/<path within repo>");
  });

  it("prefixes both worked examples — codeRefs and sourceLinks", () => {
    expect(QA_ANALYST_PROMPT).toContain('"file": "repo-one/src/auth/login.ts"');
    expect(QA_ANALYST_PROMPT).toContain(
      '"filePath": "repo-one/src/auth/login.cs"',
    );
  });

  // The field still exists in the schema for older drafts, but asking for it
  // invites the model to invent one ("MyApp") that binds to no configured repo.
  it("stops asking the model for a repo name", () => {
    expect(QA_ANALYST_PROMPT).not.toContain('"repoName"');
    expect(QA_ANALYST_PROMPT).not.toContain("emit only\n  the repo name");
  });

  // Still the rule it always was: the prefix is added to the full path, it does
  // not replace the directory segments under it.
  it("keeps the no-bare-filename rule", () => {
    expect(QA_ANALYST_PROMPT).toMatch(/NEVER abbreviate to a bare filename/);
    expect(QA_ANALYST_PROMPT).toMatch(/never a bare filename/);
  });
});

// The plain-language pass exists because generated cases and bugs read like
// developer notes: QA couldn't follow them, preconditions assumed states
// nobody explained how to reach, and repro steps leaned on code access the
// tester doesn't have. These pin the audience contract and the bug section
// layout (which the Rust publisher bolds by label — see render_repro_line).
describe("QA_ANALYST_PROMPT — plain language & tester-facing structure", () => {
  it("carries the shared plain-language audience contract", () => {
    expect(QA_ANALYST_PROMPT).toContain("PLAIN LANGUAGE");
    expect(QA_ANALYST_PROMPT).toContain("RUNNING PRODUCT");
    // Abbreviations must be explained, with the user's real pain named.
    expect(QA_ANALYST_PROMPT).toMatch(/No unexplained abbreviations/);
    expect(QA_ANALYST_PROMPT).toContain('not "CS01"');
    // Plain reads as professional documentation, never as casual chat.
    expect(QA_ANALYST_PROMPT).toMatch(/plain language is not casual language/);
    // Plain language beats copying the technical style of existing items.
    expect(QA_ANALYST_PROMPT).toMatch(/outrank style-matching/);
  });

  it("turns preconditions into walked setup steps", () => {
    expect(QA_ANALYST_PROMPT).toContain("SETUP FIRST");
    expect(QA_ANALYST_PROMPT).toMatch(/without steps that create it/);
  });

  it("pins the bug section layout the publisher renders by label", () => {
    for (const label of [
      "SUMMARY:",
      "PRECONDITIONS:",
      "STEPS TO REPRODUCE:",
      "REQUIRED TOOLS:",
      "EXPECTED RESULT:",
      "ACTUAL RESULT:",
      "TECHNICAL NOTES:",
      "ENVIRONMENT:",
    ]) {
      expect(QA_ANALYST_PROMPT).toContain(label);
    }
    // REQUIRED TOOLS is the one conditional section — present only when a
    // tool is genuinely required, never as an "n/a" line.
    expect(QA_ANALYST_PROMPT).toMatch(/OMIT this whole section/);
    // Repro steps must be runnable with only the deployed product…
    expect(QA_ANALYST_PROMPT).toMatch(/ONLY the running product/);
    // …and a code-only bug says so honestly instead of faking UI steps.
    expect(QA_ANALYST_PROMPT).toMatch(/never invent pretend steps/);
  });
});

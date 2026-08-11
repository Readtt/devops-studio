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

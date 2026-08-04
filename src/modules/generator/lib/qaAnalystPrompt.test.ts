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

  it("keeps the bare-JSON output contract the runner validates against", () => {
    expect(QA_ANALYST_PROMPT).toMatch(/Respond with ONLY a single JSON object/);
  });
});

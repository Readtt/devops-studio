// `runs` is a straight cost multiplier on the app's most expensive path, and
// bulk suite scoring multiplies it again by the case count. These tests pin the
// two facts that keep that bounded: the default is ONE, and >1 only happens when
// a caller explicitly asks.

import { beforeEach, describe, expect, it, vi } from "vitest";

const runTask = vi.fn();
vi.mock("@/modules/ai/lib/taskRunner", () => ({
  runTask: (...a: unknown[]) => runTask(...a),
}));
vi.mock("./suiteChatTools", () => ({
  buildSuiteChatTools: () => undefined,
}));

import {
  evaluateConfidence,
  MAX_SELF_CONSISTENCY_RUNS,
  type ConfidenceEvalInput,
} from "./runConfidenceEval";

const VERDICT = {
  predictedOutcome: "Pass",
  passLikelihood: 80,
  evidence: [],
  reasoning: "traced",
  caveats: [],
};

function input(over: Partial<ConfidenceEvalInput> = {}): ConfidenceEvalInput {
  return {
    testCase: {
      id: 15310,
      title: "Archive selected contacts",
      steps: [{ index: 1, action: "Click archive", expected: "Row hides" }],
    },
    sourceRoot: "C:/src/app",
    modelId: "claude-opus-5" as ConfidenceEvalInput["modelId"],
    keys: {} as ConfidenceEvalInput["keys"],
    ...over,
  } as ConfidenceEvalInput;
}

beforeEach(() => {
  runTask.mockReset();
  runTask.mockResolvedValue({ ok: true, object: VERDICT, text: "" });
});

describe("confidence self-consistency runs", () => {
  it("costs exactly one model run when nobody asks for more", async () => {
    const v = await evaluateConfidence(input());
    expect(runTask).toHaveBeenCalledTimes(1);
    expect(v.runs).toBe(1);
  });

  it("multiplies the whole evaluation when a caller opts in", async () => {
    // Not a warning about a hypothetical — this is what `runs: 3` costs: three
    // complete agentic evaluations of one case, each re-reading the code.
    await evaluateConfidence(input({ runs: 3 }));
    expect(runTask).toHaveBeenCalledTimes(3);
  });

  it("refuses to multiply past the documented ceiling", async () => {
    await evaluateConfidence(input({ runs: 99 }));
    expect(runTask).toHaveBeenCalledTimes(MAX_SELF_CONSISTENCY_RUNS);
  });

  it("treats a nonsensical count as one run rather than none", async () => {
    const v = await evaluateConfidence(input({ runs: 0 }));
    expect(runTask).toHaveBeenCalledTimes(1);
    expect(v.runs).toBe(1);
  });
});

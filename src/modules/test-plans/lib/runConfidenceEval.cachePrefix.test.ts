// Confidence is the app's largest cost path — one full agentic run PER CASE, so
// a 50-case suite pays for everything in front of the case content fifty times.
// The one lever that changes that is the prompt cache, and the prompt cache only
// works on a prefix that is byte-identical between cases. These tests pin that.

import { beforeEach, describe, expect, it, vi } from "vitest";

const runTask = vi.fn();
vi.mock("@/modules/ai/lib/taskRunner", () => ({
  runTask: (...a: unknown[]) => runTask(...a),
}));
vi.mock("./suiteChatTools", () => ({
  buildSuiteChatTools: (repos: unknown[]) =>
    repos.length > 0 ? ({ read_file: {} } as never) : undefined,
}));

import {
  buildEvalPrompt,
  buildEvalSystem,
  evaluateConfidence,
  type ConfidenceEvalInput,
} from "./runConfidenceEval";
import type { TargetRequirement } from "@/modules/ado";

const requirement: TargetRequirement = {
  id: 4821,
  workItemType: "User Story",
  title: "Bulk-archive contacts",
  state: "Active",
  description: "Users need to archive many contacts at once.",
  acceptanceCriteria: "- Select all works\n- Undo works",
};

const HOUSE_RULES = "Every case names the endpoint it exercises.";

/** Two cases from the same suite: everything a bulk run holds constant is
 *  constant, and only the case differs. */
function input(
  testCase: ConfidenceEvalInput["testCase"],
  over: Partial<ConfidenceEvalInput> = {},
): ConfidenceEvalInput {
  return {
    testCase,
    repos: [{ id: "r1", name: "repo-one", root: "C:/src/app", ado: null }],
    modelId: "claude-opus-5" as ConfidenceEvalInput["modelId"],
    keys: {} as ConfidenceEvalInput["keys"],
    requirement,
    requirementId: 4821,
    contextBlocks: [{ heading: "QA STANDARDS", body: HOUSE_RULES }],
    ...over,
  } as ConfidenceEvalInput;
}

const caseA: ConfidenceEvalInput["testCase"] = {
  id: 15310,
  title: "Archive selected contacts",
  steps: [{ index: 1, action: "Click archive", expected: "Row hides" }],
};
const caseB: ConfidenceEvalInput["testCase"] = {
  id: 15311,
  title: "Undo an archive",
  steps: [{ index: 1, action: "Click undo", expected: "Row returns" }],
};

const VERDICT = {
  predictedOutcome: "Pass",
  passLikelihood: 80,
  evidence: [],
  reasoning: "traced",
  caveats: [],
};

beforeEach(() => {
  runTask.mockReset();
  runTask.mockResolvedValue({ ok: true, object: VERDICT, text: "" });
});

describe("confidence request — the cacheable prefix", () => {
  it("is byte-identical across two different cases", () => {
    expect(buildEvalSystem(input(caseB))).toBe(buildEvalSystem(input(caseA)));
  });

  it("carries the blocks a bulk run would otherwise re-buy per case", () => {
    const system = buildEvalSystem(input(caseA));
    expect(system).toContain(HOUSE_RULES);
    expect(system).toContain("REQUIREMENT — this suite is requirement-based");
    expect(system).toContain("- repo-one: C:/src/app");
  });

  it("puts the case, and only the case, after it", () => {
    const system = buildEvalSystem(input(caseA));
    const prompt = buildEvalPrompt(input(caseA));
    // A single per-case byte in front of the boundary re-bills the whole
    // prefix, so the case must not appear in the shared half at all.
    expect(system).not.toContain("Archive selected contacts");
    expect(system).not.toContain("Click archive");
    expect(prompt).toContain("TEST CASE #15310 — Archive selected contacts");
    expect(prompt).toContain("Click archive");
    // …and the shared blocks must not be duplicated into the per-case half,
    // which would pay for them twice rather than not at all.
    expect(prompt).not.toContain(HOUSE_RULES);
    expect(prompt).not.toContain("REQUIREMENT — this suite is requirement-based");
  });

  it("reaches the runner that way — two cases, one shared systemPrompt", async () => {
    // Asserting on the builders alone is a change-detector: it keeps passing
    // if the runner starts assembling the request some other way.
    await evaluateConfidence(input(caseA));
    await evaluateConfidence(input(caseB));
    const first = runTask.mock.calls[0][0];
    const second = runTask.mock.calls[1][0];
    expect(second.systemPrompt).toBe(first.systemPrompt);
    expect(second.prompt).not.toBe(first.prompt);
    expect(first.systemPrompt).not.toContain(caseA.title);
    expect(second.systemPrompt).not.toContain(caseB.title);
  });

  it("a differing requirement DOES break the prefix (it isn't faked stable)", async () => {
    // The stability has to come from the inputs genuinely being shared, not
    // from the builder ignoring them — an ignored requirement would be a
    // grading bug wearing a cache win's clothes.
    const other = buildEvalSystem(
      input(caseA, {
        requirement: { ...requirement, acceptanceCriteria: "- Something else" },
      }),
    );
    expect(other).not.toBe(buildEvalSystem(input(caseA)));
  });
});

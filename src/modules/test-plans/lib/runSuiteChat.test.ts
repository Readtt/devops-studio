import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the shared runner so we can inspect the assembled prompt without a
// model call.
const streamTask = vi.fn();
vi.mock("@/modules/ai/lib/taskRunner", () => ({
  streamTask: (...a: unknown[]) => streamTask(...a),
}));
vi.mock("./suiteChatTools", () => ({
  buildSuiteChatTools: () => undefined,
}));

import {
  streamSuiteChatTask,
  SUITE_CHAT_SYSTEM_PROMPT,
  type SuiteChatMessage,
  type SuiteChatTaskInput,
} from "./runSuiteChat";

const base: SuiteChatTaskInput & { onText: (d: string) => void } = {
  suiteName: "4821 : Bulk archive",
  suitePath: ["Sprint 12"],
  planName: "Web",
  cases: [],
  history: [],
  newQuestion: "which acceptance criteria have no covering case?",
  modelId: "gpt-5.4-mini" as never,
  keys: {} as never,
  sourceRoot: null,
  onText: () => undefined,
};

beforeEach(() => {
  streamTask.mockReset();
  streamTask.mockResolvedValue({ text: "ok", durationMs: 1 });
});

/** Everything the model reads on the user side, in the order it reads it: the
 *  stable context turn followed by the question. Assembled here rather than
 *  asserted per-field so these tests keep testing WHAT the model is told, and
 *  stay silent about which message it arrives in. */
async function promptFor(
  over: Partial<SuiteChatTaskInput>,
): Promise<string> {
  await streamSuiteChatTask({ ...base, ...over });
  const call = streamTask.mock.calls[0][0];
  return [call.contextPrompt, call.prompt]
    .filter((s: unknown): s is string => typeof s === "string" && s.length > 0)
    .join("\n");
}

describe("suite-chat prompt — suite type awareness", () => {
  it("leaves a static suite's prompt unmarked", () => {
    // The feature must be inert for the suites this app already handled.
    return promptFor({ suiteType: "staticTestSuite" }).then((p) => {
      expect(p).toContain("SUITE: Web › Sprint 12 › 4821 : Bulk archive —");
      expect(p).not.toContain("requirement-based");
      expect(p).not.toContain("query-based");
      expect(p).not.toContain("REQUIREMENT");
    });
  });

  it("marks a requirement-based suite and embeds its criteria", async () => {
    const p = await promptFor({
      // A real case, so the CASES IN SCOPE header exists to order against.
      cases: [
        {
          id: 15310,
          title: "Archive selected contacts",
          state: "Design",
          descriptionHtml: "",
          steps: [],
          tags: [],
          url: "",
          linkedWorkItems: [],
        },
      ] as never,
      suiteType: "requirementTestSuite",
      requirement: {
        id: 4821,
        workItemType: "User Story",
        title: "Bulk-archive contacts",
        state: "Active",
        description: "Users need to archive many contacts at once.",
        acceptanceCriteria: "- Select all works\n- Undo works",
      },
    });
    expect(p).toContain("[requirement-based → #4821]");
    expect(p).toContain("REQUIREMENT");
    expect(p).toContain("- Undo works");
    // The requirement must precede the cases so coverage is judged against it.
    expect(p.indexOf("REQUIREMENT")).toBeLessThan(p.indexOf("CASES IN SCOPE"));
  });

  it("marks a query-based suite read-only", async () => {
    const p = await promptFor({ suiteType: "dynamicTestSuite" });
    expect(p).toContain("[query-based · read-only]");
    expect(p).not.toContain("REQUIREMENT");
  });

  it("says which requirement it couldn't read rather than going silent", async () => {
    // loadCases swallows a failed getBug, so this pairing is reachable. The
    // system prompt separately orders the model to audit coverage against
    // "the REQUIREMENT block" and to NAME uncovered criteria — with the block
    // missing and nothing explaining why, it invents criteria to audit.
    const p = await promptFor({
      suiteType: "requirementTestSuite",
      requirement: null,
      requirementId: 4821,
    });
    expect(p).toContain("[requirement-based → #4821]");
    expect(p).toContain("could NOT be loaded");
    expect(p).toContain("do not claim coverage");
  });
});

describe("suite-chat history — real messages, not re-inlined prose", () => {
  const turn = (
    role: "user" | "assistant",
    content: string,
  ): SuiteChatMessage => ({
    id: `${role}-${content}`,
    role,
    content,
    timestamp: "2026-08-03T00:00:00.000Z",
  });

  it("sends the thread as conversation turns", async () => {
    await streamSuiteChatTask({
      ...base,
      history: [turn("user", "q1"), turn("assistant", "a1")],
      newQuestion: "q2",
    });
    const call = streamTask.mock.calls[0][0];
    expect(call.priorMessages).toEqual([
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
    ]);
    expect(call.prompt).toBe("q2");
    // The prose framing the roles replaced must be gone from BOTH halves —
    // left behind, it would still be rebuilt inside a growing string.
    expect(call.contextPrompt).not.toContain("PRIOR CONVERSATION");
    expect(call.contextPrompt).not.toContain("q1");
    expect(call.prompt).not.toContain("PRIOR CONVERSATION");
  });

  it("drops an empty turn instead of sending an empty text block", async () => {
    // A stream that died before its first delta can leave one behind in a
    // persisted thread. As prose that was a blank line; as a real message it is
    // a text block with no text, which Anthropic answers with a 400 — so this
    // conversion has to filter where the prose never had to.
    await streamSuiteChatTask({
      ...base,
      history: [turn("user", "q1"), turn("assistant", "   ")],
      newQuestion: "q2",
    });
    expect(streamTask.mock.calls[0][0].priorMessages).toEqual([
      { role: "user", content: "q1" },
    ]);
  });

  it("keeps the stable half byte-identical as the thread grows", async () => {
    // This is the property that makes the conversation cacheable: the leading
    // context turn must not move a single byte between turns. It re-renders
    // the suite and the standards blocks every time, so "it happens to be the
    // same" is a claim worth pinning.
    await streamSuiteChatTask({ ...base, history: [], newQuestion: "q1" });
    await streamSuiteChatTask({
      ...base,
      history: [turn("user", "q1"), turn("assistant", "a1")],
      newQuestion: "q2",
    });
    const first = streamTask.mock.calls[0][0];
    const second = streamTask.mock.calls[1][0];
    expect(second.contextPrompt).toBe(first.contextPrompt);
    expect(second.systemPrompt).toBe(first.systemPrompt);
    // …and turn 2 is turn 1 with two messages appended, which is what a cached
    // prefix has to be.
    expect(second.priorMessages).toEqual([
      ...(first.priorMessages as unknown[]),
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
    ]);
  });
});

describe("SUITE_CHAT_SYSTEM_PROMPT", () => {
  it("tells the model how each suite type constrains it", () => {
    expect(SUITE_CHAT_SYSTEM_PROMPT).toContain("SUITE TYPE");
    // Coverage answers on a requirement suite must name uncovered criteria.
    expect(SUITE_CHAT_SYSTEM_PROMPT).toContain("NAME any criterion");
    // And it must not offer to create cases in a read-only suite.
    expect(SUITE_CHAT_SYSTEM_PROMPT).toContain("CANNOT create or delete cases");
  });

  it("is actually the system prompt handed to the model", async () => {
    // Asserting on the exported constant alone is a change-detector: it keeps
    // passing if the runner stops sending it, or sends a different one.
    await streamSuiteChatTask({ ...base, suiteType: "staticTestSuite" });
    expect(streamTask.mock.calls[0][0].systemPrompt).toBe(
      SUITE_CHAT_SYSTEM_PROMPT,
    );
  });
});

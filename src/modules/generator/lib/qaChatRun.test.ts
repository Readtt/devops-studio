import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the shared runner so we can inspect the assembled request without a
// model call, and the tools so no Tauri invoke is attempted.
const streamTask = vi.fn();
vi.mock("@/modules/ai/lib/taskRunner", () => ({
  streamTask: (...a: unknown[]) => streamTask(...a),
}));
vi.mock("@/modules/test-plans/lib/suiteChatTools", () => ({
  buildSuiteChatTools: () => undefined,
}));

import { streamChatTask, type ChatMessage, type ChatTaskInput } from "./qaChatRun";

const base: ChatTaskInput & { onText: (d: string) => void } = {
  requirements: "Users can bulk-archive contacts.",
  attachments: [],
  cases: [],
  bugs: [],
  history: [],
  newQuestion: "does the draft cover the undo path?",
  modelId: "gpt-5.4-mini" as never,
  keys: {} as never,
  onText: () => undefined,
};

const turn = (role: "user" | "assistant", content: string): ChatMessage => ({
  id: `${role}-${content}`,
  role,
  content,
  timestamp: "2026-08-03T00:00:00.000Z",
});

beforeEach(() => {
  streamTask.mockReset();
  streamTask.mockResolvedValue({ text: "ok", durationMs: 1 });
});

describe("draft-chat history — real messages, not re-inlined prose", () => {
  it("sends the thread as conversation turns", async () => {
    await streamChatTask({
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
    expect(call.contextPrompt).not.toContain("PRIOR CONVERSATION");
    expect(call.contextPrompt).not.toContain("q1");
  });

  it("drops an empty turn instead of sending an empty text block", async () => {
    await streamChatTask({
      ...base,
      history: [turn("user", "q1"), turn("assistant", "")],
      newQuestion: "q2",
    });
    expect(streamTask.mock.calls[0][0].priorMessages).toEqual([
      { role: "user", content: "q1" },
    ]);
  });

  it("keeps the stable half byte-identical as the thread grows", async () => {
    // The cache property: the spec + draft turn must not move a byte between
    // turns, so each request is the previous one with turns appended.
    await streamChatTask({ ...base, history: [], newQuestion: "q1" });
    await streamChatTask({
      ...base,
      history: [turn("user", "q1"), turn("assistant", "a1")],
      newQuestion: "q2",
    });
    const first = streamTask.mock.calls[0][0];
    const second = streamTask.mock.calls[1][0];
    expect(second.contextPrompt).toBe(first.contextPrompt);
    expect(second.systemPrompt).toBe(first.systemPrompt);
  });

  it("still carries the spec and the draft the user is looking at", async () => {
    await streamChatTask({
      ...base,
      cases: [
        {
          uid: "c1",
          title: "Archive selected contacts",
          rationale: "",
          decision: "keep",
          steps: [{ action: "Click archive", expected: "Row hides" }],
        },
      ] as never,
    });
    const ctx = streamTask.mock.calls[0][0].contextPrompt as string;
    expect(ctx).toContain("ORIGINAL SPEC (ground truth):");
    expect(ctx).toContain("Users can bulk-archive contacts.");
    expect(ctx).toContain("CURRENT DRAFT");
    expect(ctx).toContain("Archive selected contacts");
  });

  it("attaches the turn's files to the turn, not to the cached context", async () => {
    await streamChatTask({
      ...base,
      attachments: [
        { kind: "text", path: "notes.md", content: "check the undo path" },
      ] as never,
    });
    const call = streamTask.mock.calls[0][0];
    expect(call.prompt).toContain("Attachments:");
    expect(call.prompt).toContain("notes.md");
    expect(call.contextPrompt).not.toContain("notes.md");
  });
});

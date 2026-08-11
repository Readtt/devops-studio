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

import {
  sanitizeTranscript,
  streamChatTask,
  type ChatMessage,
  type ChatTaskInput,
} from "./qaChatRun";
import type { ModelMessage } from "ai";

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

// Reported: the Ask ran a pile of tool calls, didn't answer, and the follow-up
// "you didn't explain" re-ran every one of them. Replaying an assistant turn as
// the prose it ended with tells the model nothing about the files it had just
// read, so each turn started blind. These pin the transcript replay.
describe("draft-chat memory — a turn remembers what it read", () => {
  const toolCall = (id: string): ModelMessage => ({
    role: "assistant",
    content: [
      { type: "tool-call", toolCallId: id, toolName: "read_file", input: {} },
    ],
  }) as never;
  const toolResult = (id: string): ModelMessage => ({
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: id,
        toolName: "read_file",
        output: { type: "text", value: "file body" },
      },
    ],
  }) as never;
  const say = (text: string): ModelMessage => ({
    role: "assistant",
    content: [{ type: "text", text }],
  }) as never;

  it("replays the prior turn's tool calls and results, not just its prose", async () => {
    const transcript = [toolCall("t1"), toolResult("t1"), say("a1")];
    await streamChatTask({
      ...base,
      history: [
        turn("user", "q1"),
        { ...turn("assistant", "a1"), transcript },
      ],
      newQuestion: "you didn't explain",
    });
    const call = streamTask.mock.calls[0][0];
    expect(call.priorMessages).toEqual([
      { role: "user", content: "q1" },
      ...transcript,
    ]);
  });

  it("replaces the assistant's text message rather than duplicating it", async () => {
    await streamChatTask({
      ...base,
      history: [
        turn("user", "q1"),
        { ...turn("assistant", "a1"), transcript: [say("a1")] },
      ],
    });
    const prior = streamTask.mock.calls[0][0].priorMessages as ModelMessage[];
    expect(prior).toHaveLength(2);
    // The transcript's own message, not a re-serialization of the display
    // text beside it — asserting only the COUNT would also hold for the
    // text-only replay this replaced.
    expect(prior[1]).toEqual(say("a1"));
  });

  it("falls back to plain text for a turn that banked no transcript", async () => {
    await streamChatTask({
      ...base,
      history: [turn("user", "q1"), turn("assistant", "a1")],
    });
    expect(streamTask.mock.calls[0][0].priorMessages).toEqual([
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
    ]);
  });

  it("feeds each step's transcript out so a cancelled turn still banks it", async () => {
    const seen: ModelMessage[][] = [];
    streamTask.mockImplementation(async (args: Record<string, unknown>) => {
      const onCheckpoint = args.onCheckpoint as (c: {
        messages: ModelMessage[];
      }) => void;
      onCheckpoint({ messages: [toolCall("t1"), toolResult("t1")] });
      onCheckpoint({ messages: [toolCall("t1"), toolResult("t1"), say("a")] });
      return { text: "a", durationMs: 1 };
    });
    await streamChatTask({
      ...base,
      onTranscript: (m) => seen.push(m),
    });
    expect(seen).toHaveLength(2);
    expect(seen[1]).toHaveLength(3);
  });

  it("does not ask the runner for checkpoints when nobody is banking them", async () => {
    await streamChatTask({ ...base });
    expect(streamTask.mock.calls[0][0].onCheckpoint).toBeUndefined();
  });

  describe("sanitizeTranscript", () => {
    it("keeps a balanced transcript whole", () => {
      const t = [toolCall("t1"), toolResult("t1"), say("done")];
      expect(sanitizeTranscript(t)).toBe(t);
    });

    it("cuts at a tool call the cancel left unanswered", () => {
      // Anthropic 400s on a tool_use with no tool_result. The completed read
      // before it is still worth carrying — that's the whole point.
      const t = [toolCall("t1"), toolResult("t1"), toolCall("t2")];
      expect(sanitizeTranscript(t)).toEqual([toolCall("t1"), toolResult("t1")]);
    });

    it("drops everything after the first dangling call, not just the call", () => {
      const t = [toolCall("t1"), say("narration"), toolCall("t2"), toolResult("t2")];
      expect(sanitizeTranscript(t)).toEqual([]);
    });

    it("passes a text-only transcript through untouched", () => {
      const t = [say("hello")];
      expect(sanitizeTranscript(t)).toBe(t);
    });
  });
});

// A live Ask spent 16 tool calls on "explain this bug" and never answered. The
// bug it was asked about carried codeRefs and a full labeled repro — the draft
// block sent neither, so the model had to re-derive locations the generator had
// already written down. These pin the evidence into the block.
describe("draft-chat draft block — the draft ships its own evidence", () => {
  const bug = (over: Record<string, unknown> = {}) =>
    ({
      uid: "b1",
      decision: "keep",
      title: "Migrate drops users with no collect row",
      severity: "2 - High",
      linkedDraftCaseIndex: 0,
      codeRefs: [
        {
          file: "src/Data/CollectProcess.cs",
          startLine: 42,
          endLine: 58,
          symbol: "CollectProcess.Run",
        },
        { file: "src/Data/MigrateUsers.cs", startLine: 11 },
      ],
      reproSteps:
        "PRECONDITION:\nA user exists with no collect row.\n\nSTEPS TO REPRODUCE:\n1. Run Migrate.\n\nEXPECTED RESULT:\nThe user is migrated.\n\nACTUAL RESULT:\nThe user is skipped.\n\nENVIRONMENT:\nn/a",
      ...over,
    }) as never;

  const kase = (over: Record<string, unknown> = {}) =>
    ({
      uid: "c1",
      title: "Archive selected contacts",
      rationale: "",
      decision: "keep",
      steps: [{ action: "Click archive", expected: "Row hides" }],
      sourceLinks: [
        {
          repoName: "App",
          filePath: "src/contacts/archive.ts",
          symbol: "archiveMany",
        },
      ],
      ...over,
    }) as never;

  it("sends each bug's codeRefs as citable file:line anchors", async () => {
    await streamChatTask({ ...base, cases: [kase()], bugs: [bug()] });
    const ctx = streamTask.mock.calls[0][0].contextPrompt as string;
    expect(ctx).toContain(
      "code: src/Data/CollectProcess.cs:42-58 (CollectProcess.Run), src/Data/MigrateUsers.cs:11",
    );
  });

  it("sends each case's sourceLinks", async () => {
    await streamChatTask({ ...base, cases: [kase()] });
    const ctx = streamTask.mock.calls[0][0].contextPrompt as string;
    expect(ctx).toContain("source: src/contacts/archive.ts (archiveMany)");
  });

  it("keeps the repro's labeled sections instead of flattening to one line", async () => {
    await streamChatTask({ ...base, bugs: [bug()] });
    const ctx = streamTask.mock.calls[0][0].contextPrompt as string;
    // Structure, not just substrings: the old renderer joined every line with
    // a space, which kept the labels readable as text while destroying the
    // section layout the repro contract is built on.
    expect(ctx).toMatch(/\n {4}repro:\n {6}PRECONDITION:\n/);
    expect(ctx).toMatch(/\n {6}ACTUAL RESULT:\n {6}The user is skipped\./);
  });

  it("still bounds a runaway repro rather than sending it whole", async () => {
    await streamChatTask({
      ...base,
      bugs: [bug({ reproSteps: `STEPS:\n${"x".repeat(5000)}` })],
    });
    const ctx = streamTask.mock.calls[0][0].contextPrompt as string;
    expect(ctx).toContain("… (repro truncated)");
    expect(ctx).not.toContain("x".repeat(1300));
  });

  it("numbers cases and bugs from 1 and names the bug's parent case", async () => {
    await streamChatTask({ ...base, cases: [kase()], bugs: [bug()] });
    const ctx = streamTask.mock.calls[0][0].contextPrompt as string;
    expect(ctx).toContain("case 1 [KEEP] Archive selected contacts");
    expect(ctx).toMatch(/bug 1 \[KEEP\] .* → case 1/);
  });

  it("does not invent a parent case for an out-of-range link index", async () => {
    await streamChatTask({
      ...base,
      cases: [],
      bugs: [bug({ linkedDraftCaseIndex: 7 })],
    });
    const ctx = streamTask.mock.calls[0][0].contextPrompt as string;
    // Asserted positively — a bare `not.toContain` would also hold for a
    // renderer that emits no bug line at all, which is what this replaced.
    expect(ctx).toMatch(/ {2}bug 1 \[KEEP\] .*\(severity: 2 - High\)$/m);
    expect(ctx).not.toContain("→ case");
  });
});

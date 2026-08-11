import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the shared runner so we can inspect the assembled request without a
// model call, and the tools so no Tauri invoke is attempted.
const streamTask = vi.fn();
vi.mock("@/modules/ai/lib/taskRunner", () => ({
  streamTask: (...a: unknown[]) => streamTask(...a),
}));
// Mirrors the real contract: a tool set when there's a source dir to read,
// nothing when there isn't. Which one it is now decides whether a banked
// transcript can be replayed at all, so a flat `undefined` would hide that.
vi.mock("@/modules/test-plans/lib/suiteChatTools", () => ({
  buildSuiteChatTools: (root: string | null) =>
    root ? ({ read_file: {} } as never) : undefined,
}));

import {
  streamChatTask,
  type ChatMessage,
  type ChatTaskInput,
} from "./qaChatRun";
import { sanitizeTranscript } from "@/modules/ai/lib/finishPass";
import type { ModelMessage } from "ai";
import { FINISH_NOW_NUDGE } from "@/modules/ai/lib/checkpointApi";
import {
  RESUME_TOPUP_TOKENS,
  SURFACE_TOKEN_BUDGETS,
} from "@/modules/ai/config";

const base: ChatTaskInput & { onText: (d: string) => void } = {
  requirements: "Users can bulk-archive contacts.",
  attachments: [],
  cases: [],
  bugs: [],
  history: [],
  newQuestion: "does the draft cover the undo path?",
  modelId: "gpt-5.4-mini" as never,
  keys: {} as never,
  sourceRoot: "/src",
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
  streamTask.mockResolvedValue({ ok: true, text: "ok", durationMs: 1 });
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

  // `sourceRoot` is re-read from preferences on every Ask, so code search can
  // go off between two questions in the same chat. The banked transcript's
  // tool blocks then have no tool definitions behind them and the provider
  // rejects the whole request — every follow-up failing until the user turns
  // code search back on.
  it("replays prose, not tool blocks, when this turn has no tools", async () => {
    await streamChatTask({
      ...base,
      sourceRoot: null,
      history: [
        turn("user", "q1"),
        {
          ...turn("assistant", "a1"),
          transcript: [toolCall("t1"), toolResult("t1"), say("a1")],
        },
      ],
    });
    expect(streamTask.mock.calls[0][0].tools).toBeNull();
    expect(streamTask.mock.calls[0][0].priorMessages).toEqual([
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
    ]);
  });

  // A transcript banks COMPLETED steps only, so a turn the user stopped
  // mid-answer has its visible prose in `content` and nowhere else — and the
  // store keeps that partial bubble on purpose. Replacing the message with the
  // transcript dropped exactly the text on screen, so "keep going from where
  // you stopped" reached a model with no record of having written anything.
  it("keeps a cancelled turn's partial answer alongside its transcript", async () => {
    const transcript = [toolCall("t1"), toolResult("t1")];
    await streamChatTask({
      ...base,
      history: [
        turn("user", "q1"),
        { ...turn("assistant", "half an answer"), transcript },
      ],
      newQuestion: "keep going from where you stopped",
    });
    expect(streamTask.mock.calls[0][0].priorMessages).toEqual([
      { role: "user", content: "q1" },
      ...transcript,
      { role: "assistant", content: "half an answer" },
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
      return { ok: true, text: "a", durationMs: 1 };
    });
    await streamChatTask({
      ...base,
      onTranscript: (m) => seen.push(m),
    });
    expect(seen).toHaveLength(2);
    expect(seen[1]).toHaveLength(3);
  });

  it("always asks the runner for checkpoints", async () => {
    // Not conditional on a caller wanting them: the finish pass replays the
    // transcript, so streamChatTask needs it for itself.
    await streamChatTask({ ...base });
    expect(streamTask.mock.calls[0][0].onCheckpoint).toBeTypeOf("function");
  });

  // Reported: "it ran 16 tool calls, and then just stopped… then it just didnt
  // explain." The loop ended on a tool call, so the last step wrote no answer —
  // and a schema-less streamTask reports that as ok:true with the whole run's
  // narration as `text`. The Ask presented the narration as the reply.
  describe("finishing a turn that stopped without answering", () => {
    const readSomething = [toolCall("t1"), toolResult("t1")];

    /** First pass narrates and never answers; the finish pass writes the reply. */
    const stoppedShort = (finishText = "Here is the explanation.") => {
      let call = 0;
      streamTask.mockImplementation(async (args: Record<string, unknown>) => {
        call += 1;
        const onCheckpoint = args.onCheckpoint as (c: {
          messages: ModelMessage[];
        }) => void;
        // Streams like the real runner does — the narration reaching the
        // bubble live is the behaviour being pinned, so a mock that only
        // returns text would make that assertion vacuous.
        const onText = args.onText as (d: string) => void;
        if (call === 1) {
          onCheckpoint({ messages: readSomething });
          onText("I'll dig into the collect/migrate code.");
          return {
            ok: true,
            text: "I'll dig into the collect/migrate code.",
            finalText: "",
            stepsUsed: 12,
            durationMs: 10,
          };
        }
        onText(finishText);
        // What the real accumulator emits: [...resumeMessages, ...this call's
        // own messages] — so the finish pass's checkpoint carries the nudge
        // that was handed to it. Building the array without it would hide the
        // banking bug entirely.
        onCheckpoint({
          messages: [
            ...((args.resumeMessages as ModelMessage[]) ?? []),
            say(finishText),
          ],
        });
        return { ok: true, text: finishText, finalText: finishText, durationMs: 5 };
      });
    };

    it("replays what it read and forbids more reading, instead of leaving narration as the answer", async () => {
      stoppedShort();
      const r = await streamChatTask({ ...base });
      expect(streamTask).toHaveBeenCalledTimes(2);
      const finish = streamTask.mock.calls[1][0];
      // The tools STAY on the request. Sending `tools: null` — the literal
      // reading of "tool-less finish pass" — puts the replay's
      // tool_use/tool_result blocks in a request with no tools to answer to,
      // which Anthropic rejects with a 400: the recovery becomes a second
      // failure the user still pays for.
      expect(finish.tools).toBeTruthy();
      // And NOT via `toolChoice: "none"`, which reads like the right way to
      // declare tools without allowing them and isn't: @ai-sdk/anthropic
      // implements that value by dropping the tool definitions, rebuilding the
      // same invalid request on the default provider. The nudge below is the
      // mechanism; the token top-up is the bound.
      expect(finish.toolChoice).toBeUndefined();
      expect(finish.resumeMessages).toEqual([
        ...readSomething,
        { role: "user", content: FINISH_NOW_NUDGE },
      ]);
      expect(r.text).toContain("Here is the explanation.");
    });

    it("does not bank the finish nudge into the turn's saved transcript", async () => {
      // The checkpoint a finish pass emits is [...resumeMessages, ...answer],
      // nudge included. Banked, it is persisted on the assistant message and
      // replayed by every LATER question as a prior user turn ordering the
      // model not to call tools — so one stalled Ask silently disabled code
      // search for the rest of the conversation.
      stoppedShort();
      const seen: ModelMessage[][] = [];
      await streamChatTask({ ...base, onTranscript: (m) => seen.push(m) });
      const banked = seen[seen.length - 1];
      expect(banked).not.toContainEqual({
        role: "user",
        content: FINISH_NOW_NUDGE,
      });
      expect(banked).toEqual([...readSomething, say("Here is the explanation.")]);
    });

    it("rations the finish pass by the resume top-up, not a second chat budget", async () => {
      stoppedShort();
      await streamChatTask({ ...base });
      expect(streamTask.mock.calls[1][0].tokenBudget).toBe(RESUME_TOPUP_TOKENS);
      expect(streamTask.mock.calls[0][0].tokenBudget).toBe(
        SURFACE_TOKEN_BUDGETS.draftChat,
      );
    });

    // The rescue is plumbing, and the user asked for it not to be narrated at
    // them: "Claude Code wouldn't stop reading the code, it would read what it
    // needs then tell me the answer." The narration still STREAMS (that is the
    // live sense of it working, and the reading strip beside it), but what
    // settles into the thread is the answer alone.
    it("settles to the answer alone — no narration, no note about reading steps", async () => {
      stoppedShort();
      const deltas: string[] = [];
      const r = await streamChatTask({ ...base, onText: (d) => deltas.push(d) });
      expect(r.text).toBe("Here is the explanation.");
      expect(r.text).not.toContain("Stopped after");
      expect(r.text).not.toContain("I'll dig into");
      // …and the user still watched it work.
      expect(deltas.join("")).toContain("I'll dig into the collect/migrate code.");
      expect(deltas.join("")).not.toContain("Stopped after");
    });

    it("keeps the narration when the rescue answers nothing either", async () => {
      // Settling to an empty answer would blank a bubble the user watched fill.
      stoppedShort("");
      const r = await streamChatTask({ ...base });
      expect(r.text).toBe("I'll dig into the collect/migrate code.");
    });

    it("finishes only once — a finish pass never triggers another", async () => {
      stoppedShort("");
      await streamChatTask({ ...base });
      expect(streamTask).toHaveBeenCalledTimes(2);
    });

    it("leaves an answered turn alone", async () => {
      streamTask.mockResolvedValue({
        ok: true,
        text: "the draft covers undo",
        finalText: "the draft covers undo",
        durationMs: 1,
      });
      await streamChatTask({ ...base });
      expect(streamTask).toHaveBeenCalledTimes(1);
    });

    it("does not pay for a finish pass when the turn read nothing", async () => {
      // An empty answer with no tool results has nothing to finish FROM — the
      // second call would re-ask the same question with the same context.
      streamTask.mockImplementation(async (args: Record<string, unknown>) => {
        (args.onCheckpoint as (c: { messages: ModelMessage[] }) => void)({
          messages: [say("")],
        });
        return { ok: true, text: "", finalText: "", stepsUsed: 1, durationMs: 1 };
      });
      await streamChatTask({ ...base });
      expect(streamTask).toHaveBeenCalledTimes(1);
    });

    it("cuts a cancel's dangling tool call out of the replay", async () => {
      streamTask.mockImplementation(async (args: Record<string, unknown>) => {
        (args.onCheckpoint as (c: { messages: ModelMessage[] }) => void)({
          messages: [...readSomething, toolCall("t2")],
        });
        return { ok: true, text: "narration", finalText: "", stepsUsed: 4, durationMs: 1 };
      });
      await streamChatTask({ ...base });
      expect(streamTask.mock.calls[1][0].resumeMessages).toEqual([
        ...readSomething,
        { role: "user", content: FINISH_NOW_NUDGE },
      ]);
    });
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

  it("tells the model what the user already asked for in Refine", async () => {
    // Reported: the review pane shows a follow-up history and a last-refine
    // diff, and "none of this gets passed to the model".
    await streamChatTask({
      ...base,
      cases: [kase()],
      refineRounds: [
        {
          timestamp: "2026-08-10T10:00:00Z",
          instruction: "drop the duplicate archive case",
          activityLog: [],
          beforeCases: 2,
          afterCases: 1,
          beforeBugs: 0,
          afterBugs: 0,
          outcome: "ok",
        },
      ] as never,
    });
    const ctx = streamTask.mock.calls[0][0].contextPrompt as string;
    expect(ctx).toContain("REFINE HISTORY");
    expect(ctx).toContain('"drop the duplicate archive case"');
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

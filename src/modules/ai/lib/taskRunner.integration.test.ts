import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { MockLanguageModelV3 } from "ai/test";

// Unlike taskRunner.test.ts (which mocks the AI SDK functions), this exercises
// the REAL generateObject / generateText / Output.object code paths against a
// mock *model*. It's the test that proves AI SDK v6 + Zod v4 structured output
// actually works end-to-end — the thing a mocked-SDK test cannot confirm.

let mockModel: MockLanguageModelV3;
vi.mock("./agent", () => ({
  buildConfiguredLanguageModel: vi.fn(async () => mockModel),
  buildStableSystem: (base: string) => base,
}));

import { runTask } from "./taskRunner";

// A realistic Zod v4 schema with defaults + nested arrays (mirrors DraftBatch /
// ConfidenceVerdict in spirit).
const Schema = z.object({
  cases: z
    .array(z.object({ title: z.string().min(1), n: z.number().int() }))
    .default([]),
  note: z.string().default(""),
});

function genModel(text: string): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text", text }],
      finishReason: "stop",
      usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
      warnings: [],
    }),
  } as never);
}

const base = {
  modelId: "gpt-5.4-mini" as never,
  keys: {} as never,
  systemPrompt: "SYS",
  prompt: "make it",
};

describe("taskRunner integration (real AI SDK + Zod v4, mock model)", () => {
  it("generateObject path validates a Zod v4 object", async () => {
    mockModel = genModel(
      JSON.stringify({ cases: [{ title: "Login", n: 1 }], note: "ok" }),
    );
    const r = await runTask({ ...base, schema: Schema, temperature: 0 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.object.cases).toEqual([{ title: "Login", n: 1 }]);
      expect(r.object.note).toBe("ok");
    }
  });

  it("generateObject applies Zod defaults for omitted fields", async () => {
    mockModel = genModel(JSON.stringify({ cases: [{ title: "X", n: 2 }] }));
    const r = await runTask({ ...base, schema: Schema });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.object.note).toBe(""); // default kicked in
  });

  it("experimental_output path (schema + tools) validates the object", async () => {
    mockModel = genModel(JSON.stringify({ cases: [{ title: "Y", n: 3 }], note: "t" }));
    const r = await runTask({
      ...base,
      schema: Schema,
      tools: { read_file: { description: "r", inputSchema: z.object({}) } } as never,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.object.cases[0]).toEqual({ title: "Y", n: 3 });
  });

  it("circuit breaker: model returns a schema-violating object → ok:false", async () => {
    // n must be an int; a string violates the schema → generateObject throws,
    // the runner retries then reports schema_violation.
    mockModel = genModel(JSON.stringify({ cases: [{ title: "Z", n: "nope" }] }));
    const r = await runTask({ ...base, schema: Schema, repairAttempts: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("schema_violation");
  });

  it("generateObject accepts the messages array buildUserTurn emits for images", async () => {
    // With an image attachment buildUserTurn returns { messages } instead of
    // { prompt }; confirm generateObject (Prompt = system + prompt|messages)
    // accepts that shape rather than throwing.
    mockModel = genModel(JSON.stringify({ cases: [{ title: "Img", n: 7 }] }));
    const r = await runTask({
      ...base,
      schema: Schema,
      attachments: [
        { kind: "image", content: "data:image/png;base64,AAAA", mime: "image/png" },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.object.cases[0]).toEqual({ title: "Img", n: 7 });
  });

  it("no-schema prose path returns the model text", async () => {
    mockModel = genModel("a plain prose answer");
    const r = await runTask({ ...base });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).toBe("a plain prose answer");
      expect(r.object).toBeUndefined();
    }
  });

  it("Anthropic cache path: the system message + breakpoint reaches the model via the real SDK", async () => {
    // For Anthropic the runner moves the system string into a cached system
    // MESSAGE (no top-level system). This proves the real SDK accepts that shape
    // end-to-end (the prompt conversion runs against the mock model) — the
    // plan's key risk to verify.
    let captured: { prompt?: Array<{ role: string }> } = {};
    mockModel = new MockLanguageModelV3({
      doGenerate: async (opts: { prompt?: Array<{ role: string }> }) => {
        captured = opts;
        return {
          content: [{ type: "text", text: "ok" }],
          finishReason: "stop",
          usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
          warnings: [],
        };
      },
    } as never);
    const r = await runTask({
      ...base,
      modelId: "claude-opus-5" as never,
      tools: { read_file: { description: "r", inputSchema: z.object({}) } } as never,
    });
    expect(r.ok).toBe(true);
    expect(captured.prompt?.some((m) => m.role === "system")).toBe(true);
  });
});

// The budget has to STOP a run, not merely be reported after one. That can only
// be shown against the real SDK loop — a mocked generateText walks whatever step
// list the test hands it and would "pass" with stopWhen wired to nothing.
describe("run budget stops the real SDK loop", () => {
  /** A model that never answers: every turn is another tool call. The runaway
   *  both guards exist for. `perStep` is the prompt size it reports. */
  function runawayModel(perStep: number): { model: MockLanguageModelV3; turns: () => number } {
    let turns = 0;
    return {
      model: new MockLanguageModelV3({
        doGenerate: async () => {
          turns++;
          return {
            content: [
              {
                type: "tool-call",
                toolCallId: `call-${turns}`,
                toolName: "read_file",
                input: "{}",
              },
            ],
            // PROVIDER-level shapes, both of them, which is not what the flat
            // `finishReason: "stop"` / `usage: { inputTokens: 5 }` in the older
            // helpers above look like. LanguageModelV3 nests both, and the SDK
            // flattens them on the way out — hand it the flat form and the
            // finish reason maps to "other" and every count comes back
            // undefined. Those tests assert on neither, so it never showed;
            // here it would make the mock silently spend nothing and report a
            // reason no budget stop could ever be told apart from a clean stop.
            finishReason: { unified: "tool-calls", raw: "tool_calls" },
            usage: {
              inputTokens: {
                total: perStep,
                noCache: perStep,
                cacheRead: 0,
                cacheWrite: 0,
              },
              outputTokens: { total: 0, text: 0, reasoning: 0 },
            },
            warnings: [],
          };
        },
      } as never),
      turns: () => turns,
    };
  }

  const tools = {
    read_file: {
      description: "read a file",
      inputSchema: z.object({}),
      execute: async () => "some file contents",
    },
  } as never;

  it("the TOKEN budget stops it, with steps to spare", async () => {
    // 30k/step against a 100k budget: the 4th step's request takes the running
    // total to 120k. The 40-step ceiling is nowhere near — nothing but the
    // token budget can end this run.
    const runaway = runawayModel(30_000);
    mockModel = runaway.model;
    const r = await runTask({
      ...base,
      schema: Schema,
      tools,
      maxSteps: 40,
      tokenBudget: 100_000,
    });

    expect(runaway.turns()).toBe(4);
    expect(r.stepsUsed).toBe(4);
    expect(r.tokensUsed).toBe(120_000);
    expect(r.limit).toBe("tokens");
    // Cut off mid-loop, never "the model returned bad output" — that
    // misclassification is what the resumable step_cap reason exists to end,
    // and it only reached the token stop once budgetReason stopped testing
    // `stepsUsed === maxSteps`.
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("step_cap");
  });

  it("…and where it stops MOVES with the budget", async () => {
    // The mutation, in-suite: double the budget and the same runaway model gets
    // twice as far. A stopWhen wired to nothing (or to steps alone) would report
    // the same number both times.
    const runaway = runawayModel(30_000);
    mockModel = runaway.model;
    await runTask({ ...base, schema: Schema, tools, maxSteps: 40, tokenBudget: 200_000 });
    expect(runaway.turns()).toBe(7);
  });

  it("the STEP ceiling still stops a loop that never spends anything", async () => {
    // The endpoint that reports no usage — local servers routinely don't. The
    // token budget is structurally blind here, so the ceiling is the only guard
    // there is, and it is why the step count was kept rather than deleted.
    const runaway = runawayModel(0);
    mockModel = runaway.model;
    const r = await runTask({
      ...base,
      schema: Schema,
      tools,
      maxSteps: 5,
      tokenBudget: 2_500_000,
    });

    expect(runaway.turns()).toBe(5);
    expect(r.tokensUsed).toBe(0);
    expect(r.limit).toBe("steps");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("step_cap");
  });

  it("…and where THAT stops moves with the ceiling", async () => {
    const runaway = runawayModel(0);
    mockModel = runaway.model;
    await runTask({ ...base, schema: Schema, tools, maxSteps: 9, tokenBudget: 2_500_000 });
    expect(runaway.turns()).toBe(9);
  });

  it("a run that answers inside its budget is untouched by either guard", async () => {
    mockModel = genModel(JSON.stringify({ cases: [{ title: "Fine", n: 1 }] }));
    const r = await runTask({
      ...base,
      schema: Schema,
      tools,
      maxSteps: 40,
      tokenBudget: 2_500_000,
    });
    expect(r.ok).toBe(true);
    expect(r.limit).toBeUndefined();
  });
});

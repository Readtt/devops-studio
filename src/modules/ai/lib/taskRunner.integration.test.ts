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
});

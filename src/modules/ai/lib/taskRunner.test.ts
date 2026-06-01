import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";

// --- Mock the AI SDK so we assert dispatch without real network calls. ------
const generateObject = vi.fn();
const generateText = vi.fn();
const streamText = vi.fn();

vi.mock("ai", () => ({
  generateObject: (...a: unknown[]) => generateObject(...a),
  generateText: (...a: unknown[]) => generateText(...a),
  streamText: (...a: unknown[]) => streamText(...a),
  stepCountIs: (n: number) => ({ __stepCountIs: n }),
}));

// Stub model construction + system assembly (system assembly is the identity
// for a base-only prompt, which is all these tests pass).
vi.mock("./agent", () => ({
  buildConfiguredLanguageModel: vi.fn(async () => ({ __model: true })),
  buildStableSystem: (base: string) => base,
}));

import { runTask, streamTask } from "./taskRunner";

const baseInput = {
  modelId: "gpt-5.4-mini" as never,
  keys: {} as never,
  systemPrompt: "SYS",
  prompt: "hello",
};

beforeEach(() => {
  generateObject.mockReset();
  generateText.mockReset();
  streamText.mockReset();
});

describe("runTask mode dispatch", () => {
  it("schema + no tools → generateObject", async () => {
    const schema = z.object({ a: z.number() });
    generateObject.mockResolvedValue({ object: { a: 1 } });
    const r = await runTask({ ...baseInput, schema });
    expect(generateObject).toHaveBeenCalledTimes(1);
    expect(generateText).not.toHaveBeenCalled();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.object).toEqual({ a: 1 });
  });

  it("schema + tools → generateText (no experimental_output), validates final text", async () => {
    const schema = z.object({ a: z.number() });
    // Model runs its tool loop and emits the object as its final text.
    generateText.mockResolvedValue({ text: JSON.stringify({ a: 2 }) });
    const tools = { read_file: { description: "read" } } as never;
    const r = await runTask({ ...baseInput, schema, tools });
    expect(generateText).toHaveBeenCalledTimes(1);
    const arg = generateText.mock.calls[0][0] as Record<string, unknown>;
    // We deliberately do NOT use the unreliable experimental_output.
    expect(arg.experimental_output).toBeUndefined();
    // The runner passes the caller's tools through UNCHANGED — never injects.
    expect(arg.tools).toBe(tools);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.object).toEqual({ a: 2 });
  });

  it("no schema → generateText prose, no experimental_output", async () => {
    generateText.mockResolvedValue({ text: "prose" });
    const r = await runTask({ ...baseInput });
    const arg = generateText.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.experimental_output).toBeUndefined();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).toBe("prose");
      expect(r.object).toBeUndefined();
    }
  });

  it("circuit breaker: repeated schema failure → ok:false schema_violation", async () => {
    const schema = z.object({ a: z.number() });
    generateObject.mockRejectedValue(
      Object.assign(new Error("no object"), { text: "garbage" }),
    );
    const r = await runTask({ ...baseInput, schema, repairAttempts: 1 });
    // attempt 0 + 1 repair = 2 calls before the breaker trips.
    expect(generateObject).toHaveBeenCalledTimes(2);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("schema_violation");
      expect(r.text).toBe("garbage");
    }
  });

  it("structured + tools with no usable object → ok:false schema_violation", async () => {
    const schema = z.object({ a: z.number() });
    generateText.mockResolvedValue({ text: "oops", experimental_output: undefined });
    const r = await runTask({ ...baseInput, schema, tools: { grep: {} } as never });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("schema_violation");
  });

  it("never injects mutator tools — a tool-less call carries no tools key", async () => {
    generateText.mockResolvedValue({ text: "x" });
    await runTask({ ...baseInput });
    const arg = generateText.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.tools).toBeUndefined();
  });
});

describe("streamTask", () => {
  it("streams prose deltas and resolves accumulated text", async () => {
    streamText.mockReturnValue({
      textStream: (async function* () {
        yield "a";
        yield "b";
      })(),
    });
    const chunks: string[] = [];
    const r = await streamTask({ ...baseInput, onText: (d) => chunks.push(d) });
    expect(chunks).toEqual(["a", "b"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).toBe("ab");
      expect(r.object).toBeUndefined();
    }
  });

  it("structured stream validates the accumulated final text against the schema", async () => {
    const schema = z.object({ a: z.number() });
    streamText.mockReturnValue({
      textStream: (async function* () {
        yield '{"a":';
        yield "9}";
      })(),
    });
    const r = await streamTask({
      ...baseInput,
      schema,
      tools: { read_file: {} } as never,
      onText: () => {},
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.object).toEqual({ a: 9 });
  });
});

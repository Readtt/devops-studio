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

  // streamText NEVER rejects: provider/network errors mid-stream go to the
  // `onError` callback and textStream simply ends. Without surfacing them, a
  // rate-limited or dropped run masquerades as "the model returned bad output"
  // (the exact misreport users hit in Commit Review). These pin the contract:
  // real errors reject; the caller's catch shows the true provider message.

  it("rejects with the real provider error when the stream errors mid-run (schema mode)", async () => {
    const schema = z.object({ a: z.number() });
    const providerError = new Error(
      "rate_limit_error: This request would exceed your organization's rate limit",
    );
    streamText.mockImplementation((opts: { onError?: (e: { error: unknown }) => void }) => ({
      textStream: (async function* () {
        yield "I'll start by examining the changed files and their context";
        // The follow-up request 429'd: SDK reports via onError, stream ends.
        opts.onError?.({ error: providerError });
      })(),
    }));
    await expect(
      streamTask({
        ...baseInput,
        schema,
        tools: { read_file: {} } as never,
        onText: () => {},
      }),
    ).rejects.toThrow(/rate_limit_error/);
  });

  it("rejects with the real provider error when a prose stream errors mid-run", async () => {
    const providerError = new Error("overloaded_error: upstream is overloaded");
    streamText.mockImplementation((opts: { onError?: (e: { error: unknown }) => void }) => ({
      textStream: (async function* () {
        yield "partial answer…";
        opts.onError?.({ error: providerError });
      })(),
    }));
    await expect(
      streamTask({ ...baseInput, onText: () => {} }),
    ).rejects.toThrow(/overloaded_error/);
  });

  it("rejects with AbortError when the caller aborted (maps to 'cancelled', not an error state)", async () => {
    const abort = new AbortController();
    streamText.mockImplementation(() => ({
      textStream: (async function* () {
        yield "partial";
        abort.abort();
      })(),
    }));
    await expect(
      streamTask({
        ...baseInput,
        signal: abort.signal,
        onText: () => {},
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("salvages a fully-valid schema object even if the stream errored after it", async () => {
    const schema = z.object({ a: z.number() });
    streamText.mockImplementation((opts: { onError?: (e: { error: unknown }) => void }) => ({
      textStream: (async function* () {
        yield '{"a":7}';
        // Trailing blip after the complete object — result is still usable.
        opts.onError?.({ error: new Error("connection reset") });
      })(),
    }));
    const r = await streamTask({
      ...baseInput,
      schema,
      tools: { read_file: {} } as never,
      onText: () => {},
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.object).toEqual({ a: 7 });
  });
});

describe("prompt caching (Anthropic breakpoint)", () => {
  // "claude-opus-5" resolves to provider "anthropic" via the real config
  // registry (config is not mocked here); "gpt-5.4-mini" resolves to "openai".
  const anthropic = { ...baseInput, modelId: "claude-opus-5" as never };

  it("generateText: Anthropic gets a cached system message and NO top-level system", async () => {
    generateText.mockResolvedValue({ text: "ok" });
    await runTask({ ...anthropic, tools: { read_file: {} } as never });
    const arg = generateText.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.system).toBeUndefined();
    const messages = arg.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toMatchObject({
      role: "system",
      content: "SYS",
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    });
    expect(messages[1]).toMatchObject({ role: "user", content: "hello" });
  });

  it("streamText: Anthropic gets a cached system message", async () => {
    streamText.mockReturnValue({
      textStream: (async function* () {
        yield "x";
      })(),
    });
    await streamTask({
      ...anthropic,
      tools: { grep: {} } as never,
      onText: () => {},
    });
    const arg = streamText.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.system).toBeUndefined();
    const messages = arg.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toMatchObject({
      role: "system",
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    });
  });

  it("non-Anthropic stays byte-identical: top-level system + prompt, no messages", async () => {
    generateText.mockResolvedValue({ text: "ok" });
    await runTask({ ...baseInput }); // gpt-5.4-mini → openai (auto-caches)
    const arg = generateText.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.system).toBe("SYS");
    expect(arg.prompt).toBe("hello");
    expect(arg.messages).toBeUndefined();
  });

  it("Anthropic preserves image/vision parts in the user message", async () => {
    generateText.mockResolvedValue({ text: "ok" });
    await runTask({
      ...anthropic,
      attachments: [
        { kind: "image", content: "data:image/png;base64,AAA", mime: "image/png" },
      ] as never,
    });
    const arg = generateText.mock.calls[0][0] as Record<string, unknown>;
    const messages = arg.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toMatchObject({ role: "system" });
    const userMsg = messages[1] as {
      role: string;
      content: Array<Record<string, unknown>>;
    };
    expect(userMsg.role).toBe("user");
    expect(userMsg.content.some((p) => p.type === "image")).toBe(true);
    expect(
      userMsg.content.some((p) => p.type === "text" && p.text === "hello"),
    ).toBe(true);
  });

  it("tool-less generateObject is left uncached even for Anthropic (deliberate)", async () => {
    const schema = z.object({ a: z.number() });
    generateObject.mockResolvedValue({ object: { a: 1 } });
    await runTask({ ...anthropic, schema });
    const arg = generateObject.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.system).toBe("SYS");
    expect(arg.messages).toBeUndefined();
  });
});

describe("rate-limit resilience", () => {
  const anthropic = { ...baseInput, modelId: "claude-opus-5" as never };
  type Msg = {
    role: string;
    content: string;
    providerOptions?: Record<string, Record<string, unknown>>;
  };
  type PrepareStep = (input: { messages: Msg[] }) =>
    | { messages: Msg[] }
    | undefined;

  it("raises maxRetries on every call path so Retry-After windows are ridden out", async () => {
    generateText.mockResolvedValue({ text: "ok" });
    await runTask({ ...baseInput });
    expect(
      (generateText.mock.calls[0][0] as { maxRetries?: number }).maxRetries,
    ).toBe(6);

    generateObject.mockResolvedValue({ object: { a: 1 } });
    await runTask({ ...baseInput, schema: z.object({ a: z.number() }) });
    expect(
      (generateObject.mock.calls[0][0] as { maxRetries?: number }).maxRetries,
    ).toBe(6);

    streamText.mockReturnValue({
      textStream: (async function* () {
        yield "x";
      })(),
    });
    await streamTask({ ...baseInput, onText: () => {} });
    expect(
      (streamText.mock.calls[0][0] as { maxRetries?: number }).maxRetries,
    ).toBe(6);
  });

  it("Anthropic + tools gets a per-step cache prepareStep; other providers don't", async () => {
    generateText.mockResolvedValue({ text: "ok" });
    await runTask({ ...anthropic, tools: { read_file: {} } as never });
    const anthropicArg = generateText.mock.calls[0][0] as {
      prepareStep?: PrepareStep;
    };
    expect(typeof anthropicArg.prepareStep).toBe("function");

    generateText.mockClear();
    generateText.mockResolvedValue({ text: "ok" });
    await runTask({ ...baseInput, tools: { read_file: {} } as never }); // openai
    const openaiArg = generateText.mock.calls[0][0] as {
      prepareStep?: PrepareStep;
    };
    expect(openaiArg.prepareStep).toBeUndefined();

    // Tool-less runs are single-request — no step loop, no prepareStep.
    generateText.mockClear();
    generateText.mockResolvedValue({ text: "ok" });
    await runTask({ ...anthropic });
    expect(
      (generateText.mock.calls[0][0] as { prepareStep?: PrepareStep })
        .prepareStep,
    ).toBeUndefined();
  });

  it("prepareStep tags ONLY the last message, keeps the system breakpoint, strips stale tags, and never mutates its input", async () => {
    streamText.mockReturnValue({
      textStream: (async function* () {
        yield "x";
      })(),
    });
    await streamTask({
      ...anthropic,
      tools: { grep: {} } as never,
      onText: () => {},
    });
    const prepareStep = (
      streamText.mock.calls[0][0] as { prepareStep: PrepareStep }
    ).prepareStep;

    const cache = { cacheControl: { type: "ephemeral" } };
    const messages: Msg[] = [
      { role: "system", content: "SYS", providerOptions: { anthropic: cache } },
      { role: "user", content: "big diff" },
      // Simulates a stale tag from a prior step surviving in the array — the
      // sweep must remove it so a request never exceeds 2 breakpoints.
      { role: "assistant", content: "calling tools", providerOptions: { anthropic: cache } },
      { role: "tool", content: "tool result" },
    ];
    const snapshot = JSON.parse(JSON.stringify(messages));
    const result = prepareStep({ messages });
    expect(result).toBeDefined();
    const out = result!.messages;
    // System breakpoint intact, stale mid-array tag gone, last message tagged.
    expect(out[0].providerOptions?.anthropic).toMatchObject(cache);
    expect(out[1].providerOptions?.anthropic).toBeUndefined();
    expect(out[2].providerOptions?.anthropic).not.toHaveProperty("cacheControl");
    expect(out[3].providerOptions?.anthropic).toMatchObject(cache);
    // Input untouched (the SDK reuses its own arrays across steps).
    expect(messages).toEqual(snapshot);
    // Degenerate request: nothing to cache.
    expect(prepareStep({ messages: [messages[0]] })).toBeUndefined();
  });
});

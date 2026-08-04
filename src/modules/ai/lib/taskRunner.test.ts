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

import { runTask, streamTask, type TaskCheckpoint } from "./taskRunner";

const baseInput = {
  modelId: "gpt-5.4-mini" as never,
  keys: {} as never,
  systemPrompt: "SYS",
  prompt: "hello",
};

// --- Fabricated StepResult shapes for the agentic-loop callbacks ------------
type FakeUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  inputTokenDetails?: { cacheReadTokens?: number };
  cachedInputTokens?: number;
};
type FakeStep = {
  response: { messages: Array<Record<string, unknown>> };
  finishReason: string;
  usage?: FakeUsage;
  text?: string;
};

function step(
  label: string,
  finishReason = "tool-calls",
  usage?: FakeUsage,
): FakeStep {
  return {
    response: { messages: [{ role: "assistant", content: label }] },
    finishReason,
    usage,
  };
}

/** generateText that walks the given steps through `onStepFinish` (as the SDK
 *  does once each model turn + its tool round-trips complete) then resolves. */
function generateTextOverSteps(steps: FakeStep[], text: string) {
  generateText.mockImplementation(
    async (opts: { onStepFinish?: (s: FakeStep) => void }) => {
      for (const s of steps) opts.onStepFinish?.(s);
      return { text };
    },
  );
}

/** streamText equivalent: steps land while the text stream is draining. */
function streamTextOverSteps(steps: FakeStep[], chunks: string[]) {
  streamText.mockImplementation((opts: { onStepFinish?: (s: FakeStep) => void }) => ({
    textStream: (async function* () {
      for (const s of steps) opts.onStepFinish?.(s);
      for (const c of chunks) yield c;
    })(),
  }));
}

/** Only the prompt-shaping keys of a request — what must not drift. */
function promptShape(arg: Record<string, unknown>): Record<string, unknown> {
  const shape: Record<string, unknown> = {};
  for (const k of ["system", "prompt", "messages"] as const) {
    if (k in arg) shape[k] = arg[k];
  }
  return shape;
}

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

describe("conversation turns (contextPrompt + priorMessages)", () => {
  const anthropic = { ...baseInput, modelId: "claude-opus-5" as never };
  const history = [
    { role: "user" as const, content: "q1" },
    { role: "assistant" as const, content: "a1" },
  ];

  it("orders the request stable-context → history → new question", async () => {
    generateText.mockResolvedValue({ text: "ok" });
    await runTask({
      ...baseInput,
      contextPrompt: "CTX",
      priorMessages: history,
    });
    const arg = generateText.mock.calls[0][0] as Record<string, unknown>;
    // Non-Anthropic keeps the top-level system; only the user side becomes
    // messages.
    expect(arg.system).toBe("SYS");
    expect(arg.prompt).toBeUndefined();
    expect(arg.messages).toEqual([
      { role: "user", content: "CTX" },
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "hello" },
    ]);
  });

  it("a later turn's request is the earlier one plus two messages", async () => {
    // THE cache property. Anthropic matches a cached PREFIX, so a turn is only
    // cheap when its request is the previous request with turns appended — not
    // when it is the same content rebuilt with the conversation spliced into
    // the middle, which is what the prose history block did.
    generateText.mockResolvedValue({ text: "ok" });
    await runTask({ ...baseInput, contextPrompt: "CTX", priorMessages: history });
    await runTask({
      ...baseInput,
      prompt: "third question",
      contextPrompt: "CTX",
      priorMessages: [
        ...history,
        { role: "user" as const, content: "hello" },
        { role: "assistant" as const, content: "a2" },
      ],
    });
    const first = (generateText.mock.calls[0][0] as { messages: unknown[] })
      .messages;
    const second = (generateText.mock.calls[1][0] as { messages: unknown[] })
      .messages;
    expect(second.length).toBe(first.length + 2);
    expect(second.slice(0, first.length)).toEqual(first);
  });

  it("Anthropic's cache breakpoint still lands on the newest turn", async () => {
    generateText.mockResolvedValue({ text: "ok" });
    await runTask({
      ...anthropic,
      tools: { read_file: {} } as never,
      contextPrompt: "CTX",
      priorMessages: history,
    });
    const prepare = (
      generateText.mock.calls[0][0] as {
        prepareStep: (a: { messages: unknown[] }) => { messages: unknown[] };
      }
    ).prepareStep;
    const sent = (generateText.mock.calls[0][0] as { messages: unknown[] })
      .messages;
    const out = prepare({ messages: sent }).messages as Array<
      Record<string, unknown>
    >;
    expect(out[0]).toMatchObject({ role: "system" });
    expect(out[out.length - 1]).toMatchObject({
      role: "user",
      content: "hello",
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    });
  });

  it("images ride the newest turn, not the stable context", async () => {
    generateText.mockResolvedValue({ text: "ok" });
    await runTask({
      ...anthropic,
      contextPrompt: "CTX",
      priorMessages: history,
      attachments: [
        { kind: "image", content: "data:image/png;base64,AAA", mime: "image/png" },
      ] as never,
    });
    const messages = (
      generateText.mock.calls[0][0] as { messages: Array<Record<string, unknown>> }
    ).messages;
    expect(messages[1]).toEqual({ role: "user", content: "CTX" });
    const last = messages[messages.length - 1] as {
      content: Array<Record<string, unknown>>;
    };
    expect(last.content.some((p) => p.type === "image")).toBe(true);
  });

  it("a surface that passes neither sends exactly what it sent before", async () => {
    // The whole feature has to be inert for single-turn surfaces: a bare
    // `{ prompt }` string, not a one-element messages array that would change
    // the bytes every auto-caching provider matches on.
    generateText.mockResolvedValue({ text: "ok" });
    await runTask({ ...baseInput, contextPrompt: "   ", priorMessages: [] });
    const arg = generateText.mock.calls[0][0] as Record<string, unknown>;
    expect(promptShape(arg)).toEqual({ system: "SYS", prompt: "hello" });
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

  it("every tool-bearing run gets a prepareStep; tool-less runs never do", async () => {
    // Compaction has to run for EVERY provider (they all have a window), so
    // prepareStep is no longer Anthropic-only. For a non-Anthropic run with
    // nothing to evict it returns undefined, which leaves the request exactly
    // as it was — see "leaves a non-Anthropic request untouched" below.
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
    expect(typeof openaiArg.prepareStep).toBe("function");

    // Tool-less runs are single-request — no step loop, no tool results to
    // evict, no prepareStep.
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

// The transcript the agentic loop accumulates is what makes a dead run
// resumable; before this it was dropped on the floor when the run failed.
describe("checkpoints (transcript capture)", () => {
  const toolInput = { ...baseInput, tools: { read_file: {} } as never };

  it("fires once per completed step with the transcript accumulated so far", async () => {
    generateTextOverSteps([step("s1"), step("s2", "stop")], "done");
    const seen: TaskCheckpoint[] = [];
    await runTask({ ...toolInput, onCheckpoint: (cp) => seen.push(cp) });

    expect(seen).toHaveLength(2);
    expect(seen[0].stepsUsed).toBe(1);
    expect(seen[0].messages).toEqual([{ role: "assistant", content: "s1" }]);
    expect(seen[0].finishReason).toBe("tool-calls");
    expect(seen[1].stepsUsed).toBe(2);
    expect(seen[1].messages).toEqual([
      { role: "assistant", content: "s1" },
      { role: "assistant", content: "s2" },
    ]);
    expect(seen[1].finishReason).toBe("stop");
  });

  it("snapshots each checkpoint so a stored one never mutates under the caller", async () => {
    generateTextOverSteps([step("s1"), step("s2")], "done");
    const seen: TaskCheckpoint[] = [];
    await runTask({ ...toolInput, onCheckpoint: (cp) => seen.push(cp) });
    // The first checkpoint still describes step 1 only, after step 2 landed.
    expect(seen[0].messages).toHaveLength(1);
    expect(seen[0].usage).not.toBe(seen[1].usage);
  });

  it("sums usage across steps, counting the re-sent transcript as billed", async () => {
    generateTextOverSteps(
      [
        step("s1", "tool-calls", {
          inputTokens: 1000,
          outputTokens: 50,
          totalTokens: 1050,
          inputTokenDetails: { cacheReadTokens: 900 },
        }),
        step("s2", "stop", {
          inputTokens: 1200,
          outputTokens: 80,
          totalTokens: 1280,
          // Deprecated alias — some providers still report cache reads here.
          cachedInputTokens: 1100,
        }),
      ],
      "done",
    );
    const seen: TaskCheckpoint[] = [];
    const r = await runTask({ ...toolInput, onCheckpoint: (cp) => seen.push(cp) });

    expect(seen[1].usage).toEqual({
      inputTokens: 2200,
      outputTokens: 130,
      totalTokens: 2330,
      cacheReadTokens: 2000,
    });
    expect(r.usage).toEqual(seen[1].usage);
  });

  it("leaves a count the provider never reported absent rather than NaN or 0", async () => {
    generateTextOverSteps(
      [
        step("s1", "tool-calls", { inputTokens: 10 }),
        step("s2", "stop", { outputTokens: 5 }),
      ],
      "done",
    );
    const r = await runTask(toolInput);
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(r.usage?.totalTokens).toBeUndefined();
    expect(r.usage?.cacheReadTokens).toBeUndefined();
  });

  it("accumulates even with no callbacks subscribed — the result scalars need it", async () => {
    generateTextOverSteps([step("s1"), step("s2"), step("s3", "stop")], "done");
    const r = await runTask(toolInput); // no onCheckpoint, no onToolEvent
    expect(r.stepsUsed).toBe(3);
    expect(r.finishReason).toBe("stop");
  });

  it("still emits tool activity for every step (unchanged behaviour)", async () => {
    generateTextOverSteps([step("s1"), step("s2", "stop")], "done");
    const events: Array<{ kind: string }> = [];
    await runTask({ ...toolInput, onToolEvent: (e) => events.push(e) });
    // No toolCalls on the fabricated steps ⇒ one "thinking" entry per step.
    expect(events.map((e) => e.kind)).toEqual(["thinking", "thinking"]);
  });

  it("streamTask reports checkpoints and scalars the same way", async () => {
    streamTextOverSteps([step("s1"), step("s2", "stop")], ["a", "b"]);
    const seen: TaskCheckpoint[] = [];
    const r = await streamTask({
      ...toolInput,
      onText: () => {},
      onCheckpoint: (cp) => seen.push(cp),
    });
    expect(seen.map((c) => c.stepsUsed)).toEqual([1, 2]);
    expect(seen[1].messages).toHaveLength(2);
    expect(r.stepsUsed).toBe(2);
    expect(r.finishReason).toBe("stop");
  });

  it("a salvaged trailing-error result still carries the scalars", async () => {
    const schema = z.object({ a: z.number() });
    streamText.mockImplementation(
      (opts: {
        onStepFinish?: (s: FakeStep) => void;
        onError?: (e: { error: unknown }) => void;
      }) => ({
        textStream: (async function* () {
          opts.onStepFinish?.(step("s1", "stop", { inputTokens: 7 }));
          yield '{"a":7}';
          opts.onError?.({ error: new Error("connection reset") });
        })(),
      }),
    );
    const r = await streamTask({
      ...toolInput,
      schema,
      onText: () => {},
    });
    expect(r.ok).toBe(true);
    expect(r.stepsUsed).toBe(1);
    expect(r.usage).toEqual({ inputTokens: 7 });
  });

  it("the tool-less generateObject path reports zero steps", async () => {
    const schema = z.object({ a: z.number() });
    generateObject.mockResolvedValue({
      object: { a: 1 },
      usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
    });
    const onCheckpoint = vi.fn();
    const r = await runTask({ ...baseInput, schema, onCheckpoint });
    expect(onCheckpoint).not.toHaveBeenCalled();
    expect(r.stepsUsed).toBe(0);
    expect(r.usage).toEqual({ inputTokens: 3, outputTokens: 4, totalTokens: 7 });
  });
});

// The provider already tells us the true size of every request it answers;
// before this it was accumulated for billing and never compared to the window.
// This is the measurement Phase 3's eviction decision hangs off.
describe("in-run context signal", () => {
  // claude-haiku-4-5 → a 200k window, so the arithmetic below is legible.
  const toolInput = {
    ...baseInput,
    modelId: "claude-haiku-4-5" as never,
    tools: { read_file: {} } as never,
  };

  it("measures each step's OWN request, not the running billed sum", async () => {
    generateTextOverSteps(
      [
        step("s1", "tool-calls", { inputTokens: 40_000 }),
        step("s2", "stop", { inputTokens: 55_000 }),
      ],
      "done",
    );
    const seen: Array<{ promptTokens: number }> = [];
    const r = await runTask({
      ...toolInput,
      onContextSignal: (s) => seen.push(s),
    });
    // Summing would report 95k — what was billed, not what has to fit.
    expect(seen.map((s) => s.promptTokens)).toEqual([40_000, 55_000]);
    expect(r.usage?.inputTokens).toBe(95_000);
    expect(r.context?.promptTokens).toBe(55_000);
    expect(r.context?.windowTokens).toBe(200_000);
    expect(r.context?.shouldCompact).toBe(false);
  });

  it("rides along on every checkpoint so a resumed run knows where it was", async () => {
    generateTextOverSteps(
      [step("s1", "tool-calls", { inputTokens: 40_000 })],
      "done",
    );
    const seen: TaskCheckpoint[] = [];
    await runTask({ ...toolInput, onCheckpoint: (cp) => seen.push(cp) });
    expect(seen[0].context?.promptTokens).toBe(40_000);
  });

  it("raises shouldCompact once the request is inside the buffer", async () => {
    generateTextOverSteps(
      [step("s1", "stop", { inputTokens: 190_000 })],
      "done",
    );
    const r = await runTask(toolInput);
    expect(r.context?.shouldCompact).toBe(true);
    expect(r.context?.headroomTokens).toBeLessThan(13_000);
  });

  it("stays absent when the provider reports no input count", async () => {
    generateTextOverSteps([step("s1", "stop", { outputTokens: 12 })], "done");
    const onContextSignal = vi.fn();
    const r = await runTask({ ...toolInput, onContextSignal });
    expect(onContextSignal).not.toHaveBeenCalled();
    expect(r.context).toBeUndefined();
  });

  it("keeps the last real reading when a later step reports nothing", async () => {
    generateTextOverSteps(
      [
        step("s1", "tool-calls", { inputTokens: 40_000 }),
        step("s2", "stop", { outputTokens: 9 }),
      ],
      "done",
    );
    const r = await runTask(toolInput);
    expect(r.context?.promptTokens).toBe(40_000);
  });

  it("streamTask measures the same way", async () => {
    streamTextOverSteps(
      [
        step("s1", "tool-calls", { inputTokens: 40_000 }),
        step("s2", "stop", {
          inputTokens: 60_000,
          inputTokenDetails: { cacheReadTokens: 48_000 },
        }),
      ],
      ["a", "b"],
    );
    const r = await streamTask({ ...toolInput, onText: () => {} });
    expect(r.context?.promptTokens).toBe(60_000);
    expect(r.context?.cacheHitRatio).toBeCloseTo(0.8);
  });
});

// Phase 3: tool-result eviction. compactTranscript.test.ts owns the eviction
// RULE; this owns the wiring — when it arms, that it composes with the Anthropic
// cache breakpoint rather than replacing it, and that a run which never fills
// the window keeps sending exactly the bytes it sent before eviction existed.
describe("context compaction (tool-result eviction)", () => {
  type Msg = Record<string, unknown>;
  type Prepared = { messages: Msg[] } | undefined;

  /** 120,000 chars ⇒ 30,000 tokens: two of them blow the 50,000-token
   *  tool-result budget, so a three-turn transcript evicts its two oldest. */
  const HUGE = 120_000;
  let seq = 0;
  function bigTurn(tool: string, input: Record<string, unknown>, tag: string): Msg[] {
    const toolCallId = `c${++seq}`;
    return [
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId, toolName: tool, input }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId,
            toolName: tool,
            output: { type: "text", value: `// ${tag}\n${"y".repeat(HUGE)}` },
          },
        ],
      },
    ];
  }

  /** A turn whose result is far too small to move the eviction boundary. */
  function smallTurn(tool: string, input: Record<string, unknown>, out: string): Msg[] {
    const toolCallId = `c${++seq}`;
    return [
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId, toolName: tool, input }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId,
            toolName: tool,
            output: { type: "text", value: out },
          },
        ],
      },
    ];
  }

  const promptMessages: Msg[] = [
    { role: "system", content: "SYS" },
    { role: "user", content: "hello" },
  ];

  function transcript(turns: number): Msg[] {
    const out = [...promptMessages];
    for (let i = 0; i < turns; i++) {
      out.push(...bigTurn("read_file", { path: `src/f${i}.ts` }, `f${i}`));
    }
    return out;
  }

  const stubCount = (messages: Msg[]) =>
    JSON.stringify(messages).split("[evicted-tool-result #").length - 1;

  /** generateText that drives the loop the way the SDK does: prepareStep runs
   *  BEFORE each request, onStepFinish after it. `transcripts[i]` stands in for
   *  the `[...initialMessages, ...responseMessages]` the SDK rebuilds each step. */
  function loopWithPrepare(steps: FakeStep[], transcripts: Msg[][]) {
    const prepared: Prepared[] = [];
    generateText.mockImplementation(
      async (opts: {
        prepareStep?: (i: { messages: Msg[]; stepNumber: number }) => Prepared;
        onStepFinish?: (s: FakeStep) => void;
      }) => {
        for (let i = 0; i < steps.length; i++) {
          prepared.push(opts.prepareStep?.({ messages: transcripts[i], stepNumber: i }));
          opts.onStepFinish?.(steps[i]);
        }
        return { text: "done" };
      },
    );
    return prepared;
  }

  // claude-haiku-4-5 → 200k window ⇒ 192k usable ⇒ shouldCompact past 179k.
  const haiku = {
    ...baseInput,
    modelId: "claude-haiku-4-5" as never,
    tools: { read_file: {} } as never,
  };
  const CALM = { inputTokens: 40_000 };
  const TIGHT = { inputTokens: 190_000 };

  it("stays dormant until a step's MEASURED prompt lands inside the compaction buffer", async () => {
    // This is the property that makes eviction safe by construction: after the
    // Phase 1 caps an ordinary run never gets within 13,000 tokens of the
    // window, so an ordinary run's transcript is never touched at all.
    const t = transcript(3);
    const prepared = loopWithPrepare(
      [step("s1", "tool-calls", CALM), step("s2", "tool-calls", CALM), step("s3", "stop", CALM)],
      [t, t, t],
    );
    await runTask(haiku);
    for (const p of prepared) expect(stubCount(p?.messages ?? [])).toBe(0);
  });

  it("evicts from the step AFTER the one that reported the pressure", async () => {
    const t = transcript(3);
    const prepared = loopWithPrepare(
      [step("s1", "tool-calls", CALM), step("s2", "tool-calls", TIGHT), step("s3", "stop", TIGHT)],
      [t, t, t],
    );
    await runTask(haiku);
    // step 0: no reading yet. step 1: last reading was 40k. step 2: 190k → armed.
    expect(stubCount(prepared[0]?.messages ?? [])).toBe(0);
    expect(stubCount(prepared[1]?.messages ?? [])).toBe(0);
    expect(stubCount(prepared[2]!.messages)).toBe(2);
  });

  it("stays armed once it fires — a smaller follow-up request must not un-evict", async () => {
    // Eviction shrinks the next request, which drops it back under the buffer.
    // Without the latch that un-compacts, re-compacts, and rewrites the prefix
    // on EVERY step — the cache-invalidation failure this phase exists to avoid.
    const t = transcript(3);
    const prepared = loopWithPrepare(
      [step("s1", "tool-calls", TIGHT), step("s2", "tool-calls", CALM), step("s3", "stop", CALM)],
      [t, t, t],
    );
    await runTask(haiku);
    expect(stubCount(prepared[0]?.messages ?? [])).toBe(0);
    expect(stubCount(prepared[1]!.messages)).toBe(2);
    expect(stubCount(prepared[2]!.messages)).toBe(2);
    expect(JSON.stringify(prepared[2]!.messages)).toBe(
      JSON.stringify(prepared[1]!.messages),
    );
  });

  it("compactContext: false turns it off entirely (the bisect switch)", async () => {
    const t = transcript(3);
    const prepared = loopWithPrepare(
      [step("s1", "tool-calls", TIGHT), step("s2", "stop", TIGHT)],
      [t, t],
    );
    await runTask({ ...haiku, compactContext: false });
    for (const p of prepared) expect(stubCount(p?.messages ?? [])).toBe(0);
  });

  it("composes with the Anthropic breakpoint rather than being replaced by it", async () => {
    // buildRequestPrompt hands Anthropic an already-tagged system message; the
    // fixture mirrors that so the sweep has something real to preserve.
    const t = transcript(3);
    t[0] = {
      ...t[0],
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    };
    const prepared = loopWithPrepare(
      [step("s1", "tool-calls", TIGHT), step("s2", "stop", TIGHT)],
      [t, t],
    );
    await runTask(haiku);
    const out = prepared[1]!.messages;
    expect(stubCount(out)).toBe(2);
    // System breakpoint kept, breakpoint on the LAST message — and that last
    // message is the compacted one, not a pre-compaction copy.
    expect(out[0].providerOptions).toMatchObject({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
    expect(out[out.length - 1].providerOptions).toMatchObject({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
    expect(out[1].providerOptions).toBeUndefined();
    // The tagged tail is the newest tool result, kept verbatim — a breakpoint
    // over a message whose bytes changed after tagging would cache the wrong thing.
    expect(JSON.stringify(out[out.length - 1])).toContain("y".repeat(1_000));
  });

  it("leaves a non-Anthropic request untouched when nothing was evicted", async () => {
    // Providers other than Anthropic cache on a byte-identical prefix, so an
    // override that changes nothing must not be sent at all.
    const t = transcript(1);
    const prepared = loopWithPrepare([step("s1", "stop", { inputTokens: 390_000 })], [t]);
    await runTask({ ...baseInput, tools: { read_file: {} } as never }); // gpt-5.4-mini
    expect(prepared[0]).toBeUndefined();
  });

  it("keeps the prefix byte-identical across steps once armed (the cache-hit property)", async () => {
    // gpt-5.4-mini → 400k window ⇒ 392k usable ⇒ shouldCompact past 379k. No
    // cache tagging on this path, so what comes back is pure compaction.
    const stepN = transcript(3);
    const stepN1 = [
      ...stepN,
      { role: "assistant", content: "One more check." },
      ...smallTurn("run_command", { command: "git status" }, "clean"),
    ];
    const armed = { inputTokens: 390_000 };
    const prepared = loopWithPrepare(
      [step("s1", "tool-calls", armed), step("s2", "tool-calls", armed), step("s3", "stop", armed)],
      [stepN, stepN, stepN1],
    );
    await runTask({ ...baseInput, tools: { read_file: {} } as never });

    const atN = prepared[1]!.messages;
    const atN1 = prepared[2]!.messages;
    expect(stubCount(atN)).toBe(2);
    // The whole previously-sent prefix survives byte for byte; only the newly
    // appended messages are new. This is the assertion that fails the moment
    // eviction is rewritten as a sliding window.
    expect(JSON.stringify(atN1.slice(0, atN.length))).toBe(JSON.stringify(atN));
  });

  it("streamTask compacts the same way, with a fresh latch per attempt", async () => {
    const t = transcript(3);
    const prepared: Prepared[] = [];
    streamText.mockImplementation(
      (opts: {
        prepareStep?: (i: { messages: Msg[]; stepNumber: number }) => Prepared;
        onStepFinish?: (s: FakeStep) => void;
      }) => ({
        textStream: (async function* () {
          for (let i = 0; i < 2; i++) {
            prepared.push(opts.prepareStep?.({ messages: t, stepNumber: i }));
            opts.onStepFinish?.(step(`s${i}`, i === 1 ? "stop" : "tool-calls", TIGHT));
          }
          yield "ok";
        })(),
      }),
    );
    await streamTask({ ...haiku, onText: () => {} });
    expect(stubCount(prepared[0]?.messages ?? [])).toBe(0);
    expect(stubCount(prepared[1]!.messages)).toBe(2);
  });
});

// Summarization is the rung BELOW eviction and the only control in the phase
// that spends money, so what's under test is mostly restraint: it must not fire
// while the free mechanism still has something to give, and it must never fire
// twice.
describe("context summarization (the last resort)", () => {
  type Msg = Record<string, unknown>;
  type Prepared = { messages: Msg[] } | undefined;

  let seq = 0;

  /** A turn whose result is already an eviction stub — nothing left to evict —
   *  wrapped in enough narration for a summary to be worth a request. */
  function spentTurn(): Msg[] {
    const toolCallId = `s${++seq}`;
    return [
      {
        role: "assistant",
        content: `Reasoning about the auth module in detail. ${"Considered the caller graph. ".repeat(120)}`,
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId,
            toolName: "read_file",
            input: { path: `src/f${toolCallId}.ts` },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId,
            toolName: "read_file",
            output: {
              type: "text",
              value: "[evicted-tool-result #deadbeef] 120000 characters dropped",
            },
          },
        ],
      },
    ];
  }

  /** A turn whose result is fat enough that eviction still has work to do. */
  function liveTurn(): Msg[] {
    const toolCallId = `l${++seq}`;
    return [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId,
            toolName: "read_file",
            input: { path: `src/g${toolCallId}.ts` },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId,
            toolName: "read_file",
            output: { type: "text", value: "z".repeat(120_000) },
          },
        ],
      },
    ];
  }

  function spentTranscript(turns: number): Msg[] {
    const out: Msg[] = [
      { role: "system", content: "SYS" },
      { role: "user", content: "hello" },
    ];
    for (let i = 0; i < turns; i++) out.push(...spentTurn());
    return out;
  }

  /** Splits the one `generateText` mock between the agentic loop (which passes
   *  onStepFinish) and the summarizer (which doesn't). */
  function loopWithSummarizer(
    steps: FakeStep[],
    transcripts: Msg[][],
    summary: string | Error = "HANDOVER NOTE",
  ) {
    const prepared: Prepared[] = [];
    const summarizerCalls: Record<string, unknown>[] = [];
    generateText.mockImplementation(
      async (opts: {
        prepareStep?: (i: {
          messages: Msg[];
          stepNumber: number;
        }) => Prepared | Promise<Prepared>;
        onStepFinish?: (s: FakeStep) => void;
      }) => {
        if (!opts.onStepFinish) {
          summarizerCalls.push(opts as Record<string, unknown>);
          if (summary instanceof Error) throw summary;
          return { text: summary };
        }
        for (let i = 0; i < steps.length; i++) {
          prepared.push(
            await opts.prepareStep?.({ messages: transcripts[i], stepNumber: i }),
          );
          opts.onStepFinish?.(steps[i]);
        }
        return { text: "done" };
      },
    );
    return { prepared, summarizerCalls };
  }

  const haiku = {
    ...baseInput,
    modelId: "claude-haiku-4-5" as never,
    keys: { anthropic: "k", openai: "k" } as never,
    tools: { read_file: {} } as never,
  };
  const CALM = { inputTokens: 40_000 };
  const TIGHT = { inputTokens: 190_000 };
  const summaryCount = (messages: Msg[]) =>
    JSON.stringify(messages).split("[context-summary]").length - 1;

  it("does not fire while eviction still has something to take", async () => {
    // The free mechanism first, always. Two fat results blow the tool-result
    // budget, so eviction has work — no model call may be made here.
    const t: Msg[] = [
      { role: "system", content: "SYS" },
      { role: "user", content: "hello" },
      ...liveTurn(),
      ...liveTurn(),
      ...liveTurn(),
    ];
    const { prepared, summarizerCalls } = loopWithSummarizer(
      [step("s1", "tool-calls", TIGHT), step("s2", "stop", TIGHT)],
      [t, t],
    );
    await runTask(haiku);
    expect(summarizerCalls).toHaveLength(0);
    expect(summaryCount(prepared[1]!.messages)).toBe(0);
  });

  it("does not fire while the run is nowhere near the window", async () => {
    const t = spentTranscript(6);
    const { summarizerCalls } = loopWithSummarizer(
      [step("s1", "tool-calls", CALM), step("s2", "stop", CALM)],
      [t, t],
    );
    await runTask(haiku);
    expect(summarizerCalls).toHaveLength(0);
  });

  it("fires once when eviction is armed and freed nothing, then reuses the result", async () => {
    const t = spentTranscript(6);
    const { prepared, summarizerCalls } = loopWithSummarizer(
      [
        step("s1", "tool-calls", TIGHT),
        step("s2", "tool-calls", TIGHT),
        step("s3", "stop", TIGHT),
      ],
      [t, t, t],
    );
    await runTask(haiku);

    // Exactly one extra request, ever.
    expect(summarizerCalls).toHaveLength(1);
    expect(String(summarizerCalls[0].system)).toContain("compacting the middle");
    expect(summarizerCalls[0].maxOutputTokens).toBe(3_000);
    // …on a model chosen for price, not the run's model.
    expect(summarizerCalls[0].maxRetries).toBe(1);

    // Step 0 had no reading yet, so it isn't armed. Steps 1 and 2 carry the
    // summary, and byte-identically — that is what keeps the prompt cache.
    expect(summaryCount(prepared[0]?.messages ?? [])).toBe(0);
    expect(summaryCount(prepared[1]!.messages)).toBe(1);
    expect(JSON.stringify(prepared[2]!.messages)).toBe(
      JSON.stringify(prepared[1]!.messages),
    );
    expect(JSON.stringify(prepared[1]!.messages)).toContain("HANDOVER NOTE");
    // The spec is never summarized away.
    expect(prepared[1]!.messages[1]).toEqual({ role: "user", content: "hello" });
    expect(prepared[1]!.messages.length).toBeLessThan(t.length);
  });

  it("summarizeContext: false turns it off (the bisect switch)", async () => {
    const t = spentTranscript(6);
    const { prepared, summarizerCalls } = loopWithSummarizer(
      [step("s1", "tool-calls", TIGHT), step("s2", "stop", TIGHT)],
      [t, t],
    );
    await runTask({ ...haiku, summarizeContext: false });
    expect(summarizerCalls).toHaveLength(0);
    expect(summaryCount(prepared[1]!.messages)).toBe(0);
  });

  it("a summarizer that throws degrades to no summary, never to a failed run", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = spentTranscript(6);
    const { prepared, summarizerCalls } = loopWithSummarizer(
      [step("s1", "tool-calls", TIGHT), step("s2", "stop", TIGHT)],
      [t, t],
      new Error("529 overloaded"),
    );
    const r = await runTask(haiku);
    expect(r.ok).toBe(true);
    expect(summarizerCalls).toHaveLength(1);
    expect(summaryCount(prepared[1]!.messages)).toBe(0);
    warn.mockRestore();
  });

  it("does not re-summarize a transcript that already carries one", async () => {
    const t: Msg[] = [
      { role: "system", content: "SYS" },
      {
        role: "user",
        content: "[context-summary] earlier work, summarized. ".repeat(50),
      },
      ...spentTurn(),
      ...spentTurn(),
      ...spentTurn(),
    ];
    const { summarizerCalls } = loopWithSummarizer(
      [step("s1", "tool-calls", TIGHT), step("s2", "stop", TIGHT)],
      [t, t],
    );
    await runTask(haiku);
    expect(summarizerCalls).toHaveLength(0);
  });
});

describe("resume", () => {
  const resumeMessages = [
    { role: "assistant", content: "prior turn" },
    { role: "tool", content: "prior tool result" },
  ] as never;

  it("non-Anthropic: user turn is rebuilt, then the transcript is replayed", async () => {
    generateText.mockResolvedValue({ text: "ok" });
    await runTask({ ...baseInput, resumeMessages });
    const arg = generateText.mock.calls[0][0] as Record<string, unknown>;
    expect(promptShape(arg)).toEqual({
      system: "SYS",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "prior turn" },
        { role: "tool", content: "prior tool result" },
      ],
    });
  });

  it("Anthropic: the cached system message still leads, transcript trails", async () => {
    generateText.mockResolvedValue({ text: "ok" });
    await runTask({
      ...baseInput,
      modelId: "claude-opus-5" as never,
      resumeMessages,
    });
    const arg = generateText.mock.calls[0][0] as Record<string, unknown>;
    expect(promptShape(arg)).toEqual({
      messages: [
        {
          role: "system",
          content: "SYS",
          providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
        },
        { role: "user", content: "hello" },
        { role: "assistant", content: "prior turn" },
        { role: "tool", content: "prior tool result" },
      ],
    });
  });

  it("keeps vision parts in the rebuilt user turn (images never come from storage)", async () => {
    generateText.mockResolvedValue({ text: "ok" });
    await runTask({
      ...baseInput,
      attachments: [
        { kind: "image", content: "data:image/png;base64,AAA", mime: "image/png" },
      ] as never,
      resumeMessages,
    });
    const arg = generateText.mock.calls[0][0] as Record<string, unknown>;
    const messages = arg.messages as Array<{ role: string; content: unknown }>;
    expect(messages[0].role).toBe("user");
    expect(
      (messages[0].content as Array<{ type: string }>).some(
        (p) => p.type === "image",
      ),
    ).toBe(true);
    expect(messages.slice(1)).toEqual(resumeMessages);
  });

  it("every checkpoint of a resumed run begins with the resume prefix", async () => {
    generateTextOverSteps([step("s1"), step("s2", "stop")], "done");
    const seen: TaskCheckpoint[] = [];
    await runTask({
      ...baseInput,
      tools: { read_file: {} } as never,
      resumeMessages,
      onCheckpoint: (cp) => seen.push(cp),
    });
    for (const cp of seen) expect(cp.messages.slice(0, 2)).toEqual(resumeMessages);
    expect(seen[1].messages).toHaveLength(4);
    // stepsUsed counts THIS call only — the resumed steps aren't re-billed.
    expect(seen[1].stepsUsed).toBe(2);
  });

  it("streamTask resumes with the same request shape", async () => {
    streamText.mockReturnValue({
      textStream: (async function* () {
        yield "x";
      })(),
    });
    await streamTask({ ...baseInput, resumeMessages, onText: () => {} });
    const arg = streamText.mock.calls[0][0] as Record<string, unknown>;
    expect(promptShape(arg)).toEqual({
      system: "SYS",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "prior turn" },
        { role: "tool", content: "prior tool result" },
      ],
    });
  });

  // Regression pin: providers other than Anthropic cache on a byte-identical
  // request prefix, so a fresh run must not grow a `messages` key it never had.
  it("a fresh run's prompt shape is EXACTLY what it was before resume existed", async () => {
    generateText.mockResolvedValue({ text: "ok" });
    await runTask({ ...baseInput, resumeMessages: [] });
    expect(promptShape(generateText.mock.calls[0][0])).toEqual({
      system: "SYS",
      prompt: "hello",
    });

    generateText.mockClear();
    generateText.mockResolvedValue({ text: "ok" });
    await runTask({ ...baseInput }); // resumeMessages absent entirely
    expect(promptShape(generateText.mock.calls[0][0])).toEqual({
      system: "SYS",
      prompt: "hello",
    });

    generateText.mockClear();
    generateText.mockResolvedValue({ text: "ok" });
    await runTask({ ...baseInput, modelId: "claude-opus-5" as never });
    expect(promptShape(generateText.mock.calls[0][0])).toEqual({
      messages: [
        {
          role: "system",
          content: "SYS",
          providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
        },
        { role: "user", content: "hello" },
      ],
    });
  });
});

// The SDK's textStream spans EVERY agentic step, but the final answer is only
// the LAST step's text. Validating the whole concatenation let a fenced snippet
// from mid-investigation narration shadow the real answer — and because the
// batch schemas default their arrays to [], a stray `{"pattern":"x"}` in step-1
// narration "validated" as an EMPTY batch (ok:true, zero cases / zero findings).
// That was the generator's "model ran but produced no test cases" and Commit
// Review's false "clean commit". These pin final-step selection.
describe("final-answer selection (multi-step streams)", () => {
  const tools = { read_file: {} } as never;

  /** Interleaves yields with their step-finish events the way the real SDK
   *  does: each step's `text` is exactly the concatenation of its deltas. */
  function streamSteps(
    parts: Array<{ deltas: string[]; finishReason: string } | { deltas: string[] }>,
    opts?: { trailingError?: Error },
  ) {
    streamText.mockImplementation(
      (o: {
        onStepFinish?: (s: FakeStep) => void;
        onError?: (e: { error: unknown }) => void;
      }) => ({
        textStream: (async function* () {
          for (const p of parts) {
            for (const d of p.deltas) yield d;
            if ("finishReason" in p) {
              o.onStepFinish?.({
                response: { messages: [{ role: "assistant", content: "m" }] },
                finishReason: p.finishReason,
                text: p.deltas.join(""),
              });
            }
          }
          if (opts?.trailingError) o.onError?.({ error: opts.trailingError });
        })(),
      }),
    );
  }

  const narration =
    'Let me check the config first:\n```json\n{"pattern": "checkpoint"}\n```\nNow reading more files…';

  it("validates the FINAL step's text, not the all-steps concatenation", async () => {
    const schema = z.object({ a: z.number() });
    streamSteps([
      { deltas: [narration], finishReason: "tool-calls" },
      { deltas: ['{"a":', "9}"], finishReason: "stop" },
    ]);
    const r = await streamTask({ ...baseInput, schema, tools, onText: () => {} });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.object).toEqual({ a: 9 });
      // The result's text is the final answer, not the narration.
      expect(r.text).toBe('{"a":9}');
    }
  });

  it("a defaulted schema cannot 'validate empty' off narration JSON", async () => {
    // Mirrors DraftBatchLLMSchema / Stage1Schema: arrays default to [].
    const schema = z.object({ items: z.array(z.string()).default([]) });
    streamSteps([
      { deltas: [narration], finishReason: "tool-calls" },
      { deltas: ['{"items":["real"]}'], finishReason: "stop" },
    ]);
    const r = await streamTask({ ...baseInput, schema, tools, onText: () => {} });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.object).toEqual({ items: ["real"] });
  });

  // The back door into the shadowing bug this describe block exists to close.
  // `stepTexts` records "" for every pure tool-call step, so a `|| acc`
  // fallback for "the last step wrote nothing" fired exactly when the loop
  // ended ON a tool call — a budget stop — and handed the whole-run
  // concatenation to the validator. With defaulted schemas that "validates" as
  // an empty batch and the run reports ok:true with zero cases.
  it("does not fall back to the concatenation when the last step wrote nothing", async () => {
    const schema = z.object({ items: z.array(z.string()).default([]) });
    streamSteps([
      { deltas: [narration], finishReason: "tool-calls" },
      { deltas: [], finishReason: "tool-calls" },
    ]);
    const r = await streamTask({ ...baseInput, schema, tools, onText: () => {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("empty");
  });

  // …and the finish reason that says WHY rides out with it. Without this the
  // surface can only say "the model returned an empty response", which is one
  // of three quite different failures.
  it("reports the provider's finish reason on an empty answer", async () => {
    const schema = z.object({ a: z.number() });
    streamSteps([
      { deltas: ["reading"], finishReason: "tool-calls" },
      { deltas: [], finishReason: "length" },
    ]);
    const r = await streamTask({ ...baseInput, schema, tools, onText: () => {} });
    expect(r.ok).toBe(false);
    expect(r.finishReason).toBe("length");
  });

  it("trailing-error salvage validates the unfinished step's tail, not the narration", async () => {
    const schema = z.object({ a: z.number() });
    // Final answer streamed fully but its step never finished (stream died).
    streamSteps(
      [
        { deltas: [narration], finishReason: "tool-calls" },
        { deltas: ['{"a":7}'] },
      ],
      { trailingError: new Error("connection reset") },
    );
    const r = await streamTask({ ...baseInput, schema, tools, onText: () => {} });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.object).toEqual({ a: 7 });
  });

  it("no final text at all → reason 'empty', matching runTask", async () => {
    const schema = z.object({ a: z.number() });
    streamSteps([
      { deltas: [""], finishReason: "tool-calls" },
      { deltas: [""], finishReason: "stop" },
    ]);
    const r = await streamTask({ ...baseInput, schema, tools, onText: () => {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("empty");
  });

  it("prose (no-schema) streams still return the full accumulated text", async () => {
    streamSteps([
      { deltas: ["thinking… "], finishReason: "tool-calls" },
      { deltas: ["the answer"], finishReason: "stop" },
    ]);
    const r = await streamTask({ ...baseInput, tools, onText: () => {} });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe("thinking… the answer");
  });
});

// A loop that burns its whole budget still calling tools never reached the point
// of writing an answer. Reporting that as "schema_violation" is what made Commit
// Review tell users the model returned bad output when it had simply been cut off.
describe("step_cap", () => {
  const schema = z.object({ a: z.number() });
  const capped = {
    ...baseInput,
    schema,
    tools: { read_file: {} } as never,
    maxSteps: 3,
  };
  const atCap = [step("s1"), step("s2"), step("s3")];

  it("budget exhausted mid-tool-loop with unusable text → step_cap", async () => {
    generateTextOverSteps(atCap, "still thinking about it");
    const r = await runTask(capped);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("step_cap");
    expect(r.stepsUsed).toBe(3);
  });

  it("budget exhausted with NO final text → step_cap, not empty", async () => {
    generateTextOverSteps(atCap, "");
    const r = await runTask(capped);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("step_cap");
  });

  it("schema-valid text wins as ok:true even at the cap", async () => {
    generateTextOverSteps(atCap, JSON.stringify({ a: 5 }));
    const r = await runTask(capped);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.object).toEqual({ a: 5 });
    expect(r.stepsUsed).toBe(3);
  });

  it("under the cap is still a plain schema_violation", async () => {
    generateTextOverSteps([step("s1"), step("s2")], "garbage");
    const r = await runTask(capped);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("schema_violation");
  });

  it("at the cap but finished on its own terms is a schema_violation", async () => {
    generateTextOverSteps([step("s1"), step("s2"), step("s3", "stop")], "garbage");
    const r = await runTask(capped);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("schema_violation");
  });

  it("streamTask reports step_cap the same way", async () => {
    streamTextOverSteps(atCap, ["not", " json"]);
    const r = await streamTask({ ...capped, onText: () => {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("step_cap");
    expect(r.stepsUsed).toBe(3);
  });
});

// A step is a poor proxy for the constraint: one step can be a 200-token call or
// a 60k-token file read. The token budget is the ration; the step ceiling is the
// runaway guard behind it. These pin the classification, which is where getting
// it wrong is expensive — a spend stop lands with steps to spare, so the old
// `stepsUsed === maxSteps` test would have called it a schema_violation and told
// the user the model returned bad output when it had simply been cut off.
describe("token budget", () => {
  const schema = z.object({ a: z.number() });
  const spend = (n: number) => ({ inputTokens: n, outputTokens: 0 });
  const budgeted = {
    ...baseInput,
    schema,
    tools: { read_file: {} } as never,
    // Deliberately far apart, so nothing here can pass because both guards
    // happened to bind at once.
    maxSteps: 20,
    tokenBudget: 1_000,
  };

  it("a spend stop with steps to spare is step_cap, not schema_violation", async () => {
    generateTextOverSteps(
      [
        step("s1", "tool-calls", spend(600)),
        step("s2", "tool-calls", spend(600)),
      ],
      "still thinking about it",
    );
    const r = await runTask(budgeted);
    expect(r.stepsUsed).toBe(2); // nowhere near maxSteps
    expect(r.tokensUsed).toBe(1_200);
    expect(r.limit).toBe("tokens");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("step_cap");
  });

  it("under both guards is still a plain schema_violation", async () => {
    generateTextOverSteps([step("s1", "tool-calls", spend(100))], "garbage");
    const r = await runTask(budgeted);
    expect(r.limit).toBeUndefined();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("schema_violation");
  });

  it("schema-valid text still wins as ok:true at the budget", async () => {
    generateTextOverSteps(
      [step("s1", "tool-calls", spend(5_000))],
      JSON.stringify({ a: 7 }),
    );
    const r = await runTask(budgeted);
    expect(r.limit).toBe("tokens");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.object).toEqual({ a: 7 });
  });

  it("a spend stop that finished on its own terms is NOT a budget failure", async () => {
    // The model answered and stopped; it merely happened to cross the line on
    // the way. Only a loop cut off mid-tool-call is worth resuming.
    generateTextOverSteps([step("s1", "stop", spend(5_000))], "garbage");
    const r = await runTask(budgeted);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("schema_violation");
  });

  it("installs BOTH stop conditions, so neither guard can be dropped by accident", async () => {
    generateTextOverSteps([step("s1", "stop", spend(10))], JSON.stringify({ a: 1 }));
    await runTask(budgeted);
    const args = generateText.mock.calls[0][0] as { stopWhen?: unknown[] };
    expect(args.stopWhen).toHaveLength(2);
    // The SDK ORs the array, so the loop ends at whichever binds first.
    expect(args.stopWhen?.[1]).toEqual({ __stepCountIs: 20 });
  });

  it("streamTask classifies a spend stop identically", async () => {
    streamTextOverSteps(
      [
        step("s1", "tool-calls", spend(600)),
        step("s2", "tool-calls", spend(600)),
      ],
      ["not", " json"],
    );
    const r = await streamTask({ ...budgeted, onText: () => {} });
    expect(r.limit).toBe("tokens");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("step_cap");
  });

  it("an endpoint that reports no usage falls through to the step ceiling", async () => {
    // Local servers routinely report nothing. The token budget is structurally
    // blind there, which is the whole reason the step count was kept.
    generateTextOverSteps([step("s1"), step("s2"), step("s3")], "");
    const r = await runTask({ ...budgeted, maxSteps: 3 });
    expect(r.tokensUsed).toBe(0);
    expect(r.limit).toBe("steps");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("step_cap");
  });
});

// Frontier tiers REMOVED sampling params: Anthropic's Claude 5 answers
// "`temperature` is deprecated for this model" with a 400. Every surface asks
// for temperature 0, and Claude Sonnet 5 is the default model — so sending it
// broke the first run of every BYOK Anthropic user. These pin both halves of the
// fix: the per-model table in front of every provider, and the one-shot retry
// that covers models no table knows about.
describe("sampling params (models that reject temperature)", () => {
  /** The real Anthropic 400 that took down every surface. */
  const REJECTION = "`temperature` is deprecated for this model.";

  const hasTemperature = (call: number) =>
    "temperature" in (generateText.mock.calls[call][0] as Record<string, unknown>);
  const streamHasTemperature = (call: number) =>
    "temperature" in (streamText.mock.calls[call][0] as Record<string, unknown>);

  it("claude-sonnet-5 (the default model): temperature 0 is never sent", async () => {
    generateText.mockResolvedValue({ text: "ok" });
    await runTask({
      ...baseInput,
      modelId: "claude-sonnet-5" as never,
      temperature: 0,
    });
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(hasTemperature(0)).toBe(false);
  });

  it("claude-opus-5: temperature 0 is never sent", async () => {
    generateText.mockResolvedValue({ text: "ok" });
    await runTask({
      ...baseInput,
      modelId: "claude-opus-5" as never,
      temperature: 0,
    });
    expect(hasTemperature(0)).toBe(false);
  });

  it("the OpenRouter Claude 5 route drops it too — the gateway forwards our body verbatim", async () => {
    generateText.mockResolvedValue({ text: "ok" });
    await runTask({
      ...baseInput,
      modelId: "anthropic/claude-sonnet-5" as never,
      temperature: 0,
    });
    expect(hasTemperature(0)).toBe(false);
  });

  it("does NOT blanket-drop it for Anthropic — Haiku 4.5 still gets temperature 0", async () => {
    generateText.mockResolvedValue({ text: "ok" });
    await runTask({
      ...baseInput,
      modelId: "claude-haiku-4-5" as never,
      temperature: 0,
    });
    const arg = generateText.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.temperature).toBe(0);
  });

  it("runTask retries once without temperature when a provider rejects it", async () => {
    // A model the table can't know: a custom endpoint or a post-build release.
    generateText
      .mockRejectedValueOnce(new Error(REJECTION))
      .mockResolvedValueOnce({ text: "recovered" });
    const r = await runTask({ ...baseInput, temperature: 0 });
    expect(generateText).toHaveBeenCalledTimes(2);
    expect(hasTemperature(0)).toBe(true);
    expect(hasTemperature(1)).toBe(false);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe("recovered");
  });

  it("streamTask retries too, and replays no text to the user", async () => {
    const emitted: string[] = [];
    streamText
      .mockImplementationOnce((opts: { onError?: (e: { error: unknown }) => void }) => ({
        // The 400 lands before any delta — nothing was shown, so re-streaming
        // cannot duplicate output.
        textStream: (async function* () {
          opts.onError?.({ error: new Error(REJECTION) });
        })(),
      }))
      .mockImplementationOnce(() => ({
        textStream: (async function* () {
          yield "recovered";
        })(),
      }));
    const r = await streamTask({
      ...baseInput,
      temperature: 0,
      onText: (d) => emitted.push(d),
    });
    expect(streamText).toHaveBeenCalledTimes(2);
    expect(streamHasTemperature(0)).toBe(true);
    expect(streamHasTemperature(1)).toBe(false);
    expect(r.ok).toBe(true);
    expect(emitted).toEqual(["recovered"]);
  });

  it("retries the structured tool-less path without spending a repair attempt", async () => {
    const schema = z.object({ a: z.number() });
    generateObject
      .mockRejectedValueOnce(new Error(REJECTION))
      .mockResolvedValueOnce({ object: { a: 1 } });
    const r = await runTask({
      ...baseInput,
      schema,
      temperature: 0,
      repairAttempts: 0,
    });
    expect(generateObject).toHaveBeenCalledTimes(2);
    expect(r.ok).toBe(true);
  });

  it("a mid-stream failure that merely mentions temperature is not retried", async () => {
    // Rejection verb but no param name, or vice versa — neither is a sampling
    // rejection, and a pointless retry burns a second billed request.
    generateText.mockRejectedValue(
      new Error("rate_limit_error: your temperature-controlled workload is throttled"),
    );
    await expect(runTask({ ...baseInput, temperature: 0 })).rejects.toThrow(
      /rate_limit_error/,
    );
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it("does not retry when the caller never sent a temperature", async () => {
    generateText.mockRejectedValue(new Error(REJECTION));
    await expect(runTask({ ...baseInput })).rejects.toThrow(/deprecated/);
    expect(generateText).toHaveBeenCalledTimes(1);
  });
});

// A structured tool-less run repairs its way through bad JSON, but a bad key /
// no credits / a 400 is not bad JSON — repairing it can't help, and swallowing it
// reported "the model returned nothing" instead of the provider's real message.
// That was the hardest BYOK failure to diagnose: the user sees an empty result
// and no reason. The tool-bearing path has always thrown these; so does this one.
describe("provider failures on the structured tool-less path", () => {
  const schema = z.object({ a: z.number() });

  it("rethrows an API call error instead of reporting 'empty'", async () => {
    generateObject.mockRejectedValue(
      Object.assign(new Error("Your credit balance is too low"), {
        name: "AI_APICallError",
        statusCode: 400,
      }),
    );
    await expect(runTask({ ...baseInput, schema })).rejects.toThrow(
      /credit balance/,
    );
    // No repair attempts spent on an error repair cannot fix.
    expect(generateObject).toHaveBeenCalledTimes(1);
  });

  it("rethrows a missing-key error", async () => {
    generateObject.mockRejectedValue(
      Object.assign(new Error("No API key configured"), {
        name: "AI_LoadAPIKeyError",
      }),
    );
    await expect(runTask({ ...baseInput, schema })).rejects.toThrow(/API key/);
  });

  it("rethrows a bare HTTP failure with no SDK wrapper", async () => {
    generateObject.mockRejectedValue(
      Object.assign(new Error("Unauthorized"), { statusCode: 401 }),
    );
    await expect(runTask({ ...baseInput, schema })).rejects.toThrow(
      /Unauthorized/,
    );
  });

  it("still repairs a genuine schema miss rather than throwing", async () => {
    generateObject.mockRejectedValue(
      Object.assign(new Error("no object generated"), {
        name: "AI_NoObjectGeneratedError",
        text: "garbage",
      }),
    );
    const r = await runTask({ ...baseInput, schema, repairAttempts: 1 });
    expect(generateObject).toHaveBeenCalledTimes(2);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("schema_violation");
  });
});

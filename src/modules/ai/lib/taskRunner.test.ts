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

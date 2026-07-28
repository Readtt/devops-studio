// The single shared task runner for every read-only BYOK surface — Generator,
// Suite Chat, Code Review, and Confidence all funnel through here. Vercel AI
// SDK only; there is no second engine.
//
// Modes (auto-selected from `schema` + `tools`):
//   • schema, no tools → generateObject (SDK-native structured output + repair)
//   • schema + tools   → generateText/streamText runs the agentic read loop,
//                        then the model's final text is validated against the
//                        schema here. (We deliberately do NOT use the SDK's
//                        experimental_output: it throws "No output generated"
//                        when the model returns the object as plain text after
//                        a tool loop — unreliable for the tools+output combo.)
//   • no schema        → generateText/streamText (prose; Code Review, Suite Chat)
//
// @readonly — the `tools` a caller passes are read-only: source tools
// (read_file / list_files / grep / glob) plus an allowlisted read-only command
// runner (run_command — git/file inspection that never mutates). The runner
// itself NEVER builds or injects tools, and nothing that writes / edits /
// deletes / delegates ever goes in. Keep it that way.

import {
  generateObject,
  generateText,
  stepCountIs,
  streamText,
  type ModelMessage,
  type ToolSet,
} from "ai";
import type { z } from "zod";
import {
  getModel,
  isReasoningModel,
  MAX_AGENT_STEPS,
  supportsVision,
  type ModelId,
} from "../config";
import {
  buildConfiguredLanguageModel,
  buildStableSystem,
  type LocalProviderConfig,
} from "./agent";
import type { ProviderKeys } from "./keyring";
import { extractJsonBlock } from "./extractJson";
import { buildUserTurn } from "./visionMessage";
import {
  clampOutputFull,
  clampOutputSummary,
  formatToolResult,
  newActivityId,
  stepToActivity,
  summarizeToolInput,
  type ActivityEntry,
} from "@/modules/generator/lib/activityLog";

/** Minimal attachment shape the vision helper understands. */
type ImageLike = { kind?: string; content: string; mime?: string };

export type TaskInput<S extends z.ZodTypeAny | undefined = undefined> = {
  modelId: ModelId;
  keys: ProviderKeys;
  /** Local-provider base URLs / model ids (LM Studio, MLX, Ollama, …). */
  local?: LocalProviderConfig;
  /** The surface's base system prompt (from systemPrompts.ts). */
  systemPrompt: string;
  /** The user turn. Text attachments are assumed already folded in by the
   *  caller; only images are lifted into vision parts. */
  prompt: string;
  attachments?: ImageLike[];
  /** Read-only tool set (build*Tools). null/undefined ⇒ tool-less. */
  tools?: ToolSet | null;
  /** Explicit per call. Omit ⇒ provider default (no hidden global). */
  temperature?: number;
  seed?: number;
  /** Step cap for the agentic loop (only meaningful with tools). */
  maxSteps?: number;
  /** Present ⇒ structured mode (the result carries a validated `object`). */
  schema?: S;
  /** Optional blocks layered below the base prompt. Surfaces that don't pass
   *  these get the base prompt verbatim. */
  customInstructions?: string;
  projectMemory?: string | null;
  /** Schema repair attempts before the circuit breaker trips. Default 2. */
  repairAttempts?: number;
  /** Tool-activity callback (Read/Glob/Grep), upsert by id. */
  onToolEvent?: (e: ActivityEntry) => void;
  signal?: AbortSignal;
};

type InferObject<S extends z.ZodTypeAny | undefined> = S extends z.ZodTypeAny
  ? z.infer<S>
  : undefined;

export type TaskResult<S extends z.ZodTypeAny | undefined = undefined> =
  | {
      ok: true;
      text: string;
      object: InferObject<S>;
      durationMs: number;
    }
  | {
      ok: false;
      /** schema_violation ⇒ repair budget exhausted; empty ⇒ no usable text. */
      reason: "schema_violation" | "empty";
      text: string;
      durationMs: number;
    };

const DEFAULT_REPAIR_ATTEMPTS = 2;

/** Retries for transient provider failures (429/529/5xx). The SDK honors a
 *  Retry-After header when it's under 60s and falls back to exponential
 *  backoff (2s base, ×2) otherwise — but its DEFAULT of 2 retries gives up ~6s
 *  in, which is useless against per-MINUTE token buckets. BYOK keys on low
 *  provider tiers breach those constantly mid-agentic-loop, and before this
 *  the run just died. Six retries waits out a full rate-limit window (worst
 *  case ≈2 min, usually one Retry-After hop); an abort still cancels retry
 *  waits instantly. */
const TASK_MAX_RETRIES = 6;

/** Per-step prompt-cache breakpoint for Anthropic agentic loops.
 *
 *  buildRequestPrompt's system-message breakpoint caches the STATIC prefix
 *  (tool definitions + system prompt), but an agentic loop re-sends the entire
 *  GROWING conversation every step — the fat diff/spec turn plus every
 *  accumulated tool result — and without a breakpoint covering it, each step
 *  re-bills all of it as fresh input tokens. On a 20-step run that's the bulk
 *  of the spend and exactly what breaches per-minute input-token limits on
 *  low-tier BYOK keys.
 *
 *  Tagging the LAST message of each step's request makes the next step read
 *  the whole prior transcript as a cache hit (~10% of input price, and mostly
 *  exempt from Anthropic's ITPM accounting), paying fresh only for what the
 *  step added. The SDK rebuilds each step's message array from its own
 *  pristine copies, so tags never accumulate — each request carries exactly
 *  two breakpoints (system + last message), well under Anthropic's cap of 4;
 *  the untag sweep is belt-and-braces should that internal ever change.
 *  Non-Anthropic providers return undefined: their automatic prefix caching
 *  needs no explicit breakpoints, and their requests must stay byte-identical. */
function anthropicStepCachePrepare(
  modelId: ModelId,
): (({ messages }: { messages: ModelMessage[] }) => { messages: ModelMessage[] } | undefined) | undefined {
  if (!isAnthropicCacheable(modelId)) return undefined;
  return ({ messages }) => {
    // Nothing to gain on a system-only / empty request (never happens in
    // practice — every surface sends a user turn).
    if (messages.length < 2) return undefined;
    const next = messages.map((m, i) =>
      i > 0 ? untagAnthropicCache(m) : m,
    );
    next[next.length - 1] = tagAnthropicCache(next[next.length - 1]);
    return { messages: next };
  };
}

function tagAnthropicCache(m: ModelMessage): ModelMessage {
  return {
    ...m,
    providerOptions: {
      ...m.providerOptions,
      anthropic: {
        ...(m.providerOptions?.anthropic ?? {}),
        cacheControl: { type: "ephemeral" },
      },
    },
  } as ModelMessage;
}

function untagAnthropicCache(m: ModelMessage): ModelMessage {
  const anthropic = m.providerOptions?.anthropic;
  if (!anthropic || !("cacheControl" in anthropic)) return m;
  const { cacheControl: _drop, ...rest } = anthropic;
  return {
    ...m,
    providerOptions: { ...m.providerOptions, anthropic: rest },
  } as ModelMessage;
}

/** Assemble the system prompt: base + optional project memory + custom
 *  instructions. Surfaces that pass neither get the base verbatim. */
function assembleSystem(input: TaskInput<z.ZodTypeAny | undefined>): string {
  return buildStableSystem(
    input.systemPrompt,
    input.customInstructions,
    input.projectMemory ?? null,
  );
}

/** Anthropic is the only provider that needs an EXPLICIT prompt-cache breakpoint
 *  — OpenAI and Google cache the static request prefix automatically. Unknown /
 *  local model ids conservatively return false (no caching, never an error),
 *  mirroring supportsVision. */
function isAnthropicCacheable(modelId: ModelId): boolean {
  try {
    return getModel(modelId).provider === "anthropic";
  } catch {
    return false;
  }
}

/** Shape the prompt fields spread into generateText/streamText so Anthropic runs
 *  carry a prompt-cache breakpoint. Anthropic's `system` STRING param is not
 *  cacheable, so we move it into a leading system MESSAGE tagged with
 *  cacheControl (the SDK lands the breakpoint on that message's only content
 *  block) and drop the top-level `system`. Because Anthropic orders the request
 *  tools → system → messages, that one breakpoint also caches the large, static
 *  tool definitions in front of it — the win that repeats across every agentic
 *  step (maxSteps ≥ 2) and every reused run (multi-run confidence, bulk suite
 *  scoring, multi-turn chat). For every other provider we return
 *  `{ system, ...userTurn }` — byte-for-byte identical to before, so their
 *  automatic caching is untouched. Vision parts in `userTurn.messages` survive.
 *  The prompt CONTENT is unchanged either way: caching only alters billing and
 *  latency, never the model's output. (The tool-less generateObject path is left
 *  on the plain form — generateObject + Anthropic cache_control is unreliable in
 *  the SDK, and skipping it is a zero-regression choice.) */
function buildRequestPrompt(
  modelId: ModelId,
  system: string,
  userTurn: { prompt: string } | { messages: ModelMessage[] },
):
  | { system: string; prompt: string }
  | { system: string; messages: ModelMessage[] }
  | { messages: ModelMessage[] } {
  if (!isAnthropicCacheable(modelId)) return { system, ...userTurn };
  const systemMessage: ModelMessage = {
    role: "system",
    content: system,
    providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
  };
  const userMessages: ModelMessage[] =
    "messages" in userTurn
      ? userTurn.messages
      : [{ role: "user", content: userTurn.prompt }];
  return { messages: [systemMessage, ...userMessages] };
}

function onStepFinishFor(
  start: number,
  onToolEvent: ((e: ActivityEntry) => void) | undefined,
) {
  if (!onToolEvent) return undefined;
  return (step: Parameters<typeof stepToActivity>[0]) => {
    for (const e of stepToActivity(step, start)) onToolEvent(e);
  };
}

/** Live tool activity for the STREAMING surfaces. `onStepFinish` only fires
 *  once a whole step (model turn + all its tool round-trips) completes, so the
 *  chat went silent — showing just a "thinking" placeholder — while the model
 *  read files. This emits a pending "tool" entry the moment a tool is called
 *  (spinner in the strip) and upserts it to "done" with output + duration when
 *  the result arrives. Entries are keyed by toolCallId so they merge with the
 *  step-finish events (which now share that id) instead of duplicating. */
function liveToolOnChunk(
  start: number,
  toolStart: Map<string, number>,
  onToolEvent: ((e: ActivityEntry) => void) | undefined,
) {
  if (!onToolEvent) return undefined;
  return ({ chunk }: { chunk: unknown }) => {
    const c = chunk as {
      type?: string;
      toolCallId?: string;
      toolName?: string;
      input?: unknown;
      args?: unknown;
      output?: unknown;
      result?: unknown;
    };
    if (c.type === "tool-call") {
      const id = c.toolCallId ?? newActivityId();
      toolStart.set(id, Date.now());
      const toolName = c.toolName ?? "tool";
      onToolEvent({
        id,
        ts: Date.now() - start,
        kind: "tool",
        toolName,
        inputSummary: summarizeToolInput(
          toolName,
          (c.input ?? c.args ?? {}) as Record<string, unknown>,
        ),
      });
    } else if (c.type === "tool-result") {
      const id = c.toolCallId ?? newActivityId();
      const startedAt = toolStart.get(id);
      const toolName = c.toolName ?? "tool";
      const fmt = formatToolResult(toolName, c.output ?? c.result);
      onToolEvent({
        id,
        ts: Date.now() - start,
        kind: "tool",
        toolName,
        durationMs: startedAt != null ? Date.now() - startedAt : 0,
        outputSummary: fmt.summary ? clampOutputSummary(fmt.summary) : undefined,
        outputFull: fmt.text ? clampOutputFull(fmt.text) : undefined,
        outputLang: fmt.lang,
      });
    }
  };
}

/** Drop image attachments when the active model has no vision support, so a
 *  pasted/dropped image degrades to its text reference (formatAttachmentBlock
 *  already emits one) instead of a hard provider 400. Mirrors how
 *  best-practice images are gated upstream. */
function visionSafe(input: {
  modelId: ModelId;
  attachments?: ImageLike[];
}): ImageLike[] | undefined {
  if (supportsVision(input.modelId)) return input.attachments;
  return (input.attachments ?? []).filter((a) => a.kind !== "image");
}

/** Omit `temperature` for reasoning models — DeepSeek's reasoner, xAI Grok
 *  reasoning, etc. reject or mishandle sampling params, and the
 *  openai-compatible / xai providers (unlike native OpenAI) pass them through
 *  unconditionally. Returns the caller's temperature for every other model. */
function effectiveTemperature(input: {
  modelId: ModelId;
  temperature?: number;
}): number | undefined {
  return isReasoningModel(input.modelId) ? undefined : input.temperature;
}

/** Non-streaming run. Returns prose text and, in structured mode, a validated
 *  `object`. On repeated schema failure returns `{ ok: false }` so surfaces can
 *  map it to their existing empty / UNEVALUABLE / warning states. */
export async function runTask<
  S extends z.ZodTypeAny | undefined = undefined,
>(input: TaskInput<S>): Promise<TaskResult<S>> {
  const start = Date.now();
  const model = await buildConfiguredLanguageModel(
    input.modelId,
    input.keys,
    input.local ?? {},
  );
  const system = assembleSystem(input);
  const userTurn = buildUserTurn(input.prompt, visionSafe(input));
  const tools = input.tools ?? undefined;
  const maxSteps = input.maxSteps ?? MAX_AGENT_STEPS;
  const repairAttempts = input.repairAttempts ?? DEFAULT_REPAIR_ATTEMPTS;
  const temperature = effectiveTemperature(input);

  // --- Structured, tool-less: generateObject -------------------------------
  if (input.schema && !tools) {
    let attempt = 0;
    let lastText = "";
    // generateObject already self-repairs once via experimental_repairText;
    // the outer loop is the circuit breaker for hard validation failures.
    while (attempt <= repairAttempts) {
      try {
        const r = await generateObject({
          model,
          system,
          ...userTurn,
          maxRetries: TASK_MAX_RETRIES,
          schema: input.schema,
          // OpenAI-compatible / local models often wrap the object in ```json
          // fences or add prose; strip to the JSON block and let the SDK
          // re-parse before giving up (the tool-bearing path already does this
          // via validateAgainstSchema). Without it, fenced output → a parse
          // failure → an "empty result" the user can't explain.
          experimental_repairText: async ({ text }) => {
            try {
              const sliced = extractJsonBlock(text.trim());
              return sliced && sliced !== text ? sliced : null;
            } catch {
              return null;
            }
          },
          ...(temperature !== undefined ? { temperature } : {}),
          ...(input.seed !== undefined ? { seed: input.seed } : {}),
          abortSignal: input.signal,
        });
        return {
          ok: true,
          text: JSON.stringify(r.object),
          object: r.object as InferObject<S>,
          durationMs: Date.now() - start,
        };
      } catch (e) {
        if (input.signal?.aborted) throw e;
        lastText = extractTextFromError(e) || lastText;
        attempt++;
      }
    }
    return {
      ok: false,
      // No recoverable text at all ⇒ the endpoint returned nothing (common with
      // OpenAI-compatible connectors that don't honor JSON/response-format);
      // some text but unparseable ⇒ a true schema violation.
      reason: lastText.trim() ? "schema_violation" : "empty",
      text: lastText,
      durationMs: Date.now() - start,
    };
  }

  // --- Structured + tools, or prose: generateText --------------------------
  const prepareStep = tools ? anthropicStepCachePrepare(input.modelId) : undefined;
  const r = await generateText({
    model,
    ...buildRequestPrompt(input.modelId, system, userTurn),
    ...(tools ? { tools, stopWhen: stepCountIs(maxSteps) } : {}),
    ...(prepareStep ? { prepareStep } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(input.seed !== undefined ? { seed: input.seed } : {}),
    maxRetries: TASK_MAX_RETRIES,
    abortSignal: input.signal,
    onStepFinish: onStepFinishFor(start, input.onToolEvent),
  });

  const text = r.text ?? "";
  if (input.schema) {
    // The model ran its tool loop and emitted the object as its final text;
    // validate that against the schema (the prompts instruct "return ONLY the
    // JSON"). On failure the surface's own salvage/parse fallback can still
    // recover partial output from `text`.
    if (!text.trim()) {
      // The provider streamed/returned no final text — distinct from a schema
      // violation so the surface can show "model returned nothing" guidance.
      return {
        ok: false,
        reason: "empty",
        text: "",
        durationMs: Date.now() - start,
      };
    }
    const parsed = validateAgainstSchema(text, input.schema);
    if (!parsed.ok) {
      return {
        ok: false,
        reason: "schema_violation",
        text,
        durationMs: Date.now() - start,
      };
    }
    return {
      ok: true,
      text,
      object: parsed.value as InferObject<S>,
      durationMs: Date.now() - start,
    };
  }
  return {
    ok: true,
    text,
    object: undefined as InferObject<S>,
    durationMs: Date.now() - start,
  };
}

export type StreamTaskInput<S extends z.ZodTypeAny | undefined = undefined> =
  TaskInput<S> & { onText: (delta: string) => void };

/** Streaming run for the prose surfaces (Code Review, Suite Chat). Calls
 *  `onText` with each delta and resolves with the same result shape as
 *  `runTask` once the stream completes. */
export async function streamTask<
  S extends z.ZodTypeAny | undefined = undefined,
>(input: StreamTaskInput<S>): Promise<TaskResult<S>> {
  const start = Date.now();
  const model = await buildConfiguredLanguageModel(
    input.modelId,
    input.keys,
    input.local ?? {},
  );
  const system = assembleSystem(input);
  const userTurn = buildUserTurn(input.prompt, visionSafe(input));
  const tools = input.tools ?? undefined;
  const maxSteps = input.maxSteps ?? MAX_AGENT_STEPS;
  const temperature = effectiveTemperature(input);

  const toolStart = new Map<string, number>();
  // streamText NEVER rejects: a provider/network failure mid-stream (429 on a
  // follow-up agentic step, overload, dropped connection) is reported via
  // `onError` and textStream simply ENDS. Without capturing it, a failed run
  // looks like the model stopping after a sentence — which the schema surfaces
  // then misreport as "the model didn't return findings in the expected
  // format". Capture the first error and rethrow it below so callers' existing
  // catch paths show the REAL provider message.
  let streamError: unknown = null;
  const prepareStep = tools ? anthropicStepCachePrepare(input.modelId) : undefined;
  const result = streamText({
    model,
    ...buildRequestPrompt(input.modelId, system, userTurn),
    ...(tools ? { tools, stopWhen: stepCountIs(maxSteps) } : {}),
    ...(prepareStep ? { prepareStep } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(input.seed !== undefined ? { seed: input.seed } : {}),
    maxRetries: TASK_MAX_RETRIES,
    abortSignal: input.signal,
    // Live per-tool events (spinner → done) plus the step-finish sweep as a
    // backstop; both key entries by toolCallId so they merge, not duplicate.
    onChunk: liveToolOnChunk(start, toolStart, input.onToolEvent),
    onStepFinish: onStepFinishFor(start, input.onToolEvent),
    onError: ({ error }) => {
      if (streamError == null) streamError = error;
    },
  });

  let acc = "";
  for await (const chunk of result.textStream) {
    acc += chunk;
    input.onText(chunk);
  }

  // A user abort also lands here as a quietly-ended stream. Rethrow it as an
  // AbortError so surfaces map it to their "cancelled" state instead of an
  // error banner (checked before streamError — the SDK may report the abort
  // through onError too, and "cancelled" must win over "failed").
  if (input.signal?.aborted) {
    throw new DOMException("Request aborted", "AbortError");
  }
  if (streamError != null) {
    // The one recoverable case: the full structured object arrived before the
    // stream blipped. Don't throw away a complete result over a trailing error.
    if (input.schema) {
      const parsed = validateAgainstSchema(acc, input.schema);
      if (parsed.ok) {
        return {
          ok: true,
          text: acc,
          object: parsed.value as InferObject<S>,
          durationMs: Date.now() - start,
        };
      }
    }
    throw streamError instanceof Error
      ? streamError
      : new Error(String(streamError));
  }

  if (input.schema) {
    const parsed = validateAgainstSchema(acc, input.schema);
    if (!parsed.ok) {
      return {
        ok: false,
        reason: "schema_violation",
        text: acc,
        durationMs: Date.now() - start,
      };
    }
    return {
      ok: true,
      text: acc,
      object: parsed.value as InferObject<S>,
      durationMs: Date.now() - start,
    };
  }
  return {
    ok: true,
    text: acc,
    object: undefined as InferObject<S>,
    durationMs: Date.now() - start,
  };
}

/** Best-effort: pull the model's raw text out of a NoObjectGeneratedError so a
 *  schema-violation result still surfaces what the model said. */
function extractTextFromError(e: unknown): string {
  if (e && typeof e === "object") {
    const t = (e as { text?: unknown }).text;
    if (typeof t === "string") return t;
  }
  return "";
}

/** Validate a model's final text against a schema — slice the JSON out of any
 *  fenced/prose wrapping, parse, then safeParse. Used by the tool-bearing paths
 *  where the SDK's experimental_output isn't reliable. */
function validateAgainstSchema(
  text: string,
  schema: z.ZodTypeAny,
): { ok: true; value: unknown } | { ok: false } {
  let json: unknown;
  try {
    json = JSON.parse(extractJsonBlock(text.trim()));
  } catch {
    return { ok: false };
  }
  const r = schema.safeParse(json);
  return r.success ? { ok: true, value: r.data } : { ok: false };
}

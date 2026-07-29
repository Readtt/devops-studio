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
  type FinishReason,
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

export type TaskUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
};

/** Everything needed to continue an agentic run that died mid-loop. */
export type TaskCheckpoint = {
  /** Full continuation transcript: resumeMessages (if any) + every completed
   *  step's response messages from this call, in order. */
  messages: ModelMessage[];
  /** Steps completed in THIS call (excludes resumed prior steps). */
  stepsUsed: number;
  /** Usage summed across THIS call's completed steps. Summing inputTokens
   *  across steps intentionally counts the re-sent transcript each step —
   *  that is what was actually billed. */
  usage: TaskUsage;
  /** finishReason of the most recent completed step. */
  finishReason?: FinishReason;
};

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
  /** Fired after each completed agentic step with the accumulated transcript.
   *  Only fires on the tool-bearing generateText/streamText paths; the
   *  tool-less generateObject path ignores it (single-shot, no steps). */
  onCheckpoint?: (cp: TaskCheckpoint) => void;
  /** Continuation transcript from a previous call. When set, the request is
   *  [rebuilt system + user turn, ...resumeMessages]. The user turn is rebuilt
   *  fresh from prompt/attachments (images stay Uint8Array — they never come
   *  from persisted state; callers rebuild them from stored attachments). */
  resumeMessages?: ModelMessage[];
  signal?: AbortSignal;
};

type InferObject<S extends z.ZodTypeAny | undefined> = S extends z.ZodTypeAny
  ? z.infer<S>
  : undefined;

/** Per-run scalars both result arms carry, so a failed run still tells the
 *  surface how far it got and what it cost. */
type TaskScalars = {
  /** Agentic steps completed in this call. 0 on the tool-less generateObject
   *  path (single-shot) and on any path where the provider reported no steps. */
  stepsUsed: number;
  finishReason?: FinishReason;
  usage?: TaskUsage;
};

export type TaskResult<S extends z.ZodTypeAny | undefined = undefined> =
  | ({
      ok: true;
      text: string;
      object: InferObject<S>;
      durationMs: number;
    } & TaskScalars)
  | ({
      ok: false;
      /** schema_violation ⇒ repair budget exhausted; empty ⇒ no usable text;
       *  step_cap ⇒ the loop burned its whole step budget still calling tools,
       *  so the model never got to write its answer (retryable with a bigger
       *  budget or a resume — not a model that returned garbage). */
      reason: "schema_violation" | "empty" | "step_cap";
      text: string;
      durationMs: number;
    } & TaskScalars);

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

/** Rebuild the request for a RESUMED run: a freshly assembled system + user turn
 *  followed by the transcript an earlier attempt accumulated. The user turn is
 *  rebuilt rather than replayed from the transcript because image parts never
 *  survive persistence — callers hand them back from stored attachments.
 *
 *  With nothing to resume this is `buildRequestPrompt` verbatim: non-Anthropic
 *  providers cache on a byte-identical prefix, so a fresh run must NOT grow a
 *  `messages` key it didn't have before. */
function buildResumableRequest(
  modelId: ModelId,
  system: string,
  userTurn: { prompt: string } | { messages: ModelMessage[] },
  resumeMessages: ModelMessage[] | undefined,
) {
  if (!resumeMessages || resumeMessages.length === 0) {
    return buildRequestPrompt(modelId, system, userTurn);
  }
  const userMessages: ModelMessage[] =
    "messages" in userTurn
      ? userTurn.messages
      : [{ role: "user", content: userTurn.prompt }];
  return buildRequestPrompt(modelId, system, {
    messages: [...userMessages, ...resumeMessages],
  });
}

type SdkUsageLike = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  inputTokenDetails?: { cacheReadTokens?: number };
  /** Deprecated alias some providers still populate. */
  cachedInputTokens?: number;
};

/** The slice of the SDK's StepResult the accumulator reads. Structural rather
 *  than `StepResult<ToolSet>` so one handler stays assignable to both
 *  generateText's and streamText's onStepFinish parameter types. */
type AccumulatedStep = Parameters<typeof stepToActivity>[0] & {
  response?: { messages?: ModelMessage[] };
  finishReason?: FinishReason;
  usage?: SdkUsageLike;
  text?: string;
};

const USAGE_FIELDS = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cacheReadTokens",
] as const;

/** Normalize one SDK usage record. A count the provider didn't report stays
 *  ABSENT rather than 0 — otherwise a sum over steps silently turns "unknown"
 *  into a confident wrong number (or NaN). */
function toTaskUsage(u: SdkUsageLike | undefined): TaskUsage | undefined {
  if (!u) return undefined;
  const out: TaskUsage = {};
  if (typeof u.inputTokens === "number") out.inputTokens = u.inputTokens;
  if (typeof u.outputTokens === "number") out.outputTokens = u.outputTokens;
  if (typeof u.totalTokens === "number") out.totalTokens = u.totalTokens;
  const cacheRead = u.inputTokenDetails?.cacheReadTokens ?? u.cachedInputTokens;
  if (typeof cacheRead === "number") out.cacheReadTokens = cacheRead;
  return out;
}

/** Per-step bookkeeping shared by the generateText and streamText paths: the
 *  tool-activity sweep as before, PLUS the transcript, step count, usage and
 *  finish reason a caller needs to resume a run that dies mid-loop.
 *
 *  Unlike the callback it replaces this is always attached — the scalars it
 *  collects feed the TaskResult even when nobody subscribed to onToolEvent or
 *  onCheckpoint. */
function makeStepAccumulator(
  start: number,
  input: Pick<
    TaskInput<z.ZodTypeAny | undefined>,
    "onToolEvent" | "onCheckpoint" | "resumeMessages"
  >,
) {
  const messages: ModelMessage[] = [];
  const stepTexts: string[] = [];
  const usage: TaskUsage = {};
  let stepsUsed = 0;
  let finishReason: FinishReason | undefined;

  const snapshotUsage = (): TaskUsage => ({ ...usage });

  return {
    get stepsUsed() {
      return stepsUsed;
    },
    get finishReason() {
      return finishReason;
    },
    get usage() {
      return snapshotUsage();
    },
    /** Each completed step's text, in order — what streamTask needs to tell
     *  the FINAL answer apart from the all-steps textStream concatenation. */
    get stepTexts(): readonly string[] {
      return stepTexts;
    },
    onStepFinish(step: AccumulatedStep) {
      if (input.onToolEvent) {
        for (const e of stepToActivity(step, start)) input.onToolEvent(e);
      }
      if (step.response?.messages) messages.push(...step.response.messages);
      stepTexts.push(typeof step.text === "string" ? step.text : "");
      stepsUsed++;
      finishReason = step.finishReason;
      const stepUsage = toTaskUsage(step.usage);
      if (stepUsage) {
        for (const k of USAGE_FIELDS) {
          const v = stepUsage[k];
          if (v !== undefined) usage[k] = (usage[k] ?? 0) + v;
        }
      }
      // Snapshot, don't alias: a caller persisting the checkpoint must not see
      // it mutate underneath them when the next step lands.
      input.onCheckpoint?.({
        messages: [...(input.resumeMessages ?? []), ...messages],
        stepsUsed,
        usage: snapshotUsage(),
        finishReason,
      });
    },
  };
}

/** A run that burned its whole step budget and stopped still calling tools never
 *  reached the point of writing its answer — that's a cut-off loop, not a model
 *  that returned garbage, and only the former is worth resuming with more
 *  budget. Schema-valid text always wins as a success, whatever the step count. */
function stepCapReason<R extends "empty" | "schema_violation">(
  fallback: R,
  scalars: TaskScalars,
  maxSteps: number,
): R | "step_cap" {
  return scalars.stepsUsed === maxSteps && scalars.finishReason === "tool-calls"
    ? "step_cap"
    : fallback;
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
          // Single-shot: no agentic loop, so nothing to resume from.
          stepsUsed: 0,
          usage: toTaskUsage(r.usage),
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
      stepsUsed: 0,
    };
  }

  // --- Structured + tools, or prose: generateText --------------------------
  const prepareStep = tools ? anthropicStepCachePrepare(input.modelId) : undefined;
  const steps = makeStepAccumulator(start, input);
  const r = await generateText({
    model,
    ...buildResumableRequest(input.modelId, system, userTurn, input.resumeMessages),
    ...(tools ? { tools, stopWhen: stepCountIs(maxSteps) } : {}),
    ...(prepareStep ? { prepareStep } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(input.seed !== undefined ? { seed: input.seed } : {}),
    maxRetries: TASK_MAX_RETRIES,
    abortSignal: input.signal,
    onStepFinish: steps.onStepFinish,
  });

  const scalars: TaskScalars = {
    stepsUsed: steps.stepsUsed,
    finishReason: steps.finishReason,
    usage: steps.usage,
  };
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
        reason: stepCapReason("empty", scalars, maxSteps),
        text: "",
        durationMs: Date.now() - start,
        ...scalars,
      };
    }
    const parsed = validateAgainstSchema(text, input.schema);
    if (!parsed.ok) {
      return {
        ok: false,
        reason: stepCapReason("schema_violation", scalars, maxSteps),
        text,
        durationMs: Date.now() - start,
        ...scalars,
      };
    }
    return {
      ok: true,
      text,
      object: parsed.value as InferObject<S>,
      durationMs: Date.now() - start,
      ...scalars,
    };
  }
  return {
    ok: true,
    text,
    object: undefined as InferObject<S>,
    durationMs: Date.now() - start,
    ...scalars,
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
  const steps = makeStepAccumulator(start, input);
  const result = streamText({
    model,
    ...buildResumableRequest(input.modelId, system, userTurn, input.resumeMessages),
    ...(tools ? { tools, stopWhen: stepCountIs(maxSteps) } : {}),
    ...(prepareStep ? { prepareStep } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(input.seed !== undefined ? { seed: input.seed } : {}),
    maxRetries: TASK_MAX_RETRIES,
    abortSignal: input.signal,
    // Live per-tool events (spinner → done) plus the step-finish sweep as a
    // backstop; both key entries by toolCallId so they merge, not duplicate.
    onChunk: liveToolOnChunk(start, toolStart, input.onToolEvent),
    onStepFinish: steps.onStepFinish,
    onError: ({ error }) => {
      if (streamError == null) streamError = error;
    },
  });

  let acc = "";
  for await (const chunk of result.textStream) {
    acc += chunk;
    input.onText(chunk);
  }

  const scalars: TaskScalars = {
    stepsUsed: steps.stepsUsed,
    finishReason: steps.finishReason,
    usage: steps.usage,
  };

  // `acc` is EVERY step's text concatenated (the SDK's textStream spans the
  // whole agentic loop), but the answer is only the LAST step's text —
  // validating the concatenation let a fenced snippet from mid-run narration
  // shadow the real answer (and, with defaulted schemas, "validate" as an
  // empty batch: the generator's "produced no test cases", Commit Review's
  // false clean). Completed steps' texts are exact prefixes of `acc`, so any
  // remainder is the in-flight step that never finished — the right text to
  // salvage when the stream died mid-answer.
  const completedTextLen = steps.stepTexts.reduce((n, t) => n + t.length, 0);
  const inFlightTail = acc.slice(completedTextLen);
  const lastStepText = steps.stepTexts[steps.stepTexts.length - 1] ?? "";
  const finalText = inFlightTail.trim() ? inFlightTail : lastStepText || acc;

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
      const parsed = validateAgainstSchema(finalText, input.schema);
      if (parsed.ok) {
        return {
          ok: true,
          text: finalText,
          object: parsed.value as InferObject<S>,
          durationMs: Date.now() - start,
          ...scalars,
        };
      }
    }
    throw streamError instanceof Error
      ? streamError
      : new Error(String(streamError));
  }

  if (input.schema) {
    if (!finalText.trim()) {
      // No final answer at all — mirror runTask's "empty" (or step_cap when
      // the loop burned its budget still calling tools) instead of blaming
      // the schema. `text` keeps the narration for display/salvage.
      return {
        ok: false,
        reason: stepCapReason("empty", scalars, maxSteps),
        text: acc,
        durationMs: Date.now() - start,
        ...scalars,
      };
    }
    const parsed = validateAgainstSchema(finalText, input.schema);
    if (!parsed.ok) {
      return {
        ok: false,
        reason: stepCapReason("schema_violation", scalars, maxSteps),
        text: finalText,
        durationMs: Date.now() - start,
        ...scalars,
      };
    }
    return {
      ok: true,
      text: finalText,
      object: parsed.value as InferObject<S>,
      durationMs: Date.now() - start,
      ...scalars,
    };
  }
  return {
    ok: true,
    text: acc,
    object: undefined as InferObject<S>,
    durationMs: Date.now() - start,
    ...scalars,
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

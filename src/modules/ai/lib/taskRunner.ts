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
  type ToolSet,
} from "ai";
import type { z } from "zod";
import { MAX_AGENT_STEPS, type ModelId } from "../config";
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
  newActivityId,
  stepToActivity,
  stringifyResult,
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

/** Assemble the system prompt: base + optional project memory + custom
 *  instructions. Surfaces that pass neither get the base verbatim. */
function assembleSystem(input: TaskInput<z.ZodTypeAny | undefined>): string {
  return buildStableSystem(
    input.systemPrompt,
    input.customInstructions,
    input.projectMemory ?? null,
  );
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
      const raw = stringifyResult(c.output ?? c.result);
      onToolEvent({
        id,
        ts: Date.now() - start,
        kind: "tool",
        toolName: c.toolName ?? "tool",
        durationMs: startedAt != null ? Date.now() - startedAt : 0,
        outputSummary: raw ? clampOutputSummary(raw) : undefined,
        outputFull: raw ? clampOutputFull(raw) : undefined,
      });
    }
  };
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
  const userTurn = buildUserTurn(input.prompt, input.attachments);
  const tools = input.tools ?? undefined;
  const maxSteps = input.maxSteps ?? MAX_AGENT_STEPS;
  const repairAttempts = input.repairAttempts ?? DEFAULT_REPAIR_ATTEMPTS;

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
          schema: input.schema,
          ...(input.temperature !== undefined
            ? { temperature: input.temperature }
            : {}),
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
      reason: "schema_violation",
      text: lastText,
      durationMs: Date.now() - start,
    };
  }

  // --- Structured + tools, or prose: generateText --------------------------
  const r = await generateText({
    model,
    system,
    ...userTurn,
    ...(tools ? { tools, stopWhen: stepCountIs(maxSteps) } : {}),
    ...(input.temperature !== undefined
      ? { temperature: input.temperature }
      : {}),
    ...(input.seed !== undefined ? { seed: input.seed } : {}),
    abortSignal: input.signal,
    onStepFinish: onStepFinishFor(start, input.onToolEvent),
  });

  const text = r.text ?? "";
  if (input.schema) {
    // The model ran its tool loop and emitted the object as its final text;
    // validate that against the schema (the prompts instruct "return ONLY the
    // JSON"). On failure the surface's own salvage/parse fallback can still
    // recover partial output from `text`.
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
  const userTurn = buildUserTurn(input.prompt, input.attachments);
  const tools = input.tools ?? undefined;
  const maxSteps = input.maxSteps ?? MAX_AGENT_STEPS;

  const toolStart = new Map<string, number>();
  const result = streamText({
    model,
    system,
    ...userTurn,
    ...(tools ? { tools, stopWhen: stepCountIs(maxSteps) } : {}),
    ...(input.temperature !== undefined
      ? { temperature: input.temperature }
      : {}),
    ...(input.seed !== undefined ? { seed: input.seed } : {}),
    abortSignal: input.signal,
    // Live per-tool events (spinner → done) plus the step-finish sweep as a
    // backstop; both key entries by toolCallId so they merge, not duplicate.
    onChunk: liveToolOnChunk(start, toolStart, input.onToolEvent),
    onStepFinish: onStepFinishFor(start, input.onToolEvent),
  });

  let acc = "";
  for await (const chunk of result.textStream) {
    acc += chunk;
    input.onText(chunk);
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

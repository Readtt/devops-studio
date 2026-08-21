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
  streamText,
  type FinishReason,
  type ModelMessage,
  type ToolSet,
} from "ai";
import type { z } from "zod";
import {
  DEFAULT_TOKEN_BUDGET,
  getModel,
  getModelOutputCap,
  MAX_AGENT_STEPS,
  supportsTemperature,
  supportsVision,
  type ModelId,
} from "../config";
import {
  limitReached,
  runStopConditions,
  stepSpend,
  type BudgetLimit,
  type RunBudget,
} from "./runBudget";
import {
  buildConfiguredLanguageModel,
  buildStableSystem,
  type LocalProviderConfig,
} from "./agent";
import type { ProviderKeys } from "./keyring";
import { extractJsonBlock } from "./extractJson";
import {
  measureRequestContext,
  type RequestContextSignal,
} from "./contextEstimate";
import {
  compactTranscript,
  CONTEXT_COMPACTION_ENABLED,
} from "./compactTranscript";
import {
  CONTEXT_SUMMARIZATION_ENABLED,
  pickSummarizerModel,
  planSummarization,
  summaryMessage,
  SUMMARIZER_SYSTEM_PROMPT,
  SUMMARY_MAX_OUTPUT_TOKENS,
} from "./summarizeTranscript";
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
  /** How full the window was on the most recent step, from the provider's own
   *  count. Absent when no step reported an input count. */
  context?: RequestContextSignal;
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
  /** A leading user turn carrying the material that does NOT change from turn to
   *  turn — the suite and its cases, the spec, the draft, the standards blocks.
   *  Split out from `prompt` purely so the prompt cache can cover it: it sits in
   *  front of {@link priorMessages}, so the whole conversation up to the newest
   *  question is a stable prefix that grows only at the end. Omit for surfaces
   *  that send one turn and are done. */
  contextPrompt?: string;
  /** The conversation so far, as REAL user/assistant messages rather than prose
   *  quoted inside `prompt`. Both are the same bytes to the model; only the
   *  former can be cached, because a rebuilt prose block changes shape in the
   *  MIDDLE of the request every turn and a cached prefix has to be a prefix. */
  priorMessages?: ModelMessage[];
  attachments?: ImageLike[];
  /** Read-only tool set (build*Tools). null/undefined ⇒ tool-less.
   *
   *  There is deliberately no `toolChoice` beside this. It reads like the way
   *  to say "declare the tools but don't call them" — what a finish pass wants
   *  — and it does not mean the same thing twice: `@ai-sdk/anthropic`
   *  implements `toolChoice: "none"` by returning `tools: undefined`, dropping
   *  the definitions, which on a replayed transcript full of tool blocks IS the
   *  400 the caller was avoiding; OpenAI and openai-compatible keep them and
   *  forward the parameter. A knob whose meaning inverts by provider is worse
   *  than no knob, so surfaces that need this instruct the model instead
   *  (FINISH_NOW_NUDGE) and bound it with a token budget. */
  tools?: ToolSet | null;
  /** Explicit per call. Omit ⇒ provider default (no hidden global). */
  temperature?: number;
  seed?: number;
  /** Runaway step ceiling for the agentic loop (only meaningful with tools).
   *  Not the budget — see `tokenBudget`. */
  maxSteps?: number;
  /** Tokens this call may spend across all its steps before the loop is stopped
   *  — the PRIMARY budget (runBudget.ts). Omit ⇒ {@link DEFAULT_TOKEN_BUDGET};
   *  every live surface passes its own from `SURFACE_TOKEN_BUDGETS`. */
  tokenBudget?: number;
  /** Output-token cap per REQUEST (each agentic step is one request). Omit ⇒
   *  the per-model cap from config (`getModelOutputCap`); no entry there either
   *  ⇒ nothing is sent and the endpoint decides, exactly as before this field
   *  existed. Only the truncation-resume path passes an explicit value — it
   *  retries at the model's ceiling. */
  maxOutputTokens?: number;
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
  /** Fired after each step whose usage carried an input count, with how full
   *  the window was for THAT request. */
  onContextSignal?: (signal: RequestContextSignal) => void;
  /** Continuation transcript from a previous call. When set, the request is
   *  [rebuilt system + user turn, ...resumeMessages]. The user turn is rebuilt
   *  fresh from prompt/attachments (images stay Uint8Array — they never come
   *  from persisted state; callers rebuild them from stored attachments). */
  resumeMessages?: ModelMessage[];
  /** Per-call override of the eviction kill switch
   *  ({@link CONTEXT_COMPACTION_ENABLED}). Even when on, eviction only fires
   *  once a step's measured prompt lands inside the compaction buffer, so an
   *  ordinary run never reaches it. */
  compactContext?: boolean;
  /** Per-call override of the summarization kill switch
   *  ({@link CONTEXT_SUMMARIZATION_ENABLED}). This is the one control that costs
   *  a model call, so it sits behind eviction: it fires only after eviction has
   *  run and freed nothing, and then at most once per attempt. */
  summarizeContext?: boolean;
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
  /** Tokens this call spent, summed across its steps (runBudget.ts). 0 when the
   *  provider reported no usage — indistinguishable from a free run, which is
   *  exactly why the step ceiling is kept. */
  tokensUsed: number;
  finishReason?: FinishReason;
  usage?: TaskUsage;
  /** Window pressure on the last measured step. See {@link RequestContextSignal}. */
  context?: RequestContextSignal;
  /** Which guard the loop ran into, when it ran into one. Present even on a
   *  SUCCESSFUL run that answered on its last allowed step — the reason field
   *  is what says the run failed; this only says what bound it. */
  limit?: BudgetLimit;
  /** The output cap this call's requests actually asked for (explicit or the
   *  per-model config cap). Absent ⇒ none was sent. Persisted onto the failure
   *  outcome so a `finish: length` resume can tell whether a HIGHER cap even
   *  exists to retry with — without it, that gate would be a guess. */
  outputCap?: number;
};

export type TaskResult<S extends z.ZodTypeAny | undefined = undefined> =
  | ({
      ok: true;
      text: string;
      /** The FINAL step's answer, as opposed to `text`, which on the streaming
       *  path is every step's text concatenated across the whole agentic loop.
       *  The two differ exactly when the loop ended without writing an answer:
       *  `text` is then the mid-run narration ("I'll dig into the collect
       *  code…") and this is empty. A prose surface has to show `text` — the
       *  user watched it stream — but must not mistake it for a reply.
       *
       *  Set by `streamTask` only; `runTask` has one text and no such split. */
      finalText?: string;
      object: InferObject<S>;
      durationMs: number;
    } & TaskScalars)
  | ({
      ok: false;
      /** schema_violation ⇒ repair budget exhausted; empty ⇒ no usable text;
       *  step_cap ⇒ the loop ran into a RUN BUDGET (tokens, or the step ceiling
       *  — `limit` says which) still calling tools, so the model never got to
       *  write its answer. Retryable with a topped-up budget or a resume, unlike
       *  a model that returned garbage. The name predates the token budget and
       *  is kept because it is persisted in every existing checkpoint's
       *  `lastOutcome.kind`. */
      reason: "schema_violation" | "empty" | "step_cap";
      text: string;
      /** Same split as the success arm, and load-bearing for the SALVAGE paths.
       *  On the `empty` arm `text` is the whole run's narration, so a surface
       *  that scans it for a JSON batch can pick up a draft the model sketched
       *  mid-run and later abandoned — the very shadowing the final-step-only
       *  validation above exists to prevent. Salvage from this instead: it is
       *  the last step's text, empty exactly when there was no answer to
       *  salvage. Set by `streamTask` only. */
      finalText?: string;
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
 *  needs no explicit breakpoints, and their requests must stay byte-identical.
 *  (They may still get a `prepareStep` from {@link buildStepPrepare}, which
 *  wraps this one — but it only overrides messages when eviction actually
 *  rewrote something.) */
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

/** The `prepareStep` the agentic paths actually install: tool-result eviction
 *  composed with the Anthropic cache breakpoint.
 *
 *  COMPOSE, don't replace. Compaction is provider-agnostic (every provider has a
 *  context window); the tagging stays Anthropic-only. The tagger's return value
 *  is what gets sent, so it has to be computed over the COMPACTED list — hand it
 *  the raw one and its output silently throws the eviction away, which is the
 *  easy way to write this and does nothing at all on the only provider where
 *  running out of window costs the most.
 *
 *  ARMED ONCE, NEVER DISARMED. `shouldCompact` is derived from the last
 *  completed step's measured prompt, and eviction makes the next request
 *  smaller — so a naive `if (shouldCompact)` would compact, drop back under the
 *  buffer, un-compact, cross it again, and rewrite the prefix on every single
 *  step. That is the sliding-window cache-invalidation failure wearing a
 *  different hat, and it costs more than it saves. The latch means the prefix
 *  changes at most once for arming, and after that only when the eviction
 *  boundary itself advances.
 *
 *  SUMMARIZATION IS THE RUNG BELOW EVICTION, not an alternative to it. It fires
 *  only when eviction runs and frees NOTHING — every result outside the hot tail
 *  is already a stub, so the cheap mechanism has nothing left to take — and then
 *  at most once, because it costs a model call. Once a summary is installed it is
 *  re-applied byte-identically on every later step from the same cut index; the
 *  prefix therefore changes exactly once more, which is the same bargain the
 *  arming latch makes.
 *
 *  Returning `undefined` when nothing changed is deliberate: a run that never
 *  trips the budget sends byte-identical requests to what it sent before this
 *  existed. */
function buildStepPrepare(
  modelId: ModelId,
  compactionEnabled: boolean,
  contextOf: () => RequestContextSignal | undefined,
  summarize?: (messages: ModelMessage[]) => Promise<InstalledSummary | null>,
):
  | (({
      messages,
    }: {
      messages: ModelMessage[];
    }) =>
      | { messages: ModelMessage[] }
      | undefined
      | Promise<{ messages: ModelMessage[] } | undefined>)
  | undefined {
  const cache = anthropicStepCachePrepare(modelId);
  if (!compactionEnabled) return cache;
  let armed = false;
  let summaryTried = false;
  // The installed summary. The SDK hands us the FULL history every step (it
  // never writes the override back), so re-applying it means slicing that
  // history at the same index again — hence an index, not a message reference.
  let summary: InstalledSummary | null = null;

  const finish = (
    original: ModelMessage[],
    next: ModelMessage[],
  ): { messages: ModelMessage[] } | undefined => {
    const tagged = cache?.({ messages: next });
    if (tagged) return tagged;
    return next === original ? undefined : { messages: next };
  };

  return ({ messages }) => {
    if (!armed && contextOf()?.shouldCompact === true) armed = true;
    const base = summary ? applyInstalledSummary(summary, messages) : messages;
    if (!armed) return finish(messages, base);

    const compacted = compactTranscript(base).messages;
    // Deliberately NOT an async function: every step of every agentic run goes
    // through here, and only the one step that actually summarizes should hand
    // the SDK a promise to await. The common path stays exactly as synchronous
    // as it was before summarization existed.
    if (summarize && !summaryTried && compacted === base) {
      // Eviction ran and freed nothing: everything outside the hot tail is
      // already a stub. This is the only state summarization is for.
      summaryTried = true;
      return summarize(base).then((installed) => {
        summary = installed;
        if (!installed) return finish(messages, compacted);
        return finish(
          messages,
          compactTranscript(applyInstalledSummary(installed, messages)).messages,
        );
      });
    }
    return finish(messages, compacted);
  };
}

/** A summary that has been installed for the rest of this attempt: the messages
 *  that go in front, and the offset in the SDK's (still full) history they
 *  replace up to. */
type InstalledSummary = { prefix: ModelMessage[]; cutIndex: number };

function applyInstalledSummary(
  summary: InstalledSummary,
  messages: ModelMessage[],
): ModelMessage[] {
  return [...summary.prefix, ...messages.slice(summary.cutIndex)];
}

/** The summarization callback `buildStepPrepare` calls, or undefined when the
 *  fallback is off. Lives here rather than in summarizeTranscript.ts so the pure
 *  module never has to import the runner back (and so the one place in the app
 *  that talks to a provider stays this file).
 *
 *  Everything is swallowed. A summarizer that throws — no key for the cheap
 *  provider, its own overload, an abort — must degrade to "no summary" and let
 *  the step go out as it would have anyway. It is a recovery attempt on a run
 *  that is already in trouble, not a new failure mode for it. */
function makeSummarizer(
  input: TaskInput<z.ZodTypeAny | undefined>,
): ((messages: ModelMessage[]) => Promise<InstalledSummary | null>) | undefined {
  if (!(input.summarizeContext ?? CONTEXT_SUMMARIZATION_ENABLED)) return undefined;
  return async (messages) => {
    try {
      const plan = planSummarization(messages);
      if (!plan) return null;
      const summarizerId = pickSummarizerModel(
        input.modelId,
        input.keys,
        plan.sourceTokens,
      );
      const model = await buildConfiguredLanguageModel(
        summarizerId,
        input.keys,
        input.local ?? {},
      );
      const { text } = await generateText({
        model,
        system: SUMMARIZER_SYSTEM_PROMPT,
        prompt: plan.source,
        ...(supportsTemperature(summarizerId) ? { temperature: 0 } : {}),
        maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS,
        // One attempt, not TASK_MAX_RETRIES: the run is inside its compaction
        // buffer and waiting out a rate-limit window here just moves the
        // failure. No summary is a survivable outcome; a two-minute stall
        // inside prepareStep is not.
        maxRetries: 1,
        abortSignal: input.signal,
      });
      const summary = text?.trim();
      if (!summary) return null;
      return {
        prefix: [...messages.slice(0, plan.protectedCount), summaryMessage(summary)],
        cutIndex: plan.cutIndex,
      };
    } catch (e) {
      console.warn("[taskRunner] context summarization failed — continuing without it", e);
      return null;
    }
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
  if (!isAnthropicCacheable(modelId)) {
    return "messages" in userTurn
      ? { system, messages: endOnUserTurn(userTurn.messages) }
      : { system, ...userTurn };
  }
  const systemMessage: ModelMessage = {
    role: "system",
    content: system,
    providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
  };
  const userMessages: ModelMessage[] =
    "messages" in userTurn
      ? endOnUserTurn(userTurn.messages)
      : [{ role: "user", content: userTurn.prompt }];
  return { messages: [systemMessage, ...userMessages] };
}

/** Appended when a replayed transcript would otherwise leave the request ending
 *  on the model's own turn. It has to work for both shapes that reach it: a run
 *  cut off with its final answer already written (repeat it — the answer is what
 *  was lost) and one cut off mid-thought (carry on). */
export const RESUME_CONTINUE_NUDGE =
  "The run was interrupted after your last message. Pick up from there: if that message was already your complete final answer, write it out again in full, in exactly the output format the instructions require. Otherwise carry on from where you stopped.";

/** Guarantee the conversation ends on a user turn.
 *
 *  Anthropic's Claude 5 tier removed assistant prefill, so a request whose last
 *  message is an assistant turn is refused outright — "this model does not
 *  support assistant message prefill. The conversation must end with a user
 *  message." Nothing here ever means to prefill: a trailing assistant turn is
 *  always an artefact of REPLAY. A banked transcript ends on one whenever the
 *  last step a run completed wrote text without calling a tool — every run
 *  killed, crashed or cancelled just after the model's final answer — and the
 *  resume paths that append no nudge (`error` / `cancelled` / an unflushed
 *  crash's null outcome) replay it verbatim.
 *
 *  It lives at the one function every request is built by rather than at the
 *  four resume call sites, because the call sites are where it was missed. The
 *  two shapes that are already correct are returned UNTOUCHED, and both are the
 *  common ones: a `tool` message is a user turn as far as Anthropic is concerned
 *  (the provider folds tool results into a user message), and the finish-pass
 *  branches already end on a real nudge. The only array this rewrites is one
 *  that would have 400'd.
 *
 *  Enforced for every provider, not only Anthropic. Ending on a user turn is
 *  what all of them expect — OpenAI and the openai-compatible gateways merely
 *  tolerate the alternative — and a rule that holds everywhere cannot be missed
 *  the next time a provider is added. The turn is added at REQUEST time only, so
 *  it never enters the banked transcript; growing a synthetic instruction into
 *  stored history each resume is the bug `withoutFinishNudge` exists to undo. */
function endOnUserTurn(messages: ModelMessage[]): ModelMessage[] {
  if (messages[messages.length - 1]?.role !== "assistant") return messages;
  return [...messages, { role: "user", content: RESUME_CONTINUE_NUDGE }];
}

/** The user side of the request: an optional stable context turn, the prior
 *  conversation, then the turn being answered.
 *
 *  A surface that passes neither of the first two gets `buildUserTurn` verbatim
 *  — a bare `{ prompt }` string when there are no images — so every single-turn
 *  surface sends byte-for-byte what it sent before this existed, and the
 *  providers that cache on an identical prefix are undisturbed.
 *
 *  Consecutive user messages are fine: the Anthropic provider groups same-role
 *  messages into one turn with several content blocks, and every other provider
 *  passes them through. What matters is the ORDER — stable context first, then
 *  history oldest-first, then the new question — because that is what makes each
 *  turn's request an extension of the last one's rather than a rewrite of it. */
function buildConversationTurn(
  input: Pick<
    TaskInput<z.ZodTypeAny | undefined>,
    "modelId" | "prompt" | "contextPrompt" | "priorMessages" | "attachments"
  >,
): { prompt: string } | { messages: ModelMessage[] } {
  const current = buildUserTurn(input.prompt, visionSafe(input));
  const context = input.contextPrompt?.trim() ? input.contextPrompt : null;
  const prior = input.priorMessages ?? [];
  if (!context && prior.length === 0) return current;
  const currentMessages: ModelMessage[] =
    "messages" in current
      ? current.messages
      : [{ role: "user", content: current.prompt }];
  return {
    messages: [
      ...(context ? [{ role: "user" as const, content: context }] : []),
      ...prior,
      ...currentMessages,
    ],
  };
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
    "modelId" | "onToolEvent" | "onCheckpoint" | "onContextSignal" | "resumeMessages"
  >,
) {
  const messages: ModelMessage[] = [];
  const stepTexts: string[] = [];
  const usage: TaskUsage = {};
  let stepsUsed = 0;
  let tokensUsed = 0;
  let finishReason: FinishReason | undefined;
  let context: RequestContextSignal | undefined;

  const snapshotUsage = (): TaskUsage => ({ ...usage });

  return {
    get stepsUsed() {
      return stepsUsed;
    },
    /** Tokens spent across this call's completed steps. Accumulated with the
     *  same {@link stepSpend} the `stopWhen` condition sums with, so the
     *  after-the-fact verdict from `limitReached` can't disagree with the stop
     *  the SDK actually made. */
    get tokensUsed() {
      return tokensUsed;
    },
    get finishReason() {
      return finishReason;
    },
    get usage() {
      return snapshotUsage();
    },
    /** Window pressure on the last step that reported an input count. Lags the
     *  live request by one step — it describes the prompt the provider has
     *  already answered, and the next one is bigger by whatever this step
     *  added. Phase 3's eviction decision has to allow for that. */
    get context() {
      return context;
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
      tokensUsed += stepSpend(stepUsage);
      // Measured off THIS step's usage, never the running sum: `usage` counts
      // the re-sent transcript once per step (that's what was billed), which
      // says nothing about how full the window is.
      const signal = measureRequestContext({
        modelId: input.modelId,
        usage: stepUsage,
      });
      if (signal) {
        context = signal;
        input.onContextSignal?.(signal);
      }
      // Snapshot, don't alias: a caller persisting the checkpoint must not see
      // it mutate underneath them when the next step lands.
      input.onCheckpoint?.({
        messages: [...(input.resumeMessages ?? []), ...messages],
        stepsUsed,
        usage: snapshotUsage(),
        finishReason,
        ...(context ? { context } : {}),
      });
    },
  };
}

/** The budget one call runs under: the caller's, or the conservative defaults.
 *  Both halves are always present — a surface that names a token budget still
 *  gets a runaway ceiling, and one that names neither still gets both. */
function runBudgetOf(input: TaskInput<z.ZodTypeAny | undefined>): RunBudget {
  return {
    tokens: input.tokenBudget ?? DEFAULT_TOKEN_BUDGET,
    steps: input.maxSteps ?? MAX_AGENT_STEPS,
  };
}

/** The per-run scalars both result arms carry, read off the accumulator once so
 *  the two paths can't drift on what they report. */
function scalarsOf(
  steps: ReturnType<typeof makeStepAccumulator>,
  budget: RunBudget,
): TaskScalars {
  const limit = limitReached({
    tokensUsed: steps.tokensUsed,
    stepsUsed: steps.stepsUsed,
    budget,
  });
  return {
    stepsUsed: steps.stepsUsed,
    tokensUsed: steps.tokensUsed,
    finishReason: steps.finishReason,
    usage: steps.usage,
    ...(steps.context ? { context: steps.context } : {}),
    ...(limit ? { limit } : {}),
  };
}

/** A run that ran into a budget guard and stopped still calling tools never
 *  reached the point of writing its answer — that's a cut-off loop, not a model
 *  that returned garbage, and only the former is worth resuming with more
 *  budget. Schema-valid text always wins as a success, whatever it spent.
 *
 *  Reads `scalars.limit`, which covers BOTH guards. The equality test this
 *  replaces (`stepsUsed === maxSteps`) is exactly wrong for the token budget:
 *  that stop lands with steps to spare, so a run cut off mid-loop by spend would
 *  have been reported as `schema_violation` — the same "the model returned bad
 *  output" lie about a model that was simply interrupted that the step-cap
 *  reason was introduced to end. */
function budgetReason<R extends "empty" | "schema_violation">(
  fallback: R,
  scalars: TaskScalars,
): R | "step_cap" {
  return scalars.limit && scalars.finishReason === "tool-calls"
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

/** Omit `temperature` for models that reject sampling params — reasoning models
 *  plus the frontier Anthropic/OpenAI tiers that removed the param outright.
 *  `supportsTemperature` owns the per-model call so it holds for every
 *  transport, including the openai-compatible one that forwards our body
 *  verbatim. Returns the caller's temperature for every other model. */
function effectiveTemperature(input: {
  modelId: ModelId;
  temperature?: number;
}): number | undefined {
  return supportsTemperature(input.modelId) ? input.temperature : undefined;
}

/** The output cap this call's requests ask for: the caller's explicit value,
 *  else the per-model cap from config. Undefined ⇒ nothing is sent — the
 *  request is byte-identical to before caps existed, and the endpoint's own
 *  default governs (the only safe answer for models we haven't catalogued). */
function effectiveOutputCap(input: {
  modelId: ModelId;
  maxOutputTokens?: number;
}): number | undefined {
  return input.maxOutputTokens ?? getModelOutputCap(input.modelId);
}

/** Provider errors arrive wrapped (RetryError → APICallError), and the useful
 *  string sits on `cause` or the raw `responseBody` as often as on the outer
 *  error. Read all of them, cheaply. */
function providerMessage(e: unknown): string {
  if (e == null) return "";
  if (typeof e === "string") return e;
  const o = e as {
    message?: unknown;
    cause?: unknown;
    responseBody?: unknown;
    lastError?: unknown;
  };
  const parts: string[] = [];
  if (typeof o.message === "string") parts.push(o.message);
  for (const nested of [o.cause, o.lastError]) {
    const n = nested as { message?: unknown } | null | undefined;
    if (n && typeof n.message === "string") parts.push(n.message);
  }
  if (typeof o.responseBody === "string") parts.push(o.responseBody);
  return parts.join(" ");
}

/** A provider 400 meaning "this model rejects the sampling params you sent":
 *  Anthropic's "`temperature` is deprecated for this model", OpenAI's
 *  "Unsupported value: 'temperature' does not support 0 with this model", and
 *  whatever a gateway relays upstream. Requires BOTH a param name and a
 *  rejection verb, so an unrelated failure that merely mentions temperature
 *  can't trigger a pointless retry. */
function isSamplingParamRejection(message: string): boolean {
  const m = message.toLowerCase();
  if (!/\btemperature\b|\btop[_ -]?p\b|\btop[_ -]?k\b/.test(m)) return false;
  return /not support|unsupported|deprecated|not permitted|not allowed|invalid/.test(
    m,
  );
}

/** Whether to retry a failed request once with sampling params stripped.
 *
 *  The per-model table in config.ts catches every catalogued model, but it can't
 *  know a user's custom OpenAI-compatible endpoint, a gateway route we haven't
 *  curated, or a model released after this build. Those return a hard 400 that
 *  is trivially recoverable — drop the param and ask again — so recover instead
 *  of showing the user a dead run. Safe to reuse the step accumulator across the
 *  two attempts: sampling params are identical on every step of a loop, so a
 *  rejection can only land on the first request, before any step completed. */
function shouldRetryWithoutSampling(
  temperature: number | undefined,
  e: unknown,
  signal: AbortSignal | undefined,
): boolean {
  if (temperature === undefined || signal?.aborted) return false;
  return isSamplingParamRejection(providerMessage(e));
}

/** AI SDK error names that mean the request never reached the point of producing
 *  model output — a transport/HTTP failure, a missing key, or an exhausted retry
 *  chain. Everything else a structured call can throw (NoObjectGenerated, JSON
 *  parse, type validation) is a schema miss the repair loop may legitimately
 *  retry. */
const PROVIDER_FAILURE_NAMES = new Set([
  "AI_APICallError",
  "AI_LoadAPIKeyError",
  "AI_RetryError",
]);

function isProviderFailure(e: unknown): boolean {
  const o = e as { name?: unknown; statusCode?: unknown } | null | undefined;
  if (typeof o?.name === "string" && PROVIDER_FAILURE_NAMES.has(o.name)) {
    return true;
  }
  // Some endpoints surface an HTTP failure without an SDK wrapper.
  return typeof o?.statusCode === "number" && o.statusCode >= 400;
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
  const userTurn = buildConversationTurn(input);
  const tools = input.tools ?? undefined;
  const budget = runBudgetOf(input);
  const repairAttempts = input.repairAttempts ?? DEFAULT_REPAIR_ATTEMPTS;
  const temperature = effectiveTemperature(input);
  const outputCap = effectiveOutputCap(input);

  // --- Structured, tool-less: generateObject -------------------------------
  if (input.schema && !tools) {
    let attempt = 0;
    let lastText = "";
    // Dropped (once) if the provider turns out to reject sampling params.
    let temp = temperature;
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
          ...(temp !== undefined ? { temperature: temp } : {}),
          ...(input.seed !== undefined ? { seed: input.seed } : {}),
          ...(outputCap !== undefined ? { maxOutputTokens: outputCap } : {}),
          abortSignal: input.signal,
        });
        const usage = toTaskUsage(r.usage);
        const context = measureRequestContext({ modelId: input.modelId, usage });
        return {
          ok: true,
          text: JSON.stringify(r.object),
          object: r.object as InferObject<S>,
          durationMs: Date.now() - start,
          // Single-shot: no agentic loop, so nothing to resume from.
          stepsUsed: 0,
          tokensUsed: stepSpend(usage),
          usage,
          ...(context ? { context } : {}),
          ...(outputCap !== undefined ? { outputCap } : {}),
        };
      } catch (e) {
        if (input.signal?.aborted) throw e;
        // Recoverable without spending a repair attempt: ask again, minus the
        // param the provider just refused.
        if (shouldRetryWithoutSampling(temp, e, input.signal)) {
          temp = undefined;
          continue;
        }
        // A transport/config failure — bad key, no credits, a 400, an exhausted
        // rate-limit retry chain — is NOT a schema miss. Repairing it can't
        // help, and swallowing it reports "the model returned nothing" instead
        // of the provider's real message, which is the single most confusing way
        // for a BYOK run to fail. Let it out to the surface's catch, where the
        // error panel and the resume affordance already live. (The tool-bearing
        // path below has always thrown these; this keeps the two consistent.)
        if (isProviderFailure(e)) throw e;
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
      tokensUsed: 0,
      ...(outputCap !== undefined ? { outputCap } : {}),
    };
  }

  // --- Structured + tools, or prose: generateText --------------------------
  const steps = makeStepAccumulator(start, input);
  // Tool-less runs are a single request: no step loop to prepare, and no tool
  // results to evict.
  const prepareStep = tools
    ? buildStepPrepare(
        input.modelId,
        input.compactContext ?? CONTEXT_COMPACTION_ENABLED,
        () => steps.context,
        makeSummarizer(input),
      )
    : undefined;
  const args = (temp: number | undefined) => ({
    model,
    ...buildResumableRequest(input.modelId, system, userTurn, input.resumeMessages),
    ...(tools ? { tools, stopWhen: runStopConditions(budget) } : {}),
    ...(prepareStep ? { prepareStep } : {}),
    ...(temp !== undefined ? { temperature: temp } : {}),
    ...(input.seed !== undefined ? { seed: input.seed } : {}),
    ...(outputCap !== undefined ? { maxOutputTokens: outputCap } : {}),
    maxRetries: TASK_MAX_RETRIES,
    abortSignal: input.signal,
    onStepFinish: steps.onStepFinish,
  });
  let r: Awaited<ReturnType<typeof generateText>>;
  try {
    r = await generateText(args(temperature));
  } catch (e) {
    if (!shouldRetryWithoutSampling(temperature, e, input.signal)) throw e;
    r = await generateText(args(undefined));
  }

  const scalars = {
    ...scalarsOf(steps, budget),
    ...(outputCap !== undefined ? { outputCap } : {}),
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
        reason: budgetReason("empty", scalars),
        text: "",
        durationMs: Date.now() - start,
        ...scalars,
      };
    }
    const parsed = validateAgainstSchema(text, input.schema);
    if (!parsed.ok) {
      return {
        ok: false,
        reason: budgetReason("schema_violation", scalars),
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
  const userTurn = buildConversationTurn(input);
  const tools = input.tools ?? undefined;
  const budget = runBudgetOf(input);
  const temperature = effectiveTemperature(input);
  const outputCap = effectiveOutputCap(input);

  // streamText NEVER rejects: a provider/network failure mid-stream (429 on a
  // follow-up agentic step, overload, dropped connection) is reported via
  // `onError` and textStream simply ENDS. Without capturing it, a failed run
  // looks like the model stopping after a sentence — which the schema surfaces
  // then misreport as "the model didn't return findings in the expected
  // format". Capture the first error and rethrow it below so callers' existing
  // catch paths show the REAL provider message.
  //
  // One attempt = one full stream, drained. Each gets a fresh accumulator — and
  // therefore a fresh compaction latch — so a retried attempt can't inherit the
  // abandoned one's steps, checkpoints, or eviction state.
  const attempt = async (temp: number | undefined) => {
    const toolStart = new Map<string, number>();
    let streamError: unknown = null;
    const steps = makeStepAccumulator(start, input);
    const prepareStep = tools
      ? buildStepPrepare(
          input.modelId,
          input.compactContext ?? CONTEXT_COMPACTION_ENABLED,
          () => steps.context,
          makeSummarizer(input),
        )
      : undefined;
    const result = streamText({
      model,
      ...buildResumableRequest(input.modelId, system, userTurn, input.resumeMessages),
      ...(tools ? { tools, stopWhen: runStopConditions(budget) } : {}),
      ...(prepareStep ? { prepareStep } : {}),
      ...(temp !== undefined ? { temperature: temp } : {}),
      ...(input.seed !== undefined ? { seed: input.seed } : {}),
      ...(outputCap !== undefined ? { maxOutputTokens: outputCap } : {}),
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
    return { steps, acc, streamError };
  };

  let run = await attempt(temperature);
  // Retry only while nothing has been emitted yet — a sampling-param rejection
  // lands on the first request, so re-streaming can't duplicate the user's text.
  if (
    run.streamError != null &&
    run.acc === "" &&
    shouldRetryWithoutSampling(temperature, run.streamError, input.signal)
  ) {
    run = await attempt(undefined);
  }
  const { steps, acc, streamError } = run;

  const scalars = {
    ...scalarsOf(steps, budget),
    ...(outputCap !== undefined ? { outputCap } : {}),
  };

  // `acc` is EVERY step's text concatenated (the SDK's textStream spans the
  // whole agentic loop), but the answer is only the LAST step's text —
  // validating the concatenation let a fenced snippet from mid-run narration
  // shadow the real answer (and, with defaulted schemas, "validate" as an
  // empty batch: the generator's "produced no test cases", Commit Review's
  // false clean). Completed steps' texts are exact prefixes of `acc`, so any
  // remainder is the in-flight step that never finished — the right text to
  // salvage when the stream died mid-answer.
  //
  // There is deliberately NO `|| acc` fallback for "the last step finished with
  // no text". `stepTexts` records "" for every pure tool-call step, so that
  // fallback fired exactly when the loop ended ON a tool call — a budget stop —
  // and handed the whole-run concatenation to the validator: the shadowing bug
  // above, still reachable through the back door in the one case it was most
  // likely to bite. When no step wrote an answer the honest result is `empty`,
  // and since an empty answer after real work is now resumable, that costs the
  // user a click rather than the run.
  const completedTextLen = steps.stepTexts.reduce((n, t) => n + t.length, 0);
  const inFlightTail = acc.slice(completedTextLen);
  const lastStepText = steps.stepTexts[steps.stepTexts.length - 1] ?? "";
  const finalText = inFlightTail.trim() ? inFlightTail : lastStepText;

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
          finalText,
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
      //
      // WHAT REACHES HERE, for the next person diagnosing an empty run. A live
      // run came back empty after 22 steps and ~1.7M tokens; working backwards:
      //
      //  • `finalText` empty ⇒ the last completed step wrote no text AND no
      //    in-flight tail survived. Whether `acc` (the whole run's narration)
      //    was also empty is now irrelevant — see the `|| acc` note above.
      //  • `streamError` was null, so it was NOT a stall or a dropped socket:
      //    those take the throw path above and surface as a classified error,
      //    not as EMPTY-RESULT. The stall banner on that run explains its 15
      //    minutes, not its emptiness.
      //  • `limit` was unset (22 of 40 steps, 1.7M of 2.5M tokens), so the
      //    loop was not cut off by either guard — `budgetReason` would have
      //    said `step_cap`.
      //  • Eviction cannot produce this: it rewrites tool-result content, and
      //    at that request size it never armed in the first place.
      //
      // That leaves the provider's own reason for ending the last step, which
      // the runner has had all along and every layer above it discarded. It is
      // now carried out on the result and persisted on the outcome. `stop`
      // means the model ended its turn writing nothing; `length` means it hit
      // the output ceiling, which on a reasoning model the thinking block
      // spends too — a step of pure thinking and no text looks identical to
      // silence from here. Read it off the error panel rather than inferring
      // it again.
      return {
        ok: false,
        reason: budgetReason("empty", scalars),
        text: acc,
        finalText,
        durationMs: Date.now() - start,
        ...scalars,
      };
    }
    const parsed = validateAgainstSchema(finalText, input.schema);
    if (!parsed.ok) {
      return {
        ok: false,
        reason: budgetReason("schema_violation", scalars),
        text: finalText,
        finalText,
        durationMs: Date.now() - start,
        ...scalars,
      };
    }
    return {
      ok: true,
      text: finalText,
      finalText,
      object: parsed.value as InferObject<S>,
      durationMs: Date.now() - start,
      ...scalars,
    };
  }
  // The schema-less arm is the one where the distinction bites. A prose surface
  // gets `text` (what streamed, narration included) AND `finalText` (what the
  // last step actually wrote), because a loop that ends on a tool call — budget
  // stop or a model that simply stopped — leaves the two very different, and
  // reporting `ok: true` with only the concatenation is how a run that never
  // answered came back looking like an answer.
  return {
    ok: true,
    text: acc,
    finalText,
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

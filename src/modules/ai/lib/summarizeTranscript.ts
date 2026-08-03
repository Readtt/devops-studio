// The last resort, and deliberately hard to reach: replace the middle of a
// transcript with a written summary of it.
//
// # Why this is gated behind eviction rather than used instead of it
//
// Every other control in this plan is free — a cap removes tokens, eviction
// rewrites them, neither costs a request. Summarization ALWAYS costs an extra
// model call, so the rule is "never add a model call where a cap would do". It
// fires only when eviction has already run and freed NOTHING: every tool result
// outside the hot tail is a stub already, so there is nothing left for the cheap
// mechanism to take. What is left at that point is the model's own narration
// across dozens of steps, the arguments of every tool call it made, and the
// results too small to have been worth stubbing — none of which eviction can
// touch, and all of which a summary can.
//
// It runs on the CHEAPEST model the user has a key for, not the run's model.
// The task is compression, not reasoning, and paying frontier rates to shrink a
// transcript is how a context fix turns into a cost regression.
//
// # What it is allowed to touch
//
// Never the protected prefix — the system preamble and the initial user turn are
// the task definition, and a summary of the spec is not the spec. Never the hot
// tail either: the model is mid-thought there. Only the middle, and only at a
// cut point where every tool-call already has its matching tool-result on the
// same side of the line (Anthropic 400s on an orphaned call).
//
// # What the summary must preserve
//
// Anthropic's guidance for compaction, and the reason the prompt below reads the
// way it does: maximize RECALL first, then tighten precision. Architectural
// decisions, unresolved bugs, files touched and next steps survive; redundant
// tool output does not. A summary that is merely short is a failure — the model
// has to be able to keep working from it.

import type { ModelMessage } from "ai";
import { protectedPrefixLength } from "./compactTranscript";
import { estimateTokens } from "./contextEstimate";
import {
  getModel,
  getModelContextLimit,
  MODEL_PRICING,
  MODELS,
  type ModelId,
} from "../config";

/** Kill switch, matching {@link CONTEXT_COMPACTION_ENABLED}'s pattern: this is
 *  the one control in the phase that spends money, so it is isolated behind a
 *  single constant a bisect can flip. */
export const CONTEXT_SUMMARIZATION_ENABLED = true;

/** Opens the replacement message. Load-bearing: a transcript that already
 *  carries one is never summarized again, so a resumed run replaying a
 *  summarized transcript can't stack summaries of summaries. */
export const SUMMARY_MARKER = "[context-summary]";

/** Messages at the end kept verbatim. The model is mid-thought in the newest
 *  turn; summarizing what it just read is how a loop starts re-reading. */
export const SUMMARY_HOT_TAIL_MESSAGES = 4;

/** Below this there is nothing worth a request — the summary and its framing
 *  would cost more than the region it replaces. */
export const MIN_SUMMARIZABLE_CHARS = 8_000;

/** Per-part clip inside the rendered source. Generous: recall first. */
const SOURCE_PART_CHAR_CAP = 2_000;

/** Ceiling on the whole rendered source, so the summarizer's own request is
 *  bounded. When it bites we keep the TAIL — the recent middle is what the model
 *  is most likely to still need. */
const SOURCE_CHAR_CAP = 240_000;

/** Roughly Anthropic's "1,000–2,000 tokens back to the parent", with slack. */
export const SUMMARY_MAX_OUTPUT_TOKENS = 3_000;

export const SUMMARIZER_SYSTEM_PROMPT = `You are compacting the middle of an AI agent's working transcript so the agent can keep going in a smaller context window. You are not answering the agent's task and you are not judging its work.

Write a dense handover note for the agent, addressed to it, covering everything it would otherwise have to re-derive:

1. DECISIONS AND CONCLUSIONS it reached, and the reasoning that got there.
2. UNRESOLVED problems, contradictions, and open questions — anything it noticed but did not finish.
3. FILES AND SYMBOLS it read, with paths, and the specific facts it learned from each (signatures, shapes, line ranges, call sites). Paths must be exact.
4. WHAT IT WAS DOING NEXT — the step it was mid-way through when this cut off.
5. Anything the user asked for that has not been handled yet.

Maximize RECALL first: it is far worse to drop a fact the agent still needs than to be a few hundred words longer than necessary. Then tighten — cut redundant tool output, repeated file contents, restatements, and narration that led nowhere.

Rules:
- Be concrete. "Checked the auth module" is useless; "src/auth/session.ts:40-88 — refreshToken() returns null on expiry, callers in src/api/client.ts:120 don't handle it" is the job.
- Never invent. If something was uncertain in the transcript, say it was uncertain.
- No preamble, no sign-off, no markdown headings above level 3. Prose and short lists only.`;

export type SummarizationPlan = {
  /** Messages kept untouched at the front. */
  protectedCount: number;
  /** Exclusive end of the replaced region — also the offset a later step slices
   *  the (rebuilt, still-full) history at to re-apply the summary. */
  cutIndex: number;
  /** Rendered transcript region handed to the summarizer. */
  source: string;
  /** Tokens the summarizer's request will carry, for picking a model whose
   *  window can hold it. */
  sourceTokens: number;
};

/** Decide what to summarize. Pure and deterministic; returns null whenever
 *  summarizing would be pointless, unsafe, or already done. */
export function planSummarization(
  messages: ModelMessage[],
  options: { hotTail?: number; minChars?: number } = {},
): SummarizationPlan | null {
  const hotTail = options.hotTail ?? SUMMARY_HOT_TAIL_MESSAGES;
  const minChars = options.minChars ?? MIN_SUMMARIZABLE_CHARS;
  const protectedCount = protectedPrefixLength(messages);
  if (alreadySummarized(messages, protectedCount)) return null;

  const maxCut = messages.length - hotTail;
  if (maxCut <= protectedCount) return null;

  const cutIndex = safeCutIndex(messages, protectedCount, maxCut);
  if (cutIndex <= protectedCount) return null;

  const source = renderRegion(messages, protectedCount, cutIndex);
  if (source.length < minChars) return null;
  return {
    protectedCount,
    cutIndex,
    source,
    sourceTokens: estimateTokens(source),
  };
}

/** Splice the summary in. Pure: neither the array nor its messages are mutated.
 *  Re-applied on every later step against the SDK's freshly rebuilt history,
 *  which is why the plan carries an index rather than a message reference. */
export function applySummary(
  messages: ModelMessage[],
  plan: SummarizationPlan,
  summaryText: string,
): ModelMessage[] {
  return [
    ...messages.slice(0, plan.protectedCount),
    summaryMessage(summaryText),
    ...messages.slice(plan.cutIndex),
  ];
}

/** The replacement turn.
 *
 *  `user`, not `assistant`, for two reasons. It is the harness speaking, not the
 *  model — the same voice `FINISH_NOW_NUDGE` uses. And the message after the cut
 *  is always an assistant turn, so an assistant summary would put two assistant
 *  turns back to back; a user one merges cleanly into the preceding user block
 *  on every provider. */
export function summaryMessage(summaryText: string): ModelMessage {
  return {
    role: "user",
    content:
      `${SUMMARY_MARKER} The earlier part of this conversation was replaced with the summary below to fit the ` +
      `context window. The original messages are gone and re-reading the conversation will not bring them back — ` +
      `work from this summary, and use your tools to re-read anything it doesn't cover.\n\n${summaryText}`,
  };
}

/** Whether the transcript already carries a summary in the slot one would go. */
function alreadySummarized(
  messages: ModelMessage[],
  protectedCount: number,
): boolean {
  const m = messages[protectedCount];
  if (!m || m.role !== "user") return false;
  const c = m.content;
  if (typeof c === "string") return c.startsWith(SUMMARY_MARKER);
  return (
    Array.isArray(c) &&
    c.some(
      (p) =>
        (p as { type?: string; text?: string }).type === "text" &&
        typeof (p as { text?: string }).text === "string" &&
        (p as { text: string }).text.startsWith(SUMMARY_MARKER),
    )
  );
}

type AnyPart = { type?: unknown; [key: string]: unknown };

function partsOf(m: ModelMessage | undefined): AnyPart[] | null {
  const content = (m as { content?: unknown } | undefined)?.content;
  return Array.isArray(content) ? (content as AnyPart[]) : null;
}

/** The largest cut ≤ `maxCut` that leaves no tool-call without its result.
 *
 *  Anthropic rejects a request whose assistant turn calls a tool that never gets
 *  answered, so the boundary can't fall anywhere convenient — it has to land
 *  where the ledger balances. Walks forward tracking outstanding call ids and
 *  records every index at which the set empties. */
export function safeCutIndex(
  messages: ModelMessage[],
  from: number,
  maxCut: number,
): number {
  const pending = new Set<string>();
  let best = from;
  for (let i = 0; i < Math.min(maxCut, messages.length); i++) {
    const parts = partsOf(messages[i]);
    if (parts) {
      for (const p of parts) {
        const id = String((p as { toolCallId?: unknown }).toolCallId ?? "");
        if (p?.type === "tool-call" && id) pending.add(id);
        else if (p?.type === "tool-result" && id) pending.delete(id);
      }
    }
    if (pending.size === 0 && i + 1 > from) best = i + 1;
  }
  return best;
}

/** Flatten a slice of the transcript into something a model can read. Tool
 *  results are clipped per part so one fat result can't crowd out the reasoning
 *  around it; the whole thing is clipped from the FRONT if it still runs long,
 *  because the recent middle is what the agent is most likely to still need. */
export function renderRegion(
  messages: ModelMessage[],
  from: number,
  to: number,
): string {
  const out: string[] = [];
  for (let i = from; i < to; i++) {
    const m = messages[i];
    if (!m) continue;
    const parts = partsOf(m);
    if (!parts) {
      const text = typeof m.content === "string" ? m.content : "";
      if (text.trim()) out.push(`${roleLabel(m.role)}: ${clip(text)}`);
      continue;
    }
    for (const p of parts) {
      switch (p?.type) {
        case "text": {
          const t = String((p as { text?: unknown }).text ?? "");
          if (t.trim()) out.push(`${roleLabel(m.role)}: ${clip(t)}`);
          break;
        }
        case "tool-call":
          out.push(
            `→ called ${String((p as { toolName?: unknown }).toolName ?? "tool")}(${clip(
              stableString((p as { input?: unknown }).input),
            )})`,
          );
          break;
        case "tool-result":
          out.push(
            `← ${String((p as { toolName?: unknown }).toolName ?? "tool")} returned: ${clip(
              renderOutput((p as { output?: unknown }).output),
            )}`,
          );
          break;
        default:
          break;
      }
    }
  }
  const joined = out.join("\n");
  if (joined.length <= SOURCE_CHAR_CAP) return joined;
  return `…[${joined.length - SOURCE_CHAR_CAP} earlier characters omitted]…\n${joined.slice(-SOURCE_CHAR_CAP)}`;
}

function roleLabel(role: string): string {
  return role === "assistant" ? "assistant" : role === "user" ? "user" : role;
}

function clip(s: string): string {
  if (s.length <= SOURCE_PART_CHAR_CAP) return s;
  return `${s.slice(0, SOURCE_PART_CHAR_CAP)}…[+${s.length - SOURCE_PART_CHAR_CAP} chars]`;
}

function renderOutput(output: unknown): string {
  const o = output as { type?: unknown; value?: unknown } | null | undefined;
  if (!o || typeof o !== "object") return stableString(output);
  if (typeof o.value === "string") return o.value;
  return stableString(o.value ?? o);
}

function stableString(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/** Cheapest model that can actually do this job right now.
 *
 *  Three filters, in order of how badly getting them wrong hurts:
 *
 *   • The user must have a key for its provider. A summarizer that 401s turns a
 *     recoverable run into a failed one.
 *   • It must have published pricing. That excludes the local/custom endpoints,
 *     which is deliberate rather than a side effect — they're free, but "is LM
 *     Studio running right now" is not a question worth betting the run on.
 *   • Its window must hold the source with room to answer.
 *
 *  Falls back to the run's own model, which is always usable by construction. */
export function pickSummarizerModel(
  runModelId: ModelId,
  keys: Partial<Record<string, string | null>>,
  sourceTokens: number,
): ModelId {
  const needed = Math.ceil(sourceTokens * 1.3) + SUMMARY_MAX_OUTPUT_TOKENS + 2_000;
  let best: { id: ModelId; price: number } | null = null;
  for (const m of MODELS) {
    const price = MODEL_PRICING[m.id]?.input;
    if (typeof price !== "number") continue;
    if (!keys[m.provider]) continue;
    // Summarizing a technical transcript badly is worse than not summarizing:
    // the tier below this reliably drops file paths and line numbers.
    if (m.capabilities.intelligence < 3) continue;
    if (getModelContextLimit(m.id) < needed) continue;
    if (!best || price < best.price) best = { id: m.id as ModelId, price };
  }
  if (!best) return runModelId;
  // A tie with the run's own model isn't a tie — reusing it keeps the request on
  // a provider we already know is answering.
  const runPrice = MODEL_PRICING[runModelId]?.input;
  if (typeof runPrice === "number" && runPrice <= best.price) return runModelId;
  return best.id;
}

/** Label for the activity log / debugging. */
export function summarizerLabel(id: ModelId): string {
  try {
    return getModel(id).label;
  } catch {
    return id;
  }
}

// Tool-result eviction for long agentic runs — what Anthropic calls "the safest,
// lightest-touch compaction method". Phase 1 capped what any single tool result
// can be; this bounds what ALL of them add up to once a run gets long.
//
// It rewrites heavy tool-result CONTENT in place and never removes a part, so
// every `tool-call` keeps its matching `tool-result` (Anthropic 400s on an
// orphan) and the model keeps the record that it made the call. That is the one
// reason this is hand-rolled instead of the SDK's `pruneMessages`, which deletes
// the call and the result as a matched pair: the model loses all memory of
// having read the file and reads it again.
//
// # Why this function must be pure, idempotent and deterministic
//
// Verified in `ai@6.0.168`: `prepareStep`'s `messages` override applies to ONE
// request and is never written back — both generateText and streamText rebuild
// `stepInputMessages = [...initialMessages, ...responseMessages]` from their own
// pristine copies every iteration. So this runs over the FULL history on every
// step, and byte-identical input must produce byte-identical output.
//
// That is not a nicety, it is the difference between saving money and burning
// it. Anthropic prompt caching (already shipped, ~10x on input) hits only while
// the request PREFIX stays byte-identical. A sliding rule like the AI SDK
// cookbook's `toolCalls: 'before-last-3-messages'` moves the boundary by one
// message every step, rewrites the prefix every step, and invalidates the cache
// every step: the token count improves while the bill doubles.
//
// # The rule: Gemini CLI's "Reverse Token Budget"
//
// (`packages/core/src/context/chatCompressionService.ts`, `truncateHistoryToBudget`
// — production code, not theory.) Walk the history NEWEST → OLDEST tallying
// tool-result tokens against a fixed budget; keep the recent ones verbatim; once
// the tally is blown, that turn and everything older is evicted. The hot tail
// sizes itself, and — because appending only ever makes the tail heavier — the
// boundary advances MONOTONICALLY. The prefix therefore stays byte-identical
// between steps except on the steps where the boundary genuinely moves.
//
// Two adaptations from Gemini CLI:
//
//   • Their stubs are counter-named (`getNextCompressionTruncationId()`). They
//     get away with it because they compact ONCE; we recompute every step, and a
//     counter would emit different bytes on every re-run — exactly the cache
//     invalidation above. Ours are CONTENT-ADDRESSED: the id is a hash of the
//     evicted content, so a given result always stubs to the same bytes.
//   • They spill the dropped output to a temp file and leave the path in
//     context. This app is read-only against the user's machine, and every tool
//     that produces a big result is re-callable, so the stub carries the exact
//     tool call that would fetch it back instead. An evicted result the model
//     can re-fetch is a cache miss; one it cannot is lost information.

import type { ModelMessage } from "ai";
import { estimateTokens } from "./contextEstimate";

/** Tokens of tool-result content kept verbatim before older turns are evicted.
 *  Gemini CLI's `COMPRESSION_FUNCTION_RESPONSE_TOKEN_BUDGET`. It is a budget for
 *  tool results specifically, NOT for the whole transcript — the spec, the
 *  attachments and the model's own reasoning are never counted against it. */
export const TOOL_RESULT_TOKEN_BUDGET = 50_000;

/** Below this, evicting frees less than the stub costs. Small results also tend
 *  to be the load-bearing ones (a git sha, an error string, a line count). */
export const MIN_EVICTABLE_CHARS = 1_000;

/** Kill switch, defaulted ON. Eviction is the one change in this phase that can
 *  alter what the model sees, so it is isolated behind a single constant: flip
 *  this to `false` and a quality report can be attributed to eviction
 *  specifically rather than to the whole release. Per-call override lives on
 *  `TaskInput.compactContext`. */
export const CONTEXT_COMPACTION_ENABLED = true;

/** Leading marker on every stub. Load-bearing twice over: it is how a re-run
 *  recognises its own output (a stub of a stub would hash differently and break
 *  idempotence), and it is what makes the eviction legible in a transcript dump. */
export const EVICTION_STUB_MARKER = "[evicted-tool-result #";

/** Longest tool-call arguments rendered into a stub's recovery line. Clipped so
 *  a tool called with a huge inline argument can't make its own stub oversized. */
const RECOVERY_ARGS_CAP = 300;

export type CompactionResult = {
  /** The compacted transcript. The SAME array reference as the input when
   *  nothing was evicted, so callers can skip the override entirely — which
   *  keeps a run that never trips the budget byte-identical to today. */
  messages: ModelMessage[];
  /** Tool results replaced by a stub. */
  evictedCount: number;
  /** Characters of tool-result content removed (before the stubs' own cost). */
  freedChars: number;
  /** Tokens of tool-result content kept verbatim in the hot tail. */
  keptToolResultTokens: number;
};

export type CompactionOptions = {
  /** Override {@link TOOL_RESULT_TOKEN_BUDGET}. Tests use it; production doesn't. */
  toolResultTokenBudget?: number;
  /** Override {@link MIN_EVICTABLE_CHARS}. Tests use it; production doesn't. */
  minEvictableChars?: number;
};

/** Evict old tool-result content down to a fixed budget. Pure: the input array
 *  and its messages are never mutated. */
export function compactTranscript(
  messages: ModelMessage[],
  options: CompactionOptions = {},
): CompactionResult {
  const budget = options.toolResultTokenBudget ?? TOOL_RESULT_TOKEN_BUDGET;
  const minChars = options.minEvictableChars ?? MIN_EVICTABLE_CHARS;
  const protectedCount = protectedPrefixLength(messages);
  const units = collectToolResults(messages, protectedCount, minChars);
  if (units.length === 0) return unchanged(messages, 0);

  // One group per message: the parallel tool calls of a single turn are kept or
  // evicted together. Splitting a turn would hand the model a half-remembered
  // fan-out, and a coarser boundary is a more stable prefix.
  const groups: Unit[][] = [];
  for (const u of units) {
    const last = groups[groups.length - 1];
    if (last && last[0].msgIndex === u.msgIndex) last.push(u);
    else groups.push([u]);
  }
  groups.reverse(); // newest turn first

  const doomed = new Set<Unit>();
  let keptTokens = 0;
  let over = false;
  groups.forEach((group, i) => {
    const tokens = group.reduce((n, u) => n + u.tokens, 0);
    // The newest turn is kept whatever it costs. Stubbing a result the model
    // received one step ago just makes it call the same tool again, forever.
    if (!over && (i === 0 || keptTokens + tokens <= budget)) {
      keptTokens += tokens;
      return;
    }
    over = true;
    for (const u of group) if (u.evictable) doomed.add(u);
  });

  if (doomed.size === 0) return unchanged(messages, keptTokens);

  const callsById = indexToolCalls(messages);
  const byMessage = new Map<number, Map<number, Unit>>();
  for (const u of doomed) {
    const forMsg = byMessage.get(u.msgIndex) ?? new Map<number, Unit>();
    forMsg.set(u.partIndex, u);
    byMessage.set(u.msgIndex, forMsg);
  }

  let freedChars = 0;
  const out = messages.map((m, i) => {
    const targets = byMessage.get(i);
    if (!targets) return m;
    const parts = partsOf(m);
    if (!parts) return m;
    const nextParts = parts.map((p, pi) => {
      const u = targets.get(pi);
      if (!u) return p;
      freedChars += u.chars;
      return {
        ...p,
        output: {
          type: "text" as const,
          value: buildStub(u, callsById.get(u.toolCallId)),
        },
      };
    });
    return { ...m, content: nextParts } as ModelMessage;
  });

  return {
    messages: out,
    evictedCount: doomed.size,
    freedChars,
    keptToolResultTokens: keptTokens,
  };
}

/** Whether a tool-result output value is one of our stubs. Exported so callers
 *  (and tests) can tell an evicted result from a real one. */
export function isEvictionStub(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(EVICTION_STUB_MARKER);
}

// --- internals --------------------------------------------------------------

type AnyPart = { type?: unknown; [key: string]: unknown };

type Unit = {
  msgIndex: number;
  partIndex: number;
  toolCallId: string;
  toolName: string;
  /** Deterministic rendering of the output — what gets measured and hashed. */
  rendered: string;
  chars: number;
  tokens: number;
  /** Big enough to be worth stubbing, and not already a stub. Non-evictable
   *  units still count against the budget: they occupy the window either way. */
  evictable: boolean;
};

function unchanged(messages: ModelMessage[], keptTokens: number): CompactionResult {
  return {
    messages,
    evictedCount: 0,
    freedChars: 0,
    keptToolResultTokens: keptTokens,
  };
}

/** Messages that are off limits: the system preamble plus the initial user turn.
 *  That turn IS the task — the spec, the attachments, the requirement block —
 *  and losing it is unrecoverable in a way losing a grep result is not. The
 *  floor of 1 also covers a degenerate transcript that opens with something
 *  else: whatever leads, it is the oldest context we have and the least safe
 *  thing to throw away. */
export function protectedPrefixLength(messages: ModelMessage[]): number {
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === "user") return i + 1;
    if (messages[i]?.role !== "system") break;
  }
  return Math.min(1, messages.length);
}

function partsOf(m: ModelMessage | undefined): AnyPart[] | null {
  const content = (m as { content?: unknown } | undefined)?.content;
  return Array.isArray(content) ? (content as AnyPart[]) : null;
}

/** Every tool-result part outside the protected prefix, oldest first. */
function collectToolResults(
  messages: ModelMessage[],
  protectedCount: number,
  minEvictableChars: number,
): Unit[] {
  const units: Unit[] = [];
  for (let i = protectedCount; i < messages.length; i++) {
    const parts = partsOf(messages[i]);
    if (!parts) continue;
    for (let p = 0; p < parts.length; p++) {
      const part = parts[p];
      if (part?.type !== "tool-result") continue;
      const rendered = renderOutput(part.output);
      if (rendered === null) continue; // no payload (execution-denied)
      units.push({
        msgIndex: i,
        partIndex: p,
        toolCallId: String(part.toolCallId ?? ""),
        toolName: String(part.toolName ?? "tool"),
        rendered,
        chars: rendered.length,
        tokens: estimateTokens(rendered),
        evictable:
          rendered.length >= minEvictableChars &&
          // A stub of a stub would hash differently every pass and break
          // idempotence — the property the whole prompt cache rests on.
          !isEvictionStub(outputValue(part.output)),
      });
    }
  }
  return units;
}

function outputValue(output: unknown): unknown {
  return (output as { value?: unknown } | null | undefined)?.value;
}

/** Deterministic string form of a tool-result output, used for BOTH the size
 *  tally and the content hash. Returns null for outputs that carry no payload,
 *  which are never worth evicting. */
function renderOutput(output: unknown): string | null {
  const o = output as { type?: unknown; value?: unknown } | null | undefined;
  if (!o || typeof o !== "object") return output == null ? null : stableString(output);
  switch (o.type) {
    case "text":
    case "error-text":
      return typeof o.value === "string" ? o.value : stableString(o.value);
    case "json":
    case "error-json":
      return stableString(o.value);
    case "content":
      return stableString(o.value);
    case "execution-denied":
      return null;
    default:
      return stableString(o);
  }
}

function stableString(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/** toolCallId → the call that produced the result, so a stub can name the exact
 *  arguments that would fetch it again. */
function indexToolCalls(
  messages: ModelMessage[],
): Map<string, { toolName: string; input: unknown }> {
  const map = new Map<string, { toolName: string; input: unknown }>();
  for (const m of messages) {
    const parts = partsOf(m);
    if (!parts) continue;
    for (const p of parts) {
      if (p?.type !== "tool-call") continue;
      const id = String(p.toolCallId ?? "");
      if (id) map.set(id, { toolName: String(p.toolName ?? "tool"), input: p.input });
    }
  }
  return map;
}

/** The replacement text. Every component is a pure function of the evicted
 *  content and the call that produced it — no counters, no timestamps, no
 *  position — so re-running over the same history emits the same bytes. */
function buildStub(
  unit: Unit,
  call: { toolName: string; input: unknown } | undefined,
): string {
  const name = call?.toolName || unit.toolName;
  const args = renderArgs(call?.input);
  const recovery = args
    ? `To get it back, call \`${name}\` again with these arguments: ${args}`
    : `To get it back, call \`${name}\` again with the same arguments.`;
  return (
    `${EVICTION_STUB_MARKER}${contentHash(unit.rendered)}] ` +
    `${unit.chars} characters of \`${name}\` output were dropped here to keep this ` +
    `conversation inside the model's context window. That content is gone and cannot ` +
    `be recovered by re-reading the conversation. ${recovery}`
  );
}

function renderArgs(input: unknown): string | null {
  if (input == null) return null;
  const json = stableString(input);
  if (!json || json === "{}" || json === '""') return null;
  return json.length <= RECOVERY_ARGS_CAP
    ? json
    : `${json.slice(0, RECOVERY_ARGS_CAP)}…(${json.length - RECOVERY_ARGS_CAP} more chars)`;
}

/** FNV-1a, 32-bit. A hash, not a checksum: it only has to be stable and cheap.
 *  `crypto.subtle.digest` is async and would force this whole function to be,
 *  which `prepareStep` would then have to await on every step. */
function contentHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

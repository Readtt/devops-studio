// "It read for twelve steps and never answered" — the recovery, shared by both
// prose chat surfaces (the generator's review-pane Ask and Suite Chat).
//
// An agentic loop that ends on a tool call leaves the user looking at mid-run
// narration ("I'll dig into the collect/migrate code…") presented as the reply.
// The reading is bought and paid for; one more pass over what it already read
// turns that into an answer.
//
// This lives here rather than inside either surface because the first version
// shipped to ONE of them. The other kept returning `text` — every step's
// narration concatenated — with no check that the last step wrote anything, so
// the same reported bug stayed live on the sibling pane. Two surfaces, one
// implementation.

import type { ModelMessage } from "ai";
import { FINISH_NOW_NUDGE } from "./checkpointApi";

/** Whether a transcript can be replayed to the provider without a 400.
 *
 *  Anthropic requires every `tool-call` to be answered by a `tool-result` in
 *  the same conversation. A turn the user cancelled mid-tool ends on an
 *  unanswered call, so the transcript is cut at the first one — the reads
 *  before it are still worth carrying, and the dangling call is worth nothing
 *  to anyone. A completed turn is always balanced and passes through whole. */
export function sanitizeTranscript(messages: ModelMessage[]): ModelMessage[] {
  const parts = (content: unknown): { type?: string; toolCallId?: string }[] =>
    Array.isArray(content) ? (content as { type?: string; toolCallId?: string }[]) : [];

  const answered = new Set<string>();
  for (const m of messages) {
    if (m.role !== "tool") continue;
    for (const p of parts(m.content)) {
      if (p.type === "tool-result" && p.toolCallId) answered.add(p.toolCallId);
    }
  }

  let safeEnd = 0;
  let dangling = false;
  messages.forEach((m, i) => {
    if (m.role === "assistant") {
      for (const p of parts(m.content)) {
        if (p.type === "tool-call" && p.toolCallId && !answered.has(p.toolCallId)) {
          dangling = true;
        }
      }
    }
    if (!dangling) safeEnd = i + 1;
  });
  return safeEnd === messages.length ? messages : messages.slice(0, safeEnd);
}

/** Whether the turn actually read anything. A tool-less turn that returned
 *  nothing has nothing to finish FROM, so it stays empty rather than paying for
 *  a second call to re-ask the same question with the same context. */
export function hasToolResult(messages: ModelMessage[]): boolean {
  return messages.some(
    (m) =>
      m.role === "tool" &&
      Array.isArray(m.content) &&
      m.content.some((p) => (p as { type?: string }).type === "tool-result"),
  );
}

/** The slice of a runner result this decision reads. Structural so it accepts
 *  both the success and failure arms of `TaskResult` without narrowing. */
export type FinishPassSubject = {
  ok: boolean;
  text: string;
  finalText?: string;
};

/** Whether the turn ended with an actual answer.
 *
 *  `text` is every step's narration concatenated; `finalText` is what the last
 *  step wrote. They differ exactly when the loop ended on a tool call, and
 *  reading only `text` there is how a run that never answered came back looking
 *  like an answer. `finalText` lives on the success arm only — a schema-less
 *  stream can't return the failure arm — so the fallback is for the type
 *  checker, and it fails safe: an unexpected failure keeps whatever text it
 *  carried rather than buying a second call to explain it. */
export function answeredThisTurn(r: FinishPassSubject): boolean {
  return (r.ok ? (r.finalText ?? r.text) : r.text).trim().length > 0;
}

/** The continuation the finish pass replays: everything the loop read, then the
 *  harness telling it to stop reading and answer.
 *
 *  The caller MUST still pass its tools along with this. Dropping them is the
 *  obvious reading of a "tool-less finish pass" and it builds a request
 *  Anthropic rejects outright: this transcript is full of
 *  `tool_use`/`tool_result` blocks by construction (that is what
 *  `hasToolResult` gated on), and those are a 400 without a `tools` field to
 *  answer to.
 *
 *  The nudge is therefore the whole mechanism, and it has to be — `toolChoice:
 *  "none"` cannot do the job. Anthropic's API supports that value, but
 *  `@ai-sdk/anthropic` implements it by returning `{ tools: undefined,
 *  toolChoice: undefined }` (verified in the installed version), i.e. by
 *  stripping the tool definitions: on the default provider it rebuilds the
 *  exact invalid request this function exists to avoid. OpenAI and
 *  openai-compatible keep the tools and forward `tool_choice: "none"`, so the
 *  parameter is a per-provider trap rather than a guarantee.
 *
 *  A model that ignores the nudge and reads more is bounded the way the
 *  generator's resume path bounds the same replay: by the token top-up, not by
 *  a parameter. */
export function finishPassMessages(replay: ModelMessage[]): ModelMessage[] {
  return [...replay, { role: "user", content: FINISH_NOW_NUDGE }];
}

/** Strip the harness's nudge back out of a transcript before BANKING it.
 *
 *  A checkpoint's messages are `[...resumeMessages, ...whatever this call
 *  added]`, so a finish pass banks its own nudge along with the answer. On a
 *  surface that persists the transcript and replays it as conversation history,
 *  that turns a one-off instruction into a standing one: every later question in
 *  the thread arrives behind a prior USER turn reading "You have exhausted your
 *  investigation budget. Do not call any more tools." The model then answers
 *  from memory instead of reading the code, for the rest of the conversation. */
export function withoutFinishNudge(messages: ModelMessage[]): ModelMessage[] {
  const kept = messages.filter(
    (m) => !(m.role === "user" && m.content === FINISH_NOW_NUDGE),
  );
  return kept.length === messages.length ? messages : kept;
}

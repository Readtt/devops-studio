import { describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "ai";

// checkpointApi reaches for the Tauri IPC bridge at import time; nothing here
// calls it, but the module still has to load.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import {
  RESUME_TOPUP_TOKENS,
  SURFACE_STEP_CAPS,
  SURFACE_TOKEN_BUDGETS,
} from "@/modules/ai/config";
import { FINISH_NOW_NUDGE } from "@/modules/ai/lib/checkpointApi";
import { resumeBudget, sumUsage } from "./resumePolicy";

const messages: ModelMessage[] = [
  { role: "assistant", content: "I read the auth module." },
];

describe("resumeBudget", () => {
  it("grants the full cap and the prior transcript after a mid-loop failure", () => {
    const out = resumeBudget({
      lastOutcome: { at: "2026-01-01T00:00:00.000Z", kind: "error" },
      transcript: { messages, stepsUsed: 6, usage: {} },
    });
    expect(out.cap).toBe(SURFACE_STEP_CAPS.generator);
    expect(out.tokens).toBe(SURFACE_TOKEN_BUDGETS.generator);
    expect(out.resumeMessages).toEqual(messages);
  });

  // What gets topped up is TOKENS. The step ceiling goes back to the full
  // surface cap because it is a runaway guard, not a ration — cutting it to a
  // top-up starved a model that only needed a few cheap turns to write out an
  // answer it had already investigated.
  it("tops up tokens (not steps) plus a finish-now turn after a budget stop", () => {
    const out = resumeBudget({
      lastOutcome: { at: "2026-01-01T00:00:00.000Z", kind: "step_cap" },
      transcript: { messages, stepsUsed: 24, usage: {} },
    });
    expect(out.tokens).toBe(RESUME_TOPUP_TOKENS);
    expect(out.tokens).toBeLessThan(SURFACE_TOKEN_BUDGETS.generator);
    expect(out.cap).toBe(SURFACE_STEP_CAPS.generator);
    expect(out.resumeMessages).toEqual([
      ...messages,
      { role: "user", content: FINISH_NOW_NUDGE },
    ]);
  });

  it("still nudges when the budget-stopped run has no usable transcript", () => {
    const out = resumeBudget({
      lastOutcome: { at: "2026-01-01T00:00:00.000Z", kind: "step_cap" },
      transcript: null,
    });
    expect(out.tokens).toBe(RESUME_TOPUP_TOKENS);
    expect(out.resumeMessages).toEqual([
      { role: "user", content: FINISH_NOW_NUDGE },
    ]);
  });

  it("sends no continuation transcript when there is none to send", () => {
    const out = resumeBudget({ lastOutcome: null, transcript: null });
    expect(out.cap).toBe(SURFACE_STEP_CAPS.generator);
    expect(out.tokens).toBe(SURFACE_TOKEN_BUDGETS.generator);
    expect(out.resumeMessages).toBeUndefined();
  });
});

/** A transcript whose bulk is tool-result content, the way a long agentic run's
 *  is. `turns` × ~`perTurn` chars of evictable payload. */
function fatTranscript(turns: number, perTurn: number): ModelMessage[] {
  const out: ModelMessage[] = [{ role: "assistant", content: "investigating" }];
  for (let i = 0; i < turns; i++) {
    out.push({
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: `c${i}`,
          toolName: "read_file",
          input: { path: `src/f${i}.ts` },
        },
      ],
    } as ModelMessage);
    out.push({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: `c${i}`,
          toolName: "read_file",
          output: { type: "text", value: `${i}`.repeat(perTurn) },
        },
      ],
    } as ModelMessage);
  }
  return out;
}

const size = (m: ModelMessage[] | undefined) => JSON.stringify(m ?? []).length;

// This is what makes flipping the context-overflow gate honest. Resume used to
// replay the transcript verbatim, so a resumed request was a strict SUPERSET of
// the one that had just failed to fit — which is exactly why overflow was the
// one non-resumable kind. Compacting first inverts that.
describe("resumeBudget — compacting replay", () => {
  it("returns a transcript strictly smaller than its input after an overflow", () => {
    const messages = fatTranscript(12, 40_000);
    const out = resumeBudget({
      lastOutcome: {
        at: "2026-01-01T00:00:00.000Z",
        kind: "error",
        errorKind: "context-overflow",
      },
      transcript: { messages, stepsUsed: 24, usage: {} },
    });

    expect(size(out.resumeMessages)).toBeLessThan(size(messages));
    // Smaller by eviction, not by amputation: every message survives, so every
    // tool-call keeps the tool-result Anthropic 400s without.
    expect(out.resumeMessages).toHaveLength(messages.length);
    expect(JSON.stringify(out.resumeMessages)).toContain(
      "[evicted-tool-result #",
    );
  });

  it("re-classifies from the message when errorKind wasn't recorded", () => {
    const messages = fatTranscript(12, 40_000);
    const out = resumeBudget({
      lastOutcome: {
        at: "2026-01-01T00:00:00.000Z",
        kind: "error",
        message: "prompt is too long: 1050000 tokens > 1000000 maximum",
      },
      transcript: { messages, stepsUsed: 24, usage: {} },
    });
    expect(size(out.resumeMessages)).toBeLessThan(size(messages));
  });

  // The other half of the contract, and the reason the budget isn't just
  // "always squeeze": a rate limit or a dropped socket left a transcript that
  // FIT. Evicting out of it would degrade a resume that was going to work.
  it("is a no-op for a healthy transcript resumed after a rate limit", () => {
    const messages = fatTranscript(4, 30_000); // ~30k tokens, under the live budget
    const out = resumeBudget({
      lastOutcome: {
        at: "2026-01-01T00:00:00.000Z",
        kind: "error",
        errorKind: "rate-limit",
      },
      transcript: { messages, stepsUsed: 6, usage: {} },
    });
    expect(out.resumeMessages).toEqual(messages);
  });

  it("compacts under the step-cap branch too, ahead of the finish-now nudge", () => {
    const messages = fatTranscript(12, 40_000);
    const out = resumeBudget({
      lastOutcome: {
        at: "2026-01-01T00:00:00.000Z",
        kind: "error",
        errorKind: "context-overflow",
      },
      transcript: { messages, stepsUsed: 24, usage: {} },
    });
    const capped = resumeBudget({
      lastOutcome: { at: "2026-01-01T00:00:00.000Z", kind: "step_cap" },
      transcript: { messages, stepsUsed: 24, usage: {} },
    });
    expect(capped.tokens).toBe(RESUME_TOPUP_TOKENS);
    const tail = capped.resumeMessages ?? [];
    expect(tail[tail.length - 1]).toEqual({
      role: "user",
      content: FINISH_NOW_NUDGE,
    });
    // A step cap isn't an overflow, so it replays at the live budget — bigger
    // than the overflow squeeze, and still bounded.
    expect(size(capped.resumeMessages)).toBeGreaterThan(size(out.resumeMessages));
  });
});

describe("sumUsage", () => {
  it("adds the fields both sides reported", () => {
    expect(
      sumUsage(
        { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
        { inputTokens: 5, outputTokens: 1, totalTokens: 6, cacheReadTokens: 9 },
      ),
    ).toEqual({
      inputTokens: 15,
      outputTokens: 5,
      totalTokens: 20,
      cacheReadTokens: 9,
    });
  });

  it("leaves a field neither side reported absent rather than 0", () => {
    expect(sumUsage({ inputTokens: 3 }, { inputTokens: 2 })).toEqual({
      inputTokens: 5,
    });
  });

  it("treats a non-finite count as absent so the total never goes NaN", () => {
    const poisoned = {
      inputTokens: NaN,
      outputTokens: Infinity,
      totalTokens: null as unknown as number,
    };
    expect(sumUsage(poisoned, { inputTokens: 7, totalTokens: 7 })).toEqual({
      inputTokens: 7,
      totalTokens: 7,
    });
  });

  it("handles either side being undefined", () => {
    expect(sumUsage(undefined, { totalTokens: 12 })).toEqual({ totalTokens: 12 });
    expect(sumUsage({ totalTokens: 12 }, undefined)).toEqual({ totalTokens: 12 });
    expect(sumUsage(undefined, undefined)).toEqual({});
  });
});

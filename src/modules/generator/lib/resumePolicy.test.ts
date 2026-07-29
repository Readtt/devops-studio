import { describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "ai";

// checkpointApi reaches for the Tauri IPC bridge at import time; nothing here
// calls it, but the module still has to load.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { RESUME_TOPUP_STEPS, SURFACE_STEP_CAPS } from "@/modules/ai/config";
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
    expect(out.resumeMessages).toEqual(messages);
  });

  it("grants only a top-up plus a finish-now turn after a step cap", () => {
    const out = resumeBudget({
      lastOutcome: { at: "2026-01-01T00:00:00.000Z", kind: "step_cap" },
      transcript: { messages, stepsUsed: 24, usage: {} },
    });
    expect(out.cap).toBe(RESUME_TOPUP_STEPS);
    expect(out.resumeMessages).toEqual([
      ...messages,
      { role: "user", content: FINISH_NOW_NUDGE },
    ]);
  });

  it("still nudges when the step-capped run has no usable transcript", () => {
    const out = resumeBudget({
      lastOutcome: { at: "2026-01-01T00:00:00.000Z", kind: "step_cap" },
      transcript: null,
    });
    expect(out.cap).toBe(RESUME_TOPUP_STEPS);
    expect(out.resumeMessages).toEqual([
      { role: "user", content: FINISH_NOW_NUDGE },
    ]);
  });

  it("sends no continuation transcript when there is none to send", () => {
    const out = resumeBudget({ lastOutcome: null, transcript: null });
    expect(out.cap).toBe(SURFACE_STEP_CAPS.generator);
    expect(out.resumeMessages).toBeUndefined();
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

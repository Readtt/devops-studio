import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import {
  applySummary,
  pickSummarizerModel,
  planSummarization,
  safeCutIndex,
  summaryMessage,
  SUMMARY_MARKER,
} from "./summarizeTranscript";
import { EVICTION_STUB_MARKER } from "./compactTranscript";

const user = (text: string): ModelMessage => ({ role: "user", content: text });
const say = (text: string): ModelMessage => ({
  role: "assistant",
  content: text,
});
const call = (id: string, name = "read_file"): ModelMessage =>
  ({
    role: "assistant",
    content: [
      { type: "tool-call", toolCallId: id, toolName: name, input: { path: `${id}.ts` } },
    ],
  }) as ModelMessage;
const result = (id: string, body: string, name = "read_file"): ModelMessage =>
  ({
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: id,
        toolName: name,
        output: { type: "text", value: body },
      },
    ],
  }) as ModelMessage;

/** The shape summarization exists for: a long run whose tool results are all
 *  stubs already (eviction has nothing left to take) but whose narration and
 *  tool-call ledger have kept growing. */
function longRun(turns: number): ModelMessage[] {
  const out: ModelMessage[] = [user("the spec")];
  for (let i = 0; i < turns; i++) {
    out.push(say(`Step ${i}: ${"reasoning about the auth module. ".repeat(40)}`));
    out.push(call(`c${i}`));
    out.push(result(`c${i}`, `${EVICTION_STUB_MARKER}deadbeef] dropped`));
  }
  return out;
}

describe("safeCutIndex", () => {
  it("never cuts between a tool-call and its result", () => {
    // 0:user 1:call 2:result 3:call 4:result
    const messages = [user("spec"), call("a"), result("a", "x"), call("b"), result("b", "y")];
    // maxCut 4 lands mid-pair (call b at 3 is unanswered until 4).
    expect(safeCutIndex(messages, 1, 4)).toBe(3);
  });

  it("cuts right after a balanced turn", () => {
    const messages = [user("spec"), call("a"), result("a", "x"), say("done")];
    expect(safeCutIndex(messages, 1, 3)).toBe(3);
  });

  it("returns `from` when the very first turn is already unbalanced", () => {
    const messages = [user("spec"), call("a"), result("a", "x")];
    expect(safeCutIndex(messages, 1, 2)).toBe(1);
  });

  it("handles a parallel fan-out — all of a turn's calls must be answered", () => {
    const fanOut = {
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "a", toolName: "grep", input: {} },
        { type: "tool-call", toolCallId: "b", toolName: "grep", input: {} },
      ],
    } as ModelMessage;
    const half = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "a",
          toolName: "grep",
          output: { type: "text", value: "x" },
        },
      ],
    } as ModelMessage;
    const rest = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "b",
          toolName: "grep",
          output: { type: "text", value: "y" },
        },
      ],
    } as ModelMessage;
    const messages = [user("spec"), fanOut, half, rest];
    // Cutting at 3 would leave call `b` orphaned — Anthropic 400s on that.
    expect(safeCutIndex(messages, 1, 3)).toBe(1);
    expect(safeCutIndex(messages, 1, 4)).toBe(4);
  });
});

describe("planSummarization", () => {
  it("plans a cut for a long run, protecting the spec and the hot tail", () => {
    const messages = longRun(12);
    const plan = planSummarization(messages);

    expect(plan).not.toBeNull();
    // The initial user turn — the spec, the attachments — is never summarized.
    expect(plan!.protectedCount).toBe(1);
    expect(plan!.cutIndex).toBeGreaterThan(1);
    expect(plan!.cutIndex).toBeLessThanOrEqual(messages.length - 4);
    expect(plan!.source).toContain("reasoning about the auth module");
    expect(plan!.sourceTokens).toBeGreaterThan(0);
  });

  it("declines when there's too little to be worth a model call", () => {
    expect(planSummarization([user("spec"), say("done")])).toBeNull();
    expect(planSummarization(longRun(1))).toBeNull();
  });

  it("declines when the transcript already carries a summary", () => {
    const messages = longRun(12);
    const once = applySummary(messages, planSummarization(messages)!, "a summary");
    expect(planSummarization(once)).toBeNull();
  });

  it("is deterministic — the same history plans the same cut", () => {
    const messages = longRun(12);
    expect(planSummarization(messages)).toEqual(planSummarization(messages));
  });
});

describe("applySummary", () => {
  it("replaces the middle, keeps the protected prefix and the hot tail verbatim", () => {
    const messages = longRun(12);
    const plan = planSummarization(messages)!;
    const out = applySummary(messages, plan, "what happened");

    expect(out[0]).toEqual(messages[0]);
    expect(out[1].role).toBe("user");
    expect(String(out[1].content)).toContain(SUMMARY_MARKER);
    expect(String(out[1].content)).toContain("what happened");
    expect(out.slice(2)).toEqual(messages.slice(plan.cutIndex));
    expect(out.length).toBeLessThan(messages.length);
  });

  it("leaves no tool-call without its result", () => {
    const messages = longRun(12);
    const out = applySummary(messages, planSummarization(messages)!, "s");

    const calls = new Set<string>();
    const results = new Set<string>();
    for (const m of out) {
      if (!Array.isArray(m.content)) continue;
      for (const p of m.content as Array<Record<string, unknown>>) {
        if (p.type === "tool-call") calls.add(String(p.toolCallId));
        if (p.type === "tool-result") results.add(String(p.toolCallId));
      }
    }
    expect([...calls].filter((id) => !results.has(id))).toEqual([]);
  });

  it("does not mutate its input", () => {
    const messages = longRun(12);
    const before = JSON.stringify(messages);
    applySummary(messages, planSummarization(messages)!, "s");
    expect(JSON.stringify(messages)).toBe(before);
  });
});

describe("summaryMessage", () => {
  // The message after the cut is always an assistant turn. An assistant summary
  // would put two assistant turns back to back; a user one merges cleanly into
  // the preceding user block on every provider.
  it("speaks as the harness, not as the model", () => {
    expect(summaryMessage("x").role).toBe("user");
  });

  it("tells the model the originals are gone rather than merely absent", () => {
    const content = String(summaryMessage("x").content);
    expect(content).toContain("will not bring them back");
    expect(content).toContain("use your tools");
  });
});

describe("pickSummarizerModel", () => {
  const keys = {
    anthropic: "k",
    openai: "k",
    google: null,
    xai: null,
    cerebras: null,
    groq: null,
    deepseek: null,
    mistral: null,
    openrouter: null,
    "openai-compatible": null,
    lmstudio: null,
    mlx: null,
    ollama: null,
  };

  it("picks something cheaper than the run's frontier model", () => {
    const picked = pickSummarizerModel("claude-opus-5", keys, 5_000);
    expect(picked).not.toBe("claude-opus-5");
  });

  it("never picks a provider the user has no key for", () => {
    const picked = pickSummarizerModel("claude-opus-5", { anthropic: "k" }, 5_000);
    // Only Anthropic is configured, so it can only land on an Anthropic model.
    expect(picked.startsWith("claude-")).toBe(true);
  });

  it("falls back to the run's own model when nothing else is configured", () => {
    expect(pickSummarizerModel("claude-opus-5", {}, 5_000)).toBe("claude-opus-5");
  });

  // A cheap model whose window can't hold the source is not cheap, it's a 400.
  it("refuses a model whose context window can't hold the source", () => {
    const small = pickSummarizerModel("claude-opus-5", keys, 5_000);
    const huge = pickSummarizerModel("claude-opus-5", keys, 600_000);
    expect(small).not.toBe(huge);
  });

  it("keeps the run's own model when nothing configured is cheaper", () => {
    expect(pickSummarizerModel("gpt-5.4-nano", keys, 5_000)).toBe("gpt-5.4-nano");
  });
});

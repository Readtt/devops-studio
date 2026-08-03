import { describe, it, expect } from "vitest";
import type { ModelMessage } from "ai";
import {
  compactTranscript,
  isEvictionStub,
  protectedPrefixLength,
  EVICTION_STUB_MARKER,
  MIN_EVICTABLE_CHARS,
  TOOL_RESULT_TOKEN_BUDGET,
} from "./compactTranscript";

// `prepareStep`'s messages override is per-request and never written back (see
// the module header), so this function re-runs over the FULL history on every
// step of every run. Everything below is about the two properties that makes
// load-bearing: byte-identical output for byte-identical input, and a boundary
// that only ever moves forward. Get either wrong and the Anthropic prompt cache
// — already shipped, ~10x on input — misses on every step, so the token count
// improves while the bill goes up.

// --- transcript fabricators --------------------------------------------------

const PROMPT: ModelMessage[] = [
  { role: "system", content: "SYS" },
  { role: "user", content: "Generate cases for the login spec." },
];

let nextId = 0;
function toolTurn(
  name: string,
  input: Record<string, unknown>,
  output: string,
): ModelMessage[] {
  const toolCallId = `call_${++nextId}`;
  return [
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId, toolName: name, input }],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId,
          toolName: name,
          output: { type: "text", value: output },
        },
      ],
    },
  ] as ModelMessage[];
}

/** `chars` characters of plausible file content — distinct per turn so two
 *  results never hash to the same stub by accident. */
function body(tag: string, chars: number): string {
  return `// ${tag}\n${"x".repeat(Math.max(0, chars - tag.length - 4))}`;
}

const bytes = (m: unknown) => JSON.stringify(m);

/** Indices where two transcripts differ. */
function diffIndices(a: ModelMessage[], b: ModelMessage[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (bytes(a[i]) !== bytes(b[i])) out.push(i);
  }
  return out;
}

function stubsIn(messages: ModelMessage[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    const content = (m as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const p of content as Array<Record<string, unknown>>) {
      const value = (p.output as { value?: unknown } | undefined)?.value;
      if (isEvictionStub(value)) out.push(String(value));
    }
  }
  return out;
}

/** Every toolCallId that appears as a call, and every one that appears as a
 *  result. Anthropic 400s the moment those two sets disagree. */
function pairing(messages: ModelMessage[]): { calls: string[]; results: string[] } {
  const calls: string[] = [];
  const results: string[] = [];
  for (const m of messages) {
    const content = (m as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const p of content as Array<Record<string, unknown>>) {
      if (p.type === "tool-call") calls.push(String(p.toolCallId));
      if (p.type === "tool-result") results.push(String(p.toolCallId));
    }
  }
  return { calls: calls.sort(), results: results.sort() };
}

// A budget small enough to keep the fixtures readable. Real runs use 50,000
// tokens; the arithmetic is identical either way.
const BUDGET = 2_500; // tokens
const BIG = 4_000; // chars ⇒ 1,000 tokens (estimateTokens is len/4)
const compact = (m: ModelMessage[], budget = BUDGET) =>
  compactTranscript(m, { toolResultTokenBudget: budget });

/** base + three 1,000-token results. Newest-first tally: 1,000 → 2,000 → 3,000,
 *  so the third one back crosses a 2,500-token budget and the OLDEST turn is
 *  evicted. */
function threeTurns(): ModelMessage[] {
  return [
    ...PROMPT,
    ...toolTurn("read_file", { path: "src/a.ts" }, body("a", BIG)),
    ...toolTurn("read_file", { path: "src/b.ts" }, body("b", BIG)),
    ...toolTurn("grep", { pattern: "login" }, body("c", BIG)),
  ];
}

// --- the test that matters most ---------------------------------------------

describe("prefix stability (what keeps the prompt cache alive)", () => {
  it("is byte-identical between steps while the eviction boundary holds", () => {
    const stepN = threeTurns();
    // The next step narrates and calls a tool whose result is small — nothing
    // that could push the boundary.
    const stepN1 = [
      ...stepN,
      { role: "assistant", content: "Checking one more thing." } as ModelMessage,
      ...toolTurn("run_command", { command: "git status" }, "clean"),
    ];

    const a = compact(stepN).messages;
    const b = compact(stepN1).messages;

    expect(b.length).toBe(stepN1.length);
    // Every message the previous request already sent is byte-for-byte what it
    // was. Anything else is a cache miss on the whole prefix.
    expect(bytes(b.slice(0, a.length))).toBe(bytes(a));
    expect(diffIndices(a, b.slice(0, a.length))).toEqual([]);
  });

  it("advances the boundary by exactly one turn when the tail genuinely outgrows the budget", () => {
    const stepN = threeTurns();
    const stepN1 = [...stepN, ...toolTurn("read_file", { path: "src/d.ts" }, body("d", BIG))];

    const a = compact(stepN).messages;
    const b = compact(stepN1).messages;

    // Exactly one previously-verbatim result became a stub; everything else in
    // the shared prefix is untouched.
    const moved = diffIndices(a, b.slice(0, a.length));
    expect(moved).toHaveLength(1);
    expect(stubsIn(a)).toHaveLength(1);
    expect(stubsIn(b)).toHaveLength(2);
    // …and it moved FORWARD: what was evicted stays evicted, byte-identically.
    expect(bytes(a[3])).toBe(bytes(b[3]));
  });

  it("never un-evicts: the boundary only moves in one direction", () => {
    let messages = threeTurns();
    let previousStubs: string[] = [];
    for (let step = 0; step < 6; step++) {
      const out = compact(messages).messages;
      const stubs = stubsIn(out);
      // Every stub from the previous step is still present, unchanged.
      for (const s of previousStubs) expect(stubs).toContain(s);
      expect(stubs.length).toBeGreaterThanOrEqual(previousStubs.length);
      previousStubs = stubs;
      messages = [...messages, ...toolTurn("read_file", { path: `src/f${step}.ts` }, body(`f${step}`, BIG))];
    }
    expect(previousStubs.length).toBeGreaterThan(1);
  });
});

describe("purity and determinism", () => {
  it("returns the SAME array when nothing crosses the budget", () => {
    const messages = [
      ...PROMPT,
      ...toolTurn("read_file", { path: "src/a.ts" }, body("a", BIG)),
    ];
    const r = compact(messages);
    // Reference equality, not deep equality: taskRunner skips the prepareStep
    // override entirely on this, which is what keeps an ordinary run's request
    // byte-identical to what it was before eviction existed.
    expect(r.messages).toBe(messages);
    expect(r.evictedCount).toBe(0);
  });

  it("never mutates its input", () => {
    const messages = threeTurns();
    const snapshot = bytes(messages);
    compact(messages);
    expect(bytes(messages)).toBe(snapshot);
  });

  it("emits identical bytes for identical input, run after run", () => {
    const messages = threeTurns();
    const runs = [0, 1, 2].map(() => bytes(compact(messages).messages));
    expect(new Set(runs).size).toBe(1);
  });

  it("is idempotent — compact(compact(x)) === compact(x)", () => {
    const once = compact(threeTurns()).messages;
    const twice = compact(once).messages;
    expect(bytes(twice)).toBe(bytes(once));
    // And the second pass finds nothing to do at all.
    expect(compact(once).evictedCount).toBe(0);
  });

  it("stays idempotent even when a stub is itself large enough to evict", () => {
    // A budget tight enough that the stubs from pass 1 are still on the wrong
    // side of the boundary in pass 2, and a floor low enough that their size is
    // no defence. All that stops a stub being re-evicted into a stub-of-a-stub
    // — new bytes every step, cache dead — is the marker check.
    const opts = { toolResultTokenBudget: 1_000, minEvictableChars: 1 };
    const once = compactTranscript(threeTurns(), opts).messages;
    expect(stubsIn(once)).toHaveLength(2);
    const twice = compactTranscript(once, opts).messages;
    expect(bytes(twice)).toBe(bytes(once));
    expect(stubsIn(twice)).toEqual(stubsIn(once));
  });

  it("content-addresses the stub: same evicted content ⇒ same id, wherever it sits", () => {
    const shared = body("shared", BIG);
    const left = [
      ...PROMPT,
      ...toolTurn("read_file", { path: "src/x.ts" }, shared),
      ...toolTurn("read_file", { path: "src/b.ts" }, body("b", BIG)),
      ...toolTurn("read_file", { path: "src/c.ts" }, body("c", BIG)),
    ];
    const right = [
      ...PROMPT,
      { role: "assistant", content: "different narration" } as ModelMessage,
      ...toolTurn("read_file", { path: "src/x.ts" }, shared),
      ...toolTurn("read_file", { path: "src/q.ts" }, body("q", BIG)),
      ...toolTurn("read_file", { path: "src/r.ts" }, body("r", BIG)),
    ];
    const idOf = (s: string) => s.slice(0, s.indexOf("]") + 1);
    expect(idOf(stubsIn(compact(left).messages)[0])).toBe(
      idOf(stubsIn(compact(right).messages)[0]),
    );
  });
});

describe("what eviction must never break", () => {
  it("keeps a matching tool-result for every tool-call", () => {
    const messages = [
      ...threeTurns(),
      ...toolTurn("grep", { pattern: "logout" }, body("d", BIG)),
      ...toolTurn("read_file", { path: "src/e.ts" }, body("e", BIG)),
    ];
    const out = compact(messages).messages;
    const { calls, results } = pairing(out);
    expect(calls.length).toBe(5);
    expect(results).toEqual(calls);
    // The eviction is in the CONTENT, never in the structure: no part removed,
    // no message removed.
    expect(out.length).toBe(messages.length);
  });

  it("never evicts the initial user turn", () => {
    const messages = threeTurns();
    const out = compact(messages).messages;
    expect(out[0]).toBe(messages[0]); // system preamble
    expect(out[1]).toBe(messages[1]); // the spec — the task definition itself
    expect(stubsIn(out).length).toBeGreaterThan(0);
  });

  it("protects the leading turn even in a degenerate transcript that opens with a tool result", () => {
    // Defensive: buildResumableRequest always leads with system/user, but a
    // replayed transcript is data we didn't build, and the OLDEST thing in a
    // conversation is the least safe thing to throw away.
    const orphanFirst = toolTurn("read_file", { path: "src/first.ts" }, body("first", BIG))[1];
    const messages = [
      orphanFirst,
      ...toolTurn("read_file", { path: "src/b.ts" }, body("b", BIG)),
      ...toolTurn("read_file", { path: "src/c.ts" }, body("c", BIG)),
      ...toolTurn("read_file", { path: "src/d.ts" }, body("d", BIG)),
    ];
    expect(protectedPrefixLength(messages)).toBe(1);
    const out = compact(messages).messages;
    expect(out[0]).toBe(messages[0]);
  });

  it("keeps the newest turn verbatim however big it is", () => {
    // Otherwise the model is handed a stub for a result it received one step
    // ago, calls the same tool again, and loops forever.
    const huge = body("huge", BUDGET * 4 * 3);
    const messages = [...PROMPT, ...toolTurn("read_file", { path: "src/huge.ts" }, huge)];
    const out = compact(messages).messages;
    expect(out).toBe(messages);
    expect(stubsIn(out)).toHaveLength(0);
  });

  it("leaves small results alone — the stub would cost more than the content", () => {
    const small = "ok".repeat(20);
    expect(small.length).toBeLessThan(MIN_EVICTABLE_CHARS);
    const messages = [
      ...PROMPT,
      ...toolTurn("run_command", { command: "git rev-parse HEAD" }, small),
      ...toolTurn("read_file", { path: "src/b.ts" }, body("b", BIG)),
      ...toolTurn("read_file", { path: "src/c.ts" }, body("c", BIG)),
      ...toolTurn("read_file", { path: "src/d.ts" }, body("d", BIG)),
    ];
    const out = compact(messages).messages;
    const toolMsg = out[3] as { content: Array<{ output: { value: string } }> };
    expect(toolMsg.content[0].output.value).toBe(small);
  });
});

describe("stubs are recoverable, not just smaller", () => {
  it("names the exact tool call that would fetch the content back", () => {
    const messages = threeTurns();
    const stubs = stubsIn(compact(messages).messages);
    expect(stubs).toHaveLength(1);
    const stub = stubs[0];
    expect(stub.startsWith(EVICTION_STUB_MARKER)).toBe(true);
    expect(stub).toContain("read_file");
    expect(stub).toContain('{"path":"src/a.ts"}');
    expect(stub).toMatch(/call `read_file` again/);
  });

  it("every stub carries a recovery instruction, not just the first", () => {
    let messages = threeTurns();
    for (let i = 0; i < 5; i++) {
      messages = [...messages, ...toolTurn("grep", { pattern: `p${i}` }, body(`g${i}`, BIG))];
    }
    const stubs = stubsIn(compact(messages).messages);
    expect(stubs.length).toBeGreaterThan(3);
    for (const s of stubs) expect(s).toMatch(/call `(read_file|grep)` again/);
  });

  it("falls back to 'the same arguments' when the call can't be found", () => {
    const messages: ModelMessage[] = [
      ...PROMPT,
      // A result whose tool-call part never made it into the transcript.
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "orphaned",
            toolName: "grep",
            output: { type: "text", value: body("orphan", BIG) },
          },
        ],
      } as ModelMessage,
      ...toolTurn("read_file", { path: "src/b.ts" }, body("b", BIG)),
      ...toolTurn("read_file", { path: "src/c.ts" }, body("c", BIG)),
      ...toolTurn("read_file", { path: "src/d.ts" }, body("d", BIG)),
    ];
    const stubs = stubsIn(compact(messages).messages);
    expect(stubs[0]).toContain("call `grep` again with the same arguments");
  });

  it("clips a huge tool-call argument out of the stub instead of inheriting it", () => {
    const messages = [
      ...PROMPT,
      ...toolTurn("grep", { pattern: "z".repeat(5_000) }, body("a", BIG)),
      ...toolTurn("read_file", { path: "src/b.ts" }, body("b", BIG)),
      ...toolTurn("read_file", { path: "src/c.ts" }, body("c", BIG)),
      ...toolTurn("read_file", { path: "src/d.ts" }, body("d", BIG)),
    ];
    const stub = stubsIn(compact(messages).messages)[0];
    expect(stub.length).toBeLessThan(1_000);
    expect(stub).toMatch(/more chars\)/);
  });
});

describe("shape handling", () => {
  it("evicts json outputs too, and reports what it freed", () => {
    const big = { hits: Array.from({ length: 400 }, (_, i) => ({ rel: `src/f${i}.ts`, line: i })) };
    const jsonTurn = (id: string): ModelMessage[] => [
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: id, toolName: "grep", input: { pattern: "x" } }],
      },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: id, toolName: "grep", output: { type: "json", value: big } },
        ],
      },
    ] as ModelMessage[];
    const messages = [...PROMPT, ...jsonTurn("j1"), ...jsonTurn("j2"), ...jsonTurn("j3")];
    const r = compactTranscript(messages, { toolResultTokenBudget: 3_000 });
    expect(r.evictedCount).toBeGreaterThan(0);
    expect(r.freedChars).toBeGreaterThan(1_000);
  });

  it("ignores messages with plain string content and transcripts with no tool results", () => {
    const messages: ModelMessage[] = [
      ...PROMPT,
      { role: "assistant", content: "no tools were needed" },
      { role: "user", content: "thanks" },
    ];
    expect(compact(messages).messages).toBe(messages);
  });

  it("handles an empty transcript", () => {
    expect(compact([]).messages).toEqual([]);
    expect(protectedPrefixLength([])).toBe(0);
  });

  it("ships with Gemini CLI's budget", () => {
    expect(TOOL_RESULT_TOKEN_BUDGET).toBe(50_000);
  });
});

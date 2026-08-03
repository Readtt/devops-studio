import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "ai";
import type { ActivityEntry } from "@/modules/generator/lib/activityLog";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));

import {
  checkpointIsNewer,
  createCheckpointWriter,
  deleteCheckpoint,
  getCheckpoint,
  listCheckpoints,
  MAX_PAYLOAD_BYTES,
  parseCheckpointRow,
  saveCheckpoint,
  sanitizeTranscriptMessages,
  type CommitReviewCheckpointV1,
  type GeneratorCheckpointV1,
  type GeneratorRefineCheckpointV1,
} from "./checkpointApi";

function makeGeneratorPayload(
  overrides: Partial<GeneratorCheckpointV1> = {},
): GeneratorCheckpointV1 {
  return {
    v: 1,
    surface: "generator",
    runId: "run-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    modelId: "claude-opus-5",
    sourceRoot: "/repo",
    form: {
      requirements: "req",
      changesets: "",
      attachments: [],
      attachedWorkItems: [],
      planId: 1,
      planName: "Plan",
      suiteId: 2,
      suiteName: "Suite",
      coverage: "full",
      suggestBugs: true,
      tagSourceBranch: true,
      overrideModelId: null,
    },
    prepared: null,
    activity: [],
    transcript: null,
    lastOutcome: null,
    ...overrides,
  };
}

function makeCommitReviewPayload(
  overrides: Partial<CommitReviewCheckpointV1> = {},
): CommitReviewCheckpointV1 {
  return {
    v: 1,
    surface: "commit-review",
    runId: "cr-run-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    modelId: "claude-opus-5",
    cwd: "/repo",
    sourceRoot: "/repo",
    inputs: {
      selectedShas: ["abc123"],
      diffs: [],
      context: "",
      attachments: [],
      workItems: [],
      contextBlocks: [],
    },
    stage: "investigate",
    stage1Candidates: null,
    activity: [],
    transcript: null,
    lastOutcome: null,
    ...overrides,
  };
}

beforeEach(() => {
  invoke.mockReset();
});

describe("saveCheckpoint / getCheckpoint / deleteCheckpoint / listCheckpoints", () => {
  it("round-trips through the mocked invoke with camelCase keys", async () => {
    let stored: Record<string, unknown> | null = null;
    invoke.mockImplementation(async (cmd: string, args: { input: Record<string, unknown> }) => {
      if (cmd === "ai_checkpoint_save") {
        stored = args.input;
        return undefined;
      }
      if (cmd === "ai_checkpoint_get") return stored;
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    const payload = makeGeneratorPayload();
    await saveCheckpoint({
      runId: "run-1",
      surface: "generator",
      cwd: "/repo",
      payload,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    expect(stored).not.toBeNull();
    const sent = stored as unknown as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(
      ["runId", "surface", "cwd", "payload", "createdAt", "updatedAt"].sort(),
    );
    expect(sent.runId).toBe("run-1");
    expect(sent.surface).toBe("generator");
    expect(sent.cwd).toBe("/repo");
    expect(sent.payload).toBe(JSON.stringify(payload));
    expect(sent.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(typeof sent.updatedAt).toBe("string");

    const got = await getCheckpoint("run-1");
    expect(got?.payload).toEqual(payload);
    expect(got?.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("getCheckpoint returns null when the row is missing", async () => {
    invoke.mockResolvedValue(null);
    expect(await getCheckpoint("missing")).toBeNull();
    expect(invoke).toHaveBeenCalledWith("ai_checkpoint_get", { input: { runId: "missing" } });
  });

  it("getCheckpoint returns null when the stored payload fails parseCheckpointRow", async () => {
    invoke.mockResolvedValue({
      runId: "run-1",
      surface: "generator",
      cwd: null,
      payload: "{not json",
      createdAt: "t0",
      updatedAt: "t0",
    });
    expect(await getCheckpoint("run-1")).toBeNull();
  });

  it("deleteCheckpoint sends runId only", async () => {
    invoke.mockResolvedValue(undefined);
    await deleteCheckpoint("run-1");
    expect(invoke).toHaveBeenCalledWith("ai_checkpoint_delete", { input: { runId: "run-1" } });
  });

  it("listCheckpoints defaults cwd to null and forwards a provided cwd", async () => {
    invoke.mockResolvedValue([]);
    await listCheckpoints("commit-review");
    expect(invoke).toHaveBeenCalledWith("ai_checkpoint_list", {
      input: { surface: "commit-review", cwd: null },
    });

    await listCheckpoints("generator", "/repo");
    expect(invoke).toHaveBeenCalledWith("ai_checkpoint_list", {
      input: { surface: "generator", cwd: "/repo" },
    });
  });
});

describe("parseCheckpointRow", () => {
  it("round-trips a valid generator payload", () => {
    const payload = makeGeneratorPayload();
    expect(parseCheckpointRow(JSON.stringify(payload))).toEqual(payload);
  });

  it("round-trips a valid commit-review payload", () => {
    const payload = makeCommitReviewPayload();
    expect(parseCheckpointRow(JSON.stringify(payload))).toEqual(payload);
  });

  it("round-trips a valid generator-refine payload", () => {
    const payload: GeneratorRefineCheckpointV1 = {
      v: 1,
      surface: "generator-refine",
      runId: "rfn-1",
      sessionRunId: "run-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      modelId: "claude-opus-5",
      sourceRoot: "/repo",
      round: {
        instruction: "tighten step 2",
        startedAt: "2026-01-01T00:00:00.000Z",
        beforeCases: 3,
        beforeBugs: 1,
      },
      prepared: { userPrompt: "prompt", attachments: [] },
      activity: [],
      transcript: null,
      lastOutcome: { at: "2026-01-01T00:01:00.000Z", kind: "cancelled" },
    };
    expect(parseCheckpointRow(JSON.stringify(payload))).toEqual(payload);
  });

  it("returns null when v is not 1", () => {
    const payload = { ...makeGeneratorPayload(), v: 2 };
    expect(parseCheckpointRow(JSON.stringify(payload))).toBeNull();
  });

  it("returns null for an unrecognized surface", () => {
    const payload = { ...makeGeneratorPayload(), surface: "something-else" };
    expect(parseCheckpointRow(JSON.stringify(payload))).toBeNull();
  });

  it("returns null for corrupt JSON", () => {
    expect(parseCheckpointRow("{not json")).toBeNull();
  });

  // Every checkpoint on disk was written before the run budget was denominated
  // in tokens, so its step_cap outcome carries no `limit`. CHECKPOINT_PAYLOAD_
  // VERSION stayed at 1 precisely because that field is additive — these pin
  // that a v1 row without it still loads, resumes, and keeps its outcome intact
  // rather than being dropped as unparseable (which would strand the resume
  // point the whole feature exists to protect).
  it("loads a pre-token-budget step_cap outcome with no `limit` field", () => {
    const payload = makeGeneratorPayload({
      lastOutcome: { at: "2026-06-11T00:00:00.000Z", kind: "step_cap" },
      transcript: {
        messages: [{ role: "assistant", content: "read files" }],
        stepsUsed: 24,
        usage: { totalTokens: 900_000 },
      },
    });
    const parsed = parseCheckpointRow(JSON.stringify(payload));
    expect(parsed).toEqual(payload);
    expect(parsed?.lastOutcome?.kind).toBe("step_cap");
    expect(parsed?.lastOutcome?.limit).toBeUndefined();
  });

  it("round-trips a `limit` when a newer run recorded one", () => {
    const payload = makeGeneratorPayload({
      lastOutcome: {
        at: "2026-06-11T00:00:00.000Z",
        kind: "step_cap",
        limit: "tokens",
      },
    });
    expect(parseCheckpointRow(JSON.stringify(payload))?.lastOutcome?.limit).toBe(
      "tokens",
    );
  });

  it("degrades to transcript: null when the stored transcript fails validation", () => {
    const payload = makeGeneratorPayload({
      transcript: {
        messages: [{ role: "user", content: 123 } as unknown as ModelMessage],
        stepsUsed: 1,
        usage: {},
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = parseCheckpointRow(JSON.stringify(payload));
    expect(result).toEqual({ ...payload, transcript: null });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("sanitizeTranscriptMessages", () => {
  it("passes valid assistant/tool messages through unchanged", () => {
    const messages: ModelMessage[] = [
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "1",
            toolName: "Read",
            output: { type: "text", value: "file contents" },
          },
        ],
      },
    ];
    expect(sanitizeTranscriptMessages(messages)).toEqual(messages);
  });

  it("returns null when a message carries a Uint8Array part (corrupts on the JSON round-trip)", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "file", data: new Uint8Array([1, 2, 3]), mediaType: "image/png" },
        ],
      },
    ];
    expect(sanitizeTranscriptMessages(messages)).toBeNull();
  });

  it("strips anthropic cacheControl provider options but keeps other keys", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        providerOptions: {
          anthropic: { cacheControl: { type: "ephemeral" }, foo: "bar" },
        },
      },
    ];
    const result = sanitizeTranscriptMessages(messages);
    expect(result).not.toBeNull();
    expect(result?.[0]?.providerOptions?.anthropic).toEqual({ foo: "bar" });
  });
});

describe("createCheckpointWriter", () => {
  beforeEach(() => {
    invoke.mockResolvedValue(undefined);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function writer() {
    return createCheckpointWriter({
      runId: "run-1",
      surface: "generator",
      cwd: "/repo",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  }

  function savedPayloads(): Array<Record<string, unknown>> {
    return invoke.mock.calls
      .filter(([cmd]) => cmd === "ai_checkpoint_save")
      .map(([, args]) =>
        JSON.parse((args as { input: { payload: string } }).input.payload),
      );
  }

  it("coalesces two save() calls inside the throttle window into one invoke", async () => {
    const w = writer();
    w.save(makeGeneratorPayload({ customInstructions: "first" }));
    w.save(makeGeneratorPayload({ customInstructions: "second" }));
    expect(invoke).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);

    const saved = savedPayloads();
    expect(saved).toHaveLength(1);
    expect(saved[0].customInstructions).toBe("second");
  });

  it("resets the throttle window on each save() (trailing, not leading)", async () => {
    const w = writer();
    w.save(makeGeneratorPayload({ customInstructions: "first" }));
    await vi.advanceTimersByTimeAsync(300);
    expect(invoke).not.toHaveBeenCalled();

    w.save(makeGeneratorPayload({ customInstructions: "second" })); // restarts the 500ms window
    await vi.advanceTimersByTimeAsync(300);
    expect(invoke).not.toHaveBeenCalled(); // only 300ms elapsed since the reset

    await vi.advanceTimersByTimeAsync(200);
    const saved = savedPayloads();
    expect(saved).toHaveLength(1);
    expect(saved[0].customInstructions).toBe("second");
  });

  it("flush(payload) writes immediately without waiting for the throttle timer", async () => {
    const w = writer();
    await w.flush(makeGeneratorPayload({ customInstructions: "flushed" }));
    const saved = savedPayloads();
    expect(saved).toHaveLength(1);
    expect(saved[0].customInstructions).toBe("flushed");
  });

  it("flush() with no argument writes the latest save()d payload", async () => {
    const w = writer();
    w.save(makeGeneratorPayload({ customInstructions: "latest" }));
    await w.flush();
    const saved = savedPayloads();
    expect(saved).toHaveLength(1);
    expect(saved[0].customInstructions).toBe("latest");
  });

  it("flush() with neither a payload nor a prior save() is a no-op", async () => {
    const w = writer();
    await w.flush();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("save() after delete() never invokes", async () => {
    const w = writer();
    await w.delete();
    invoke.mockClear();

    w.save(makeGeneratorPayload());
    await vi.advanceTimersByTimeAsync(1000);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("delete() with a pending timer cancels it — no write ever lands, even after timers advance", async () => {
    const w = writer();
    w.save(makeGeneratorPayload());
    await w.delete();
    invoke.mockClear();

    await vi.advanceTimersByTimeAsync(5000);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("a slow in-flight write followed by delete() runs the delete after the write, then nothing else", async () => {
    let resolveSave: (() => void) | undefined;
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "ai_checkpoint_save") {
        return new Promise<void>((resolve) => {
          resolveSave = resolve;
        });
      }
      return Promise.resolve(undefined);
    });

    const w = writer();
    w.save(makeGeneratorPayload());
    await vi.advanceTimersByTimeAsync(500); // fires the throttled write; it's now in flight

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenLastCalledWith("ai_checkpoint_save", expect.anything());

    const deleteDone = w.delete();

    // The save hasn't resolved yet, so delete's IPC call must still be queued
    // behind it in the chain, not fired early.
    await Promise.resolve();
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledTimes(1);

    resolveSave?.();
    await deleteDone;

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenLastCalledWith("ai_checkpoint_delete", {
      input: { runId: "run-1" },
    });

    // No further writes land after delete, even once more time passes.
    w.save(makeGeneratorPayload());
    await vi.advanceTimersByTimeAsync(5000);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("keeps the promise chain alive after a save() IPC rejection — a later flush/delete still invokes", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    invoke.mockRejectedValueOnce(new Error("ipc down"));

    const w = writer();
    w.save(makeGeneratorPayload({ customInstructions: "first" }));
    await vi.advanceTimersByTimeAsync(500); // fires the throttled write; invoke rejects once
    await Promise.resolve();
    await Promise.resolve();

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1); // the failure was caught + warned, not thrown

    // The chain must still be alive: a later flush() still reaches invoke...
    await w.flush(makeGeneratorPayload({ customInstructions: "second" }));
    expect(invoke).toHaveBeenCalledTimes(2);

    const saved = savedPayloads();
    expect(saved).toHaveLength(2);
    expect(saved[0].customInstructions).toBe("first");
    expect(saved[1].customInstructions).toBe("second");

    // ...and a final delete() still lands, chained after it — nothing here
    // throws or hangs despite the earlier rejection.
    await w.delete();
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(invoke).toHaveBeenLastCalledWith("ai_checkpoint_delete", {
      input: { runId: "run-1" },
    });

    warn.mockRestore();
  });

  it("keeps the chain alive after a delete() IPC rejection (no throw)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    invoke.mockRejectedValueOnce(new Error("delete ipc down"));

    const w = writer();
    await expect(w.delete()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);

    warn.mockRestore();
  });

  // The reported data loss, at its source. A 1M-token context is roughly 4 MB
  // of JSON, so the run that has the most to lose is exactly the one this cap
  // fires on — and it used to go straight from the full transcript to null,
  // silently, inside the writer, before any UI got to ask whether the run was
  // resumable. The ladder now has a middle rung.
  describe("the 4 MB cliff", () => {
    /** A transcript whose bulk is evictable tool-result content, the way a real
     *  long agentic run's is. Sized well past MAX_PAYLOAD_BYTES. */
    function fatTranscript(bytes: number): ModelMessage[] {
      const per = 200_000;
      const turns = Math.ceil(bytes / per);
      const messages: ModelMessage[] = [
        { role: "assistant", content: "starting the investigation" },
      ];
      for (let i = 0; i < turns; i++) {
        messages.push({
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
        messages.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: `c${i}`,
              toolName: "read_file",
              output: { type: "text", value: `${i}`.repeat(per) },
            },
          ],
        } as ModelMessage);
      }
      return messages;
    }

    it("keeps a >4 MB transcript RESUMABLE by compacting it instead of nulling it", async () => {
      const messages = fatTranscript(MAX_PAYLOAD_BYTES * 2);
      const payload = makeGeneratorPayload({
        transcript: { messages, stepsUsed: 24, usage: { totalTokens: 900_000 } },
      });
      expect(JSON.stringify(payload).length).toBeGreaterThan(MAX_PAYLOAD_BYTES);

      const w = writer();
      await w.flush(payload);

      const saved = savedPayloads();
      expect(saved).toHaveLength(1);
      const transcript = saved[0].transcript as {
        messages: ModelMessage[];
        stepsUsed: number;
      } | null;

      // The whole point: the resume point survived.
      expect(transcript).not.toBeNull();
      expect(transcript!.messages.length).toBe(messages.length);
      expect(transcript!.stepsUsed).toBe(24);
      // …and it fits.
      expect(JSON.stringify(saved[0]).length).toBeLessThanOrEqual(
        MAX_PAYLOAD_BYTES,
      );
      // …because the tool-result content was stubbed, not because messages
      // were dropped. Every stub names the call that would fetch it back.
      const json = JSON.stringify(transcript);
      expect(json).toContain("[evicted-tool-result #");
      expect(json).toContain("call `read_file` again");
    });

    it("still falls to transcript: null when compacting can't get it under", async () => {
      // Nothing evictable in the transcript and the bulk is elsewhere — the
      // middle rung has nothing to give, so the bottom rung still exists.
      const payload = makeGeneratorPayload({
        customInstructions: "x".repeat(MAX_PAYLOAD_BYTES + 1024),
        transcript: {
          messages: [{ role: "assistant", content: "short" }],
          stepsUsed: 3,
          usage: {},
        },
      });

      const w = writer();
      await w.flush(payload);

      expect(savedPayloads()[0].transcript).toBeNull();
    });

    it("leaves a payload under the cap completely untouched", async () => {
      const payload = makeGeneratorPayload({
        transcript: {
          messages: [{ role: "assistant", content: "y".repeat(50_000) }],
          stepsUsed: 2,
          usage: {},
        },
        activity: Array.from(
          { length: 150 },
          (_, i): ActivityEntry => ({ id: `a${i}`, ts: i, kind: "output" }),
        ),
      });

      const w = writer();
      await w.flush(payload);

      const saved = savedPayloads()[0];
      expect(saved.transcript).toEqual(payload.transcript);
      expect((saved.activity as ActivityEntry[]).length).toBe(150);
    });
  });

  it("degrades an oversize payload to transcript: null + last-100 activity before sending", async () => {
    const bigActivity: ActivityEntry[] = Array.from(
      { length: 150 },
      (_, i): ActivityEntry => ({ id: `a${i}`, ts: i, kind: "output" }),
    );
    const payload = makeGeneratorPayload({
      customInstructions: "x".repeat(MAX_PAYLOAD_BYTES + 1024),
      activity: bigActivity,
      transcript: { messages: [], stepsUsed: 1, usage: {} },
    });

    const w = writer();
    await w.flush(payload);

    const saved = savedPayloads();
    expect(saved).toHaveLength(1);
    expect(saved[0].transcript).toBeNull();
    const activity = saved[0].activity as ActivityEntry[];
    expect(activity).toHaveLength(100);
    expect(activity[0].id).toBe("a50");
    expect(activity[99].id).toBe("a149");
  });
});

describe("checkpointIsNewer", () => {
  it("returns true when the checkpoint's second is strictly after the history row's", () => {
    expect(
      checkpointIsNewer("2026-01-01T00:00:05.000Z", "2026-01-01T00:00:04.000Z"),
    ).toBe(true);
  });

  it("returns false on a same-second tie, even when the checkpoint carries millis the history row stripped", () => {
    // newTimestamp() strips millis, so a draft saved at 00:00:00.900 is
    // persisted as 00:00:00Z — LATER in wall-clock time than a checkpoint
    // written at 00:00:00.800Z. A millisecond compare would let the
    // checkpoint win here and clobber the completed draft; the history row
    // must win the tie instead.
    expect(
      checkpointIsNewer("2026-01-01T00:00:00.800Z", "2026-01-01T00:00:00Z"),
    ).toBe(false);
  });

  it("returns false when the checkpoint is older than the history row", () => {
    expect(
      checkpointIsNewer("2026-01-01T00:00:03.000Z", "2026-01-01T00:00:04.000Z"),
    ).toBe(false);
  });

  it("returns false when either date is unparseable", () => {
    expect(checkpointIsNewer("not-a-date", "2026-01-01T00:00:04.000Z")).toBe(false);
    expect(checkpointIsNewer("2026-01-01T00:00:04.000Z", "not-a-date")).toBe(false);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "ai";
import type { ActivityEntry } from "@/modules/generator/lib/activityLog";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));

import {
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

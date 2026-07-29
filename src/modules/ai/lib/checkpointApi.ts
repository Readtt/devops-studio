// TS-owned checkpoint payload shapes + thin wrappers over the Rust
// ai_checkpoint_* SQLite commands. Mirrors chatThreadsApi.ts /
// commitReviewApi.ts conventions: camelCase payloads over invoke, JSON blobs
// the Rust store never parses.
//
// createCheckpointWriter is the load-bearing piece the run engines (Task 3+)
// call after every agentic step: it throttles the common case (a checkpoint
// per step) to one write per ~500ms, and serializes every write/delete
// through a single promise chain so a throttled save can never land AFTER a
// delete fired by the run finishing successfully — the resurrect-after-delete
// bug, where a stale row reappears under a runId the UI already forgot.

import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import { modelMessageSchema, type ModelMessage } from "ai";
import type { ModelId } from "../config";
import type { ResumeErrorKind } from "./errorClass";
import type { ContextBlock } from "./contextBlocks";
import type { Attachment } from "@/components/chat/attachments";
import type { WorkItemRef } from "@/modules/ado";
import type { ActivityEntry } from "@/modules/generator/lib/activityLog";
import type { Coverage } from "@/modules/generator/lib/qaAnalystRun";
import type { CandidateFinding } from "@/modules/commit-review/schema";
import type { CommitDiff } from "@/modules/commit-review/gitCommitApi";

export type CheckpointUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
};

/** messages = FULL continuation transcript (assistant/tool response messages only —
 *  system + user turn are always rebuilt fresh from inputs at resume). */
export type TranscriptCheckpoint = {
  messages: ModelMessage[];
  stepsUsed: number; // cumulative across resumes
  usage: CheckpointUsage; // cumulative across resumes
  partialText?: string; // streamed text if the run died mid-final-answer (salvage/debug only)
};

export type CheckpointOutcome = {
  at: string; // ISO timestamp
  kind: "error" | "cancelled" | "step_cap" | "schema_violation" | "empty";
  errorKind?: ResumeErrorKind; // when kind === "error"
  message?: string;
};

export type GeneratorCheckpointV1 = {
  v: 1;
  surface: "generator";
  runId: string;
  createdAt: string;
  modelId: ModelId;
  sourceRoot: string | null;
  customInstructions?: string;
  form: {
    requirements: string;
    changesets: string;
    attachments: Attachment[];
    attachedWorkItems: WorkItemRef[];
    planId: number | null;
    planName: string | null;
    suiteId: number | null;
    suiteName: string | null;
    coverage: Coverage;
    suggestBugs: boolean;
    tagSourceBranch: boolean;
    overrideModelId: ModelId | null;
  };
  prepared: { userPrompt: string; attachments: Attachment[] } | null;
  activity: ActivityEntry[];
  transcript: TranscriptCheckpoint | null;
  lastOutcome: CheckpointOutcome | null;
};

export type CommitReviewCheckpointV1 = {
  v: 1;
  surface: "commit-review";
  runId: string;
  createdAt: string;
  modelId: ModelId;
  cwd: string;
  sourceRoot: string | null;
  customInstructions?: string;
  inputs: {
    selectedShas: string[];
    diffs: CommitDiff[];
    context: string;
    attachments: Attachment[];
    workItems: WorkItemRef[];
    contextBlocks: ContextBlock[];
  };
  stage: "investigate" | "verify";
  stage1Candidates: CandidateFinding[] | null;
  activity: ActivityEntry[];
  transcript: TranscriptCheckpoint | null;
  lastOutcome: CheckpointOutcome | null;
};

export type CheckpointPayload = GeneratorCheckpointV1 | CommitReviewCheckpointV1;

export const CHECKPOINT_PAYLOAD_VERSION = 1;
export const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

/** Appended as a user message after the transcript when resuming a run that
 *  hit its step cap. */
export const FINISH_NOW_NUDGE =
  "You have exhausted your investigation budget. Do not call any more tools. Using only what you have already read, produce the final answer now, in exactly the output format the instructions require.";

// ---- Wire row shapes (mirror Rust AiCheckpointRow / AiCheckpointListEntry) --

type RawCheckpointRow = {
  runId: string;
  surface: string;
  cwd: string | null;
  payload: string;
  createdAt: string;
  updatedAt: string;
};

type RawCheckpointListEntry = {
  runId: string;
  cwd: string | null;
  createdAt: string;
  updatedAt: string;
};

export async function saveCheckpoint(row: {
  runId: string;
  surface: CheckpointPayload["surface"];
  cwd: string | null;
  payload: CheckpointPayload;
  createdAt: string;
}): Promise<void> {
  await invoke("ai_checkpoint_save", {
    input: {
      runId: row.runId,
      surface: row.surface,
      cwd: row.cwd,
      payload: JSON.stringify(row.payload),
      createdAt: row.createdAt,
      updatedAt: new Date().toISOString(),
    },
  });
}

export async function getCheckpoint(
  runId: string,
): Promise<{ payload: CheckpointPayload; createdAt: string; updatedAt: string } | null> {
  const raw = await invoke<RawCheckpointRow | null>("ai_checkpoint_get", {
    input: { runId },
  });
  if (!raw) return null;
  const payload = parseCheckpointRow(raw.payload);
  if (!payload) return null;
  return { payload, createdAt: raw.createdAt, updatedAt: raw.updatedAt };
}

export async function deleteCheckpoint(runId: string): Promise<void> {
  await invoke("ai_checkpoint_delete", { input: { runId } });
}

export async function listCheckpoints(
  surface: CheckpointPayload["surface"],
  cwd?: string | null,
): Promise<{ runId: string; cwd: string | null; createdAt: string; updatedAt: string }[]> {
  return invoke<RawCheckpointListEntry[]>("ai_checkpoint_list", {
    input: { surface, cwd: cwd ?? null },
  });
}

function isValidEnvelope(json: unknown): json is CheckpointPayload {
  if (!json || typeof json !== "object") return false;
  const obj = json as Record<string, unknown>;
  return (
    obj.v === CHECKPOINT_PAYLOAD_VERSION &&
    (obj.surface === "generator" || obj.surface === "commit-review")
  );
}

/** Defensive parse. JSON.parse in try/catch; envelope guard: v === 1 and
 *  surface is "generator" | "commit-review" → otherwise null. When
 *  transcript is present, validate transcript.messages with
 *  z.array(modelMessageSchema).safeParse (modelMessageSchema is exported by
 *  the `ai` package); on failure DEGRADE: return the payload with
 *  transcript: null (inputs-only restore), console.warn once. Never throw. */
export function parseCheckpointRow(raw: string): CheckpointPayload | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isValidEnvelope(json)) return null;
  const payload = json;
  if (payload.transcript) {
    const parsed = z.array(modelMessageSchema).safeParse(payload.transcript.messages);
    if (!parsed.success) {
      console.warn(
        `[checkpointApi] run ${payload.runId}: stored transcript failed validation — degrading to inputs-only restore`,
        parsed.error,
      );
      return { ...payload, transcript: null };
    }
  }
  return payload;
}

/** Anthropic response messages shouldn't carry a cache breakpoint (the
 *  runner only ever tags the last message of an outgoing REQUEST, never a
 *  response) — stripping here is belt-and-braces so a persisted transcript
 *  can't resurrect a stale tag on resume. */
function stripCacheControl(m: ModelMessage): ModelMessage {
  const anthropic = m.providerOptions?.anthropic;
  if (!anthropic || !("cacheControl" in anthropic)) return m;
  const { cacheControl: _drop, ...rest } = anthropic;
  return {
    ...m,
    providerOptions: { ...m.providerOptions, anthropic: rest },
  } as ModelMessage;
}

/** JSON round-trip + z.array(modelMessageSchema) revalidation; strips
 *  providerOptions.anthropic.cacheControl tags if present on any message
 *  (belt-and-braces — response messages shouldn't carry them); returns null
 *  if any message fails validation (e.g. a binary part) so the caller
 *  degrades to inputs-only rather than persisting garbage. */
export function sanitizeTranscriptMessages(
  messages: ModelMessage[],
): ModelMessage[] | null {
  let roundTripped: unknown;
  try {
    // The round trip is the point: a Uint8Array (raw image bytes on a file
    // part) survives as a live ModelMessage but serializes to `{"0":1,...}`,
    // which modelMessageSchema correctly rejects — catching exactly the
    // shapes that would come back corrupted after a real save/load cycle.
    roundTripped = JSON.parse(JSON.stringify(messages));
  } catch {
    return null;
  }
  const parsed = z.array(modelMessageSchema).safeParse(roundTripped);
  if (!parsed.success) return null;
  return (parsed.data as ModelMessage[]).map(stripCacheControl);
}

export type CheckpointWriter = {
  /** Queue a throttled trailing write (~500ms). Latest payload wins. */
  save: (payload: CheckpointPayload) => void;
  /** Write the latest (or given) payload immediately; awaits the IPC round-trip. */
  flush: (payload?: CheckpointPayload) => Promise<void>;
  /** Cancel pending saves, delete the row, ignore all later save() calls. */
  delete: () => Promise<void>;
};

/** Trailing-throttle window for save(). A fast tool loop can call save() a
 *  few times a second (tool call, tool result, step finish); coalescing
 *  those to one write keeps SQLite from being hammered every step while
 *  staying well inside a human's tolerance for "how stale could the resume
 *  point be". */
const WRITE_THROTTLE_MS = 500;

/** Degrade an oversize payload before it goes over IPC rather than fail the
 *  write outright — losing the resume point entirely is worse than losing
 *  the transcript, since inputs-only still lets the run restart from
 *  scratch instead of vanishing. */
function capPayloadSize(payload: CheckpointPayload): CheckpointPayload {
  if (JSON.stringify(payload).length <= MAX_PAYLOAD_BYTES) return payload;
  return {
    ...payload,
    transcript: null,
    activity: payload.activity.slice(-100),
  };
}

export function createCheckpointWriter(args: {
  runId: string;
  surface: CheckpointPayload["surface"];
  cwd: string | null;
  createdAt: string;
}): CheckpointWriter {
  // Every write/delete appends here in call order and nothing runs outside
  // it, so ordering follows enqueue order rather than IPC completion order:
  // a delete queued while a write is still in flight waits for that write,
  // and a throttled write can never be enqueued once dead is set (see
  // save()/delete() below) — together that's what makes the resurrect-
  // after-delete race structurally impossible rather than merely unlikely.
  let chain: Promise<void> = Promise.resolve();
  let latest: CheckpointPayload | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dead = false;

  function clearPendingTimer(): void {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  }

  function enqueue(op: () => Promise<void>): Promise<void> {
    chain = chain.then(op);
    return chain;
  }

  function enqueueSave(payload: CheckpointPayload): Promise<void> {
    return enqueue(() =>
      saveCheckpoint({
        runId: args.runId,
        surface: args.surface,
        cwd: args.cwd,
        payload: capPayloadSize(payload),
        createdAt: args.createdAt,
      }).catch((e) => {
        // A dropped checkpoint write must never break the run it's shadowing
        // — same posture as persistRow(...).catch(() => {}) in
        // useCommitReview.ts.
        console.warn(`[checkpointApi] save failed for run ${args.runId}`, e);
      }),
    );
  }

  return {
    save(payload) {
      if (dead) return;
      latest = payload;
      clearPendingTimer();
      timer = setTimeout(() => {
        timer = undefined;
        void enqueueSave(latest as CheckpointPayload);
      }, WRITE_THROTTLE_MS);
    },
    async flush(payload) {
      if (dead) return;
      clearPendingTimer();
      const toWrite = payload ?? latest;
      if (!toWrite) return;
      latest = toWrite;
      await enqueueSave(toWrite);
    },
    async delete() {
      dead = true;
      clearPendingTimer();
      await enqueue(() =>
        deleteCheckpoint(args.runId).catch((e) => {
          console.warn(`[checkpointApi] delete failed for run ${args.runId}`, e);
        }),
      );
    },
  };
}

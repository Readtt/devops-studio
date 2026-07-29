import { beforeEach, describe, expect, it, vi } from "vitest";

// Both stages funnel through the shared runner; mocking it is what lets us
// assert which stage ran, with which budget, and on which transcript.
vi.mock("@/modules/ai/lib/taskRunner", () => ({
  runTask: vi.fn(),
  streamTask: vi.fn(),
}));

import {
  buildInvestigatePrompt,
  combinedPatchBytes,
  isOldCommit,
  runCommitReview,
  COMBINED_DIFF_WARN_BYTES,
  type RunCommitReviewInput,
} from "./runCommitReview";
import { runTask, streamTask } from "@/modules/ai/lib/taskRunner";
import { RESUME_TOPUP_STEPS, SURFACE_STEP_CAPS } from "@/modules/ai/config";
import { FINISH_NOW_NUDGE } from "@/modules/ai/lib/checkpointApi";
import type { CandidateFinding } from "./schema";
import type { CommitDiff } from "./gitCommitApi";

function diff(rawPatch: string, over: Partial<CommitDiff> = {}): CommitDiff {
  return {
    sha: "x",
    shortSha: "x",
    subject: "s",
    author: "a",
    date: "d",
    isRoot: false,
    isMerge: false,
    isLocal: false,
    files: [],
    rawPatch,
    truncated: false,
    headSha: "h",
    ...over,
  };
}

function investigate(diffs: CommitDiff[]): string {
  // Only diffs / contextBlocks / sourceRoot are read by the prompt builder.
  return buildInvestigatePrompt({
    diffs,
    contextBlocks: [],
    sourceRoot: "C:/repo",
  } as unknown as Parameters<typeof buildInvestigatePrompt>[0]);
}

describe("combinedPatchBytes", () => {
  it("sums the raw-patch sizes across commits", () => {
    expect(combinedPatchBytes([diff("abc"), diff("de")])).toBe(5);
    expect(combinedPatchBytes([])).toBe(0);
  });

  it("one max-size commit stays under the warn threshold; several exceed it", () => {
    const maxPatch = "x".repeat(30 * 1024); // PATCH_MAX_BYTES (git.rs)
    expect(combinedPatchBytes([diff(maxPatch)])).toBeLessThan(
      COMBINED_DIFF_WARN_BYTES,
    );
    expect(
      combinedPatchBytes([
        diff(maxPatch),
        diff(maxPatch),
        diff(maxPatch),
        diff(maxPatch),
      ]),
    ).toBeGreaterThan(COMBINED_DIFF_WARN_BYTES);
  });

  it("counts UTF-8 bytes, not UTF-16 code units, for multibyte diffs", () => {
    // Each "é" is 1 UTF-16 code unit but 2 UTF-8 bytes; "🚀" is 2 code units
    // but 4 bytes. .length would under-count what the Rust byte cap measures.
    const multibyte = "ééé🚀"; // length 5, bytes 10
    expect(multibyte.length).toBe(5);
    expect(combinedPatchBytes([diff(multibyte)])).toBe(10);
    expect(combinedPatchBytes([diff(multibyte)])).toBeGreaterThan(
      multibyte.length,
    );
  });
});

describe("isOldCommit", () => {
  it("is true when a commit's short sha differs from the current head", () => {
    expect(isOldCommit(diff("", { shortSha: "1111111", headSha: "2222222" }))).toBe(
      true,
    );
  });

  it("is false for the local-changes diff even when headSha differs", () => {
    // The working-tree diff is always against the live HEAD, so it must never
    // be flagged as predating the tree.
    expect(
      isOldCommit(
        diff("", { isLocal: true, shortSha: "local", headSha: "2222222" }),
      ),
    ).toBe(false);
  });

  it("is false when the commit IS the current head (7-char prefix match)", () => {
    expect(isOldCommit(diff("", { shortSha: "abc1234", headSha: "abc1234f" }))).toBe(
      false,
    );
  });
});

// ---- the two-stage pipeline, resumed -------------------------------------

const mockStreamTask = vi.mocked(streamTask);
const mockRunTask = vi.mocked(runTask);

function cand(id: string): CandidateFinding {
  return {
    id,
    title: `finding ${id}`,
    category: "correctness",
    severity: "high",
    file: "src/a.ts",
    startLine: 1,
    endLine: 2,
    explanation: "because",
    evidence: "",
    confidence: "medium",
  };
}

function input(over: Partial<RunCommitReviewInput> = {}): RunCommitReviewInput {
  return {
    modelId: "claude-sonnet-4-5" as RunCommitReviewInput["modelId"],
    keys: {} as RunCommitReviewInput["keys"],
    // null ⇒ no tools built, so the engine needs nothing from the fs layer.
    sourceRoot: null,
    diffs: [diff("@@ -1 +1 @@")],
    contextBlocks: [],
    attachments: [],
    ...over,
  };
}

function stage1Ok(findings: CandidateFinding[]) {
  return {
    ok: true,
    text: "{}",
    object: { findings },
    durationMs: 11,
    stepsUsed: 4,
  } as never;
}

function stage1Bad(reason: "schema_violation" | "empty" | "step_cap") {
  return {
    ok: false,
    reason,
    text: "not json",
    durationMs: 9,
    stepsUsed: 28,
  } as never;
}

function stage2Ok(verdicts: { id: string; verdict: string }[]) {
  return {
    ok: true,
    text: "{}",
    object: { verdicts },
    durationMs: 3,
    stepsUsed: 2,
  } as never;
}

const priorMessages = [
  { role: "assistant" as const, content: "read a file" },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runCommitReview — resume", () => {
  it("skips investigate entirely when the checkpoint carries candidates", async () => {
    mockRunTask.mockResolvedValue(stage2Ok([{ id: "f1", verdict: "confirmed" }]));

    const res = await runCommitReview(
      input({
        resume: {
          stage: "verify",
          stage1Candidates: [cand("f1")],
          resumeMessages: priorMessages,
        },
      }),
    );

    expect(mockStreamTask).not.toHaveBeenCalled();
    const args = mockRunTask.mock.calls[0][0];
    // The verify prompt is built from the RESUMED candidates…
    expect(args.prompt).toContain("f1");
    // …and the in-flight verify transcript is handed straight through.
    expect(args.resumeMessages).toEqual(priorMessages);
    expect(args.maxSteps).toBe(SURFACE_STEP_CAPS.commitReviewVerify);
    expect(res.ok).toBe(true);
    expect(res.ok && res.findings.map((f) => f.id)).toEqual(["f1"]);
  });

  it("labels the stage even when investigate is skipped", async () => {
    mockRunTask.mockResolvedValue(stage2Ok([]));
    const stages: string[] = [];
    await runCommitReview(
      input({
        onStage: (s) => stages.push(s),
        resume: {
          stage: "verify",
          stage1Candidates: [cand("f1")],
          resumeMessages: null,
        },
      }),
    );
    expect(stages).toEqual(["verify"]);
  });

  it("a candidates-resume with an empty parse finishes clean without verifying", async () => {
    const res = await runCommitReview(
      input({
        resume: {
          stage: "verify",
          stage1Candidates: [],
          resumeMessages: null,
        },
      }),
    );
    expect(mockStreamTask).not.toHaveBeenCalled();
    expect(mockRunTask).not.toHaveBeenCalled();
    expect(res).toEqual({ ok: true, findings: [], durationMs: 0 });
  });

  it("resuming investigate re-runs stage 1 on its transcript", async () => {
    mockStreamTask.mockResolvedValue(stage1Ok([]));

    await runCommitReview(
      input({
        resume: {
          stage: "investigate",
          stage1Candidates: null,
          resumeMessages: priorMessages,
        },
      }),
    );

    const args = mockStreamTask.mock.calls[0][0];
    expect(args.resumeMessages).toEqual(priorMessages);
    expect(args.maxSteps).toBe(SURFACE_STEP_CAPS.commitReviewInvestigate);
  });

  it("a step-cap resume tops the budget up and tells the resumed stage to finish", async () => {
    mockStreamTask.mockResolvedValue(stage1Ok([]));

    await runCommitReview(
      input({
        resume: {
          stage: "investigate",
          stage1Candidates: null,
          resumeMessages: priorMessages,
          stepCapNudge: true,
        },
      }),
    );

    const args = mockStreamTask.mock.calls[0][0];
    const resumed = args.resumeMessages ?? [];
    expect(args.maxSteps).toBe(RESUME_TOPUP_STEPS);
    expect(resumed[resumed.length - 1]).toEqual({
      role: "user",
      content: FINISH_NOW_NUDGE,
    });
    // The prior transcript is kept in front of the nudge.
    expect(resumed[0]).toEqual(priorMessages[0]);
  });

  it("the nudge follows the resumed stage — verify, not investigate", async () => {
    mockRunTask.mockResolvedValue(stage2Ok([]));

    await runCommitReview(
      input({
        resume: {
          stage: "verify",
          stage1Candidates: [cand("f1")],
          resumeMessages: null,
          stepCapNudge: true,
        },
      }),
    );

    const args = mockRunTask.mock.calls[0][0];
    expect(args.maxSteps).toBe(RESUME_TOPUP_STEPS);
    expect(args.resumeMessages).toEqual([
      { role: "user", content: FINISH_NOW_NUDGE },
    ]);
  });

  it("a fresh run passes no transcript and keeps both surface caps", async () => {
    mockStreamTask.mockResolvedValue(stage1Ok([cand("f1")]));
    mockRunTask.mockResolvedValue(stage2Ok([{ id: "f1", verdict: "confirmed" }]));

    await runCommitReview(input());

    expect(mockStreamTask.mock.calls[0][0].resumeMessages).toBeUndefined();
    expect(mockStreamTask.mock.calls[0][0].maxSteps).toBe(
      SURFACE_STEP_CAPS.commitReviewInvestigate,
    );
    expect(mockRunTask.mock.calls[0][0].resumeMessages).toBeUndefined();
    expect(mockRunTask.mock.calls[0][0].maxSteps).toBe(
      SURFACE_STEP_CAPS.commitReviewVerify,
    );
  });

  it("still degrades to unverified candidates when a resumed verify throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mockRunTask.mockRejectedValue(new Error("429 rate limit"));

    const res = await runCommitReview(
      input({
        resume: {
          stage: "verify",
          stage1Candidates: [cand("f1"), cand("f2")],
          resumeMessages: priorMessages,
        },
      }),
    );

    expect(res.ok).toBe(true);
    expect(res.ok && res.findings.map((f) => f.verified)).toEqual([false, false]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("runCommitReview — checkpoint callbacks", () => {
  it("reports stage-1 candidates before verify is invoked", async () => {
    const order: string[] = [];
    mockStreamTask.mockResolvedValue(stage1Ok([cand("f1")]));
    mockRunTask.mockImplementation((() => {
      order.push("verify");
      return Promise.resolve(stage2Ok([{ id: "f1", verdict: "confirmed" }]));
    }) as never);

    await runCommitReview(
      input({ onStage1Candidates: () => order.push("candidates") }),
    );

    expect(order).toEqual(["candidates", "verify"]);
  });

  it("reports a zero-finding parse too — a clean commit is durable knowledge", async () => {
    mockStreamTask.mockResolvedValue(stage1Ok([]));
    const seen: CandidateFinding[][] = [];

    const res = await runCommitReview(
      input({ onStage1Candidates: (c) => seen.push(c) }),
    );

    expect(seen).toEqual([[]]);
    expect(mockRunTask).not.toHaveBeenCalled();
    expect(res.ok).toBe(true);
  });

  it("doesn't re-report candidates that came from the checkpoint", async () => {
    mockRunTask.mockResolvedValue(stage2Ok([]));
    const onStage1Candidates = vi.fn();

    await runCommitReview(
      input({
        onStage1Candidates,
        resume: {
          stage: "verify",
          stage1Candidates: [cand("f1")],
          resumeMessages: null,
        },
      }),
    );

    expect(onStage1Candidates).not.toHaveBeenCalled();
  });

  it("tags each stage's checkpoints with the stage they belong to", async () => {
    mockStreamTask.mockImplementation((async (args: {
      onCheckpoint?: (cp: unknown) => void;
    }) => {
      args.onCheckpoint?.({ messages: [], stepsUsed: 1, usage: {} });
      return stage1Ok([cand("f1")]);
    }) as never);
    mockRunTask.mockImplementation((async (args: {
      onCheckpoint?: (cp: unknown) => void;
    }) => {
      args.onCheckpoint?.({ messages: [], stepsUsed: 1, usage: {} });
      return stage2Ok([{ id: "f1", verdict: "confirmed" }]);
    }) as never);

    const stages: string[] = [];
    await runCommitReview(input({ onCheckpoint: (s) => stages.push(s) }));

    expect(stages).toEqual(["investigate", "verify"]);
  });
});

describe("runCommitReview — failure reasons", () => {
  it.each(["step_cap", "empty", "schema_violation"] as const)(
    "carries stage 1's %s reason through instead of flattening it",
    async (reason) => {
      mockStreamTask.mockResolvedValue(stage1Bad(reason));
      const res = await runCommitReview(input());
      expect(res.ok).toBe(false);
      expect(!res.ok && res.reason).toBe(reason);
      expect(!res.ok && res.rawText).toBe("not json");
    },
  );
});

describe("buildInvestigatePrompt", () => {
  it("labels a single local-changes diff as the working tree, not a commit", () => {
    const out = investigate([
      diff("@@ -0,0 +1 @@\n+x", {
        isLocal: true,
        shortSha: "local",
        headSha: "abc1234",
      }),
    ]);
    expect(out).toContain("uncommitted local changes");
    expect(out).toContain("RAW PATCH (all uncommitted changes)");
    // A live diff is never "old", so the head-moved warning must not appear.
    expect(out).not.toContain("predate the working tree");
  });

  it("warns when a reviewed commit predates the working tree", () => {
    const out = investigate([
      diff("@@ @@", { shortSha: "1111111", headSha: "2222222" }),
    ]);
    expect(out).toContain("predate the working tree");
    expect(out).toContain("**Commit:**");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

// Both stages funnel through the shared runner; mocking it is what lets us
// assert which stage ran, with which budget, and on which transcript.
vi.mock("@/modules/ai/lib/taskRunner", () => ({
  runTask: vi.fn(),
  streamTask: vi.fn(),
}));

import {
  buildInvestigatePrompt,
  buildVerifyPrompt,
  combinedPatchBytes,
  isOldCommit,
  runCommitReview,
  unverifiedFindings,
  COMBINED_DIFF_WARN_BYTES,
  type RunCommitReviewInput,
} from "./runCommitReview";
import { runTask, streamTask } from "@/modules/ai/lib/taskRunner";
import {
  RESUME_TOPUP_TOKENS,
  SURFACE_STEP_CAPS,
  SURFACE_TOKEN_BUDGETS,
} from "@/modules/ai/config";
import {
  FINISH_NOW_NUDGE,
  TRUNCATED_ANSWER_NUDGE,
} from "@/modules/ai/lib/checkpointApi";
import type { CandidateFinding } from "./schema";

const REPOS = [{ id: "r1", name: "repo-one", root: "C:/repo", ado: null }];
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
  // Only diffs / contextBlocks / repos are read by the prompt builder.
  return buildInvestigatePrompt({
    diffs,
    contextBlocks: [],
    repos: REPOS,
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
    repos: [],
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

  it("a budget-stopped resume tops up TOKENS and tells the resumed stage to finish", async () => {
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
    expect(args.tokenBudget).toBe(RESUME_TOPUP_TOKENS);
    // The step ceiling is a runaway guard, not the ration — it goes back to the
    // full surface cap so a model that only needs a few cheap turns to write out
    // findings it already investigated isn't starved a second time.
    expect(args.maxSteps).toBe(SURFACE_STEP_CAPS.commitReviewInvestigate);
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
    expect(args.tokenBudget).toBe(RESUME_TOPUP_TOKENS);
    expect(args.maxSteps).toBe(SURFACE_STEP_CAPS.commitReviewVerify);
    expect(args.resumeMessages).toEqual([
      { role: "user", content: FINISH_NOW_NUDGE },
    ]);
  });

  // A truncated answer is NOT a wandering one: FINISH_NOW_NUDGE tells it to
  // stop reading, which it wasn't doing, and "answer now" at the same output
  // cap deterministically meets the same ceiling. The generator got both halves
  // of this in b7a2724; Commit Review failed closed instead, so a truncated
  // review offered no resume at all.
  it("a truncated resume retries at the raised ceiling with the truncation nudge", async () => {
    mockStreamTask.mockResolvedValue(stage1Ok([]));

    await runCommitReview(
      input({
        resume: {
          stage: "investigate",
          stage1Candidates: null,
          resumeMessages: priorMessages,
          stepCapNudge: true,
          raisedOutputCap: 128_000,
        },
      }),
    );

    const args = mockStreamTask.mock.calls[0][0];
    const resumed = args.resumeMessages ?? [];
    expect(args.maxOutputTokens).toBe(128_000);
    expect(resumed[resumed.length - 1]).toEqual({
      role: "user",
      content: TRUNCATED_ANSWER_NUDGE,
    });
    // Still a finish pass in every other respect.
    expect(args.tokenBudget).toBe(RESUME_TOPUP_TOKENS);
    expect(resumed[0]).toEqual(priorMessages[0]);
  });

  it("carries the raised ceiling into a resumed VERIFY stage too", async () => {
    mockRunTask.mockResolvedValue(stage2Ok([]));

    await runCommitReview(
      input({
        resume: {
          stage: "verify",
          stage1Candidates: [cand("f1")],
          resumeMessages: null,
          stepCapNudge: true,
          raisedOutputCap: 64_000,
        },
      }),
    );

    const args = mockRunTask.mock.calls[0][0];
    expect(args.maxOutputTokens).toBe(64_000);
    expect(args.resumeMessages).toEqual([
      { role: "user", content: TRUNCATED_ANSWER_NUDGE },
    ]);
  });

  it("sends no output cap when the stop wasn't a truncation", async () => {
    // Omitted, not zero: absent means "use the per-model config cap", which is
    // what every non-truncation resume should keep running at.
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

    expect(mockStreamTask.mock.calls[0][0].maxOutputTokens).toBeUndefined();
  });

  it("a fresh run passes no transcript and keeps both surface caps", async () => {
    mockStreamTask.mockResolvedValue(stage1Ok([cand("f1")]));
    mockRunTask.mockResolvedValue(stage2Ok([{ id: "f1", verdict: "confirmed" }]));

    await runCommitReview(input());

    expect(mockStreamTask.mock.calls[0][0].resumeMessages).toBeUndefined();
    expect(mockStreamTask.mock.calls[0][0].maxSteps).toBe(
      SURFACE_STEP_CAPS.commitReviewInvestigate,
    );
    expect(mockStreamTask.mock.calls[0][0].tokenBudget).toBe(
      SURFACE_TOKEN_BUDGETS.commitReviewInvestigate,
    );
    expect(mockRunTask.mock.calls[0][0].resumeMessages).toBeUndefined();
    expect(mockRunTask.mock.calls[0][0].maxSteps).toBe(
      SURFACE_STEP_CAPS.commitReviewVerify,
    );
    expect(mockRunTask.mock.calls[0][0].tokenBudget).toBe(
      SURFACE_TOKEN_BUDGETS.commitReviewVerify,
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

// Item 7 of the phase, as a measurement rather than a claim. The engine already
// had the SHAPE of a sub-agent split — two loops, two clean transcripts — but
// verify re-inlined every raw patch alongside the candidate JSON, so every byte
// of every diff was paid for twice per review and re-sent on each of verify's
// agentic steps.
describe("unverifiedFindings", () => {
  it("flags every candidate unverified and sorts them by severity", () => {
    const out = unverifiedFindings([
      { ...cand("low"), severity: "low" },
      { ...cand("crit"), severity: "critical" },
    ]);
    expect(out.map((f) => f.id)).toEqual(["crit", "low"]);
    expect(out.every((f) => f.verified === false)).toBe(true);
  });
});

describe("buildVerifyPrompt — the verify stage's window", () => {
  const hunk = (path: string, bytes: number) =>
    [
      `diff --git a/${path} b/${path}`,
      "index 1111111..2222222 100644",
      `--- a/${path}`,
      `+++ b/${path}`,
      "@@ -1,3 +1,3 @@",
      `+${"x".repeat(bytes)}`,
    ].join("\n");

  const bigDiff = () =>
    diff(
      [
        hunk("src/a.ts", 20_000),
        hunk("src/b.ts", 20_000),
        hunk("src/c.ts", 20_000),
        hunk("src/d.ts", 20_000),
      ].join("\n"),
      { shortSha: "abc1234", headSha: "abc1234" },
    );

  const verify = (diffs: CommitDiff[], candidates: CandidateFinding[]) =>
    buildVerifyPrompt(
      {
        diffs,
        contextBlocks: [],
        repos: REPOS,
      } as unknown as RunCommitReviewInput,
      candidates,
    );

  it("is strictly smaller than the investigate prompt it would otherwise repeat", () => {
    const diffs = [bigDiff()];
    const before = investigate(diffs);
    const after = verify(diffs, [{ ...cand("f1"), file: "src/b.ts" }]);
    expect(after.length).toBeLessThan(before.length);
    // Three of four files' hunks are gone; the candidate's own file stays.
    expect(after).toContain("diff --git a/src/b.ts");
    expect(after).not.toContain("diff --git a/src/a.ts");
  });

  it("still shows the full file list and names what it dropped", () => {
    const files = [
      { path: "src/a.ts", additions: 1, deletions: 0, status: "modified" },
      { path: "src/b.ts", additions: 1, deletions: 0, status: "modified" },
    ];
    const out = verify(
      [{ ...bigDiff(), files }],
      [{ ...cand("f1"), file: "src/b.ts" }],
    );
    // The blast radius is still legible even where the hunks aren't.
    expect(out).toContain("src/a.ts");
    expect(out).toContain("**Files changed:** 2");
    // …and the exact command that fetches an omitted file back.
    expect(out).toContain("git show abc1234 -- <path>");
  });

  it("leaves a small diff exactly as the investigate stage saw it", () => {
    const diffs = [diff("@@ -1 +1 @@\n+small change")];
    const out = verify(diffs, [{ ...cand("f1"), file: "src/b.ts" }]);
    expect(out).toContain("RAW PATCH (this commit's own change):");
    expect(out).toContain("+small change");
  });

  it("never narrows away the evidence when candidates cite code outside the diff", () => {
    // A finding about a caller the commit never touched is legitimate — and a
    // verifier handed an empty patch would refute it for the wrong reason.
    const diffs = [bigDiff()];
    const out = verify(diffs, [{ ...cand("f1"), file: "src/elsewhere.ts" }]);
    for (const p of ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]) {
      expect(out).toContain(`diff --git a/${p}`);
    }
  });
});

// A stage-1 answer cut off by the output cap (`finish: length`) fails
// whole-batch validation, but the complete findings that arrived before the
// cut are bought-and-paid-for work — and the verify pass exists precisely to
// filter candidates. These pin: broken answers are salvaged and the pipeline
// continues; a budget-stopped loop is NOT (its resume affordance is the honest
// recovery, and narration-shaped "findings" from a half-read investigation
// would be premature).
describe("runCommitReview — stage-1 salvage of a truncated answer", () => {
  it("salvages complete findings from a length-cut stage 1 and continues to verify", async () => {
    const truncated =
      `{"findings":[${JSON.stringify(cand("f1"))},` +
      `{"id":"f2","title":"the finding the cut landed i`;
    mockStreamTask.mockResolvedValue({
      ok: false,
      reason: "schema_violation",
      finishReason: "length",
      text: truncated,
      durationMs: 9,
      stepsUsed: 12,
    } as never);
    mockRunTask.mockResolvedValue(stage2Ok([{ id: "f1", verdict: "confirmed" }]));
    const onStage1Candidates = vi.fn();

    const res = await runCommitReview(input({ onStage1Candidates }));

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.findings.map((f) => f.id)).toEqual(["f1"]);
    }
    // The salvaged candidates became durable before verify ran…
    expect(onStage1Candidates).toHaveBeenCalledWith([cand("f1")]);
    // …and verify actually ran over them.
    expect(mockRunTask).toHaveBeenCalledTimes(1);
  });

  it("does not salvage a step_cap loop — that failure keeps its resume path", async () => {
    // Narration from a cut-off loop can contain findings-shaped JSON; a
    // half-read investigation must still fail through to the resume affordance.
    mockStreamTask.mockResolvedValue({
      ok: false,
      reason: "step_cap",
      text: `{"findings":[${JSON.stringify(cand("f1"))}]}`,
      durationMs: 9,
      stepsUsed: 28,
    } as never);

    const res = await runCommitReview(input());

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("step_cap");
    expect(mockRunTask).not.toHaveBeenCalled();
  });

  it("still fails through with the finish reason when nothing is salvageable", async () => {
    mockStreamTask.mockResolvedValue({
      ok: false,
      reason: "schema_violation",
      finishReason: "length",
      text: "no findings json anywhere",
      durationMs: 9,
      stepsUsed: 12,
    } as never);

    const res = await runCommitReview(input());

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("schema_violation");
      expect(res.finishReason).toBe("length");
    }
    expect(mockRunTask).not.toHaveBeenCalled();
  });

  // `step_cap` was the only excluded reason, but `empty` hands back the same
  // hazard by a different route: on that arm the runner's `text` is EVERY
  // step's narration concatenated. A reviewer that sketches a finding at step 4,
  // keeps investigating, rules it out, and then writes nothing would have the
  // sketch salvaged, verified, and shown to the user as a real finding with an
  // applyable patch. Salvage reads the final step's text instead.
  it("does not salvage findings out of mid-run narration", async () => {
    mockStreamTask.mockResolvedValue({
      ok: false,
      reason: "empty",
      finishReason: "length",
      text: `So far I suspect: {"findings":[${JSON.stringify(
        cand("f1"),
      )}]}\nChecking the caller now…`,
      finalText: "",
      durationMs: 9,
      stepsUsed: 12,
    } as never);

    const res = await runCommitReview(input());

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("empty");
    expect(mockRunTask).not.toHaveBeenCalled();
  });
});

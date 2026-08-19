// The two-stage Commit Review engine: Investigate → Verify → merge.
// Both stages funnel through the shared task runner with read-only tools at
// temperature 0. See commitReviewPrompts.ts for the strategy rationale.

import {
  RESUME_TOPUP_TOKENS,
  SURFACE_STEP_CAPS,
  SURFACE_TOKEN_BUDGETS,
  type ModelId,
} from "@/modules/ai/config";
import { type ProviderKeys } from "@/modules/ai/lib/keyring";
import type { BudgetLimit } from "@/modules/ai/lib/runBudget";
import {
  runTask,
  streamTask,
  type TaskCheckpoint,
} from "@/modules/ai/lib/taskRunner";
// The nudge text only — the engine never reads or writes a checkpoint itself;
// it reports through callbacks and the store owns persistence.
import {
  FINISH_NOW_NUDGE,
  TRUNCATED_ANSWER_NUDGE,
} from "@/modules/ai/lib/checkpointApi";
import { compactForResume } from "@/modules/ai/lib/compactTranscript";
import {
  focusPathsFromCandidates,
  focusPathsInRepo,
  focusPatchOnFiles,
} from "./verifyFocus";
import type { ModelMessage } from "ai";
import type { LocalProviderConfig } from "@/modules/ai/lib/agent";
import { buildSuiteChatTools } from "@/modules/test-plans/lib/suiteChatTools";
import type { WorkspaceRepo } from "@/modules/settings/store";
import {
  collectContextImages,
  formatContextBlocks,
  type ContextBlock,
} from "@/modules/ai/lib/contextBlocks";
import { type Attachment } from "@/components/chat/attachments";
import type { ActivityEntry } from "@/modules/generator/lib/activityLog";
import type { RepoCommitDiff } from "./gitCommitApi";
import {
  Stage1Schema,
  Stage2Schema,
  compareFindings,
  salvageCandidateFindings,
  type CandidateFinding,
  type Finding,
} from "./schema";
import {
  investigateSystemPrompt,
  verifySystemPrompt,
} from "./commitReviewPrompts";

export type RunStage = "investigate" | "verify";

/** Where a previous attempt died, and what it already bought. */
export type CommitReviewResume = {
  stage: RunStage;
  /** Present ⇒ stage 1 already parsed: skip investigate entirely. */
  stage1Candidates: CandidateFinding[] | null;
  /** Transcript for the in-flight stage (null ⇒ restart that stage's call
   *  from its rebuilt prompt alone). */
  resumeMessages: ModelMessage[] | null;
  /** Append FINISH_NOW_NUDGE and run the resumed stage on RESUME_TOPUP_TOKENS
   *  instead of the stage's full budget. */
  stepCapNudge?: boolean;
  /** The previous attempt died because the request didn't fit. Replays the
   *  transcript at a much tighter eviction budget so the resumed request is a
   *  SUBSET of the one that overflowed rather than a superset of it. */
  afterOverflow?: boolean;
  /** The previous attempt's answer was cut off by the OUTPUT cap
   *  (`finish: length`), and a higher ceiling exists to retry at. Swaps
   *  FINISH_NOW_NUDGE — which diagnoses a wandering run, not a truncated one,
   *  and invites the same overrun — for TRUNCATED_ANSWER_NUDGE, and runs the
   *  retry AT the ceiling. Without both, the retry is the failed attempt again
   *  and bills the user twice for one failure, which is why the resume was
   *  refused outright until now. Same treatment b7a2724 gave the generator. */
  raisedOutputCap?: number;
};

export type RunCommitReviewInput = {
  modelId: ModelId;
  keys: ProviderKeys;
  local?: LocalProviderConfig;
  /** Source repos the Read/Glob/Grep tools read. Empty ⇒ code search is off;
   *  the review then works from the diff alone (degraded — see the pane warning). */
  repos: WorkspaceRepo[];
  /** The selected commits' diffs + metadata, from `git_commit_diff`. One entry
   *  is the common case; multiple are reviewed together as one combined change. */
  diffs: RepoCommitDiff[];
  /** Best-practices + ticket/work-item context, already assembled by the store. */
  contextBlocks: ContextBlock[];
  /** Image attachments (screenshots of a ticket, etc.) for vision input. */
  attachments: Attachment[];
  customInstructions?: string;
  onToolEvent?: (e: ActivityEntry) => void;
  /** Fired as the engine moves between stages so the pane can label the wait. */
  onStage?: (stage: RunStage) => void;
  /** Continue a run that died mid-pipeline instead of paying for it again. */
  resume?: CommitReviewResume;
  /** Fired after each completed agentic step, tagged with the stage it belongs
   *  to so the store knows where a resume would pick up. */
  onCheckpoint?: (stage: RunStage, cp: TaskCheckpoint) => void;
  /** Fired the moment stage 1 parses, BEFORE verify starts. */
  onStage1Candidates?: (candidates: CandidateFinding[]) => void;
  signal?: AbortSignal;
};

export type RunCommitReviewResult =
  | { ok: true; findings: Finding[]; durationMs: number }
  | {
      /** Stage 1 didn't return usable findings — surface the raw text.
       *  `step_cap` means the loop ran into a run budget before it got to write
       *  them (resumable); the other two mean it answered with something
       *  unusable. */
      ok: false;
      reason: "schema_violation" | "empty" | "step_cap";
      /** Which budget guard bound the loop, when one did. */
      limit?: BudgetLimit;
      /** Why the provider ended the model's last step — `length` (output cap),
       *  `stop` (wrote nothing), `tool-calls` (cut off mid-read). The three
       *  need different sentences; see `emptyAnswerCause`. */
      finishReason?: string;
      /** The output cap this attempt's requests actually asked for. What a
       *  `finish: length` resume needs to tell whether a HIGHER cap even
       *  exists to retry at — `canRaiseOutputCap` fails closed without it, so
       *  dropping it here is what made every truncated review unresumable. */
      outputCap?: number;
      rawText: string;
      durationMs: number;
    };

/** Soft ceiling on the combined raw-patch size fed to the model in one review.
 *  Each commit's patch is capped at 30 KiB (PATCH_MAX_BYTES in git.rs), sized
 *  so a single diff plus the system prompt fits the cheaper BYOK models. A
 *  multi-commit review concatenates them unbounded, so past this combined size
 *  the prompt risks overflowing the model's context or exhausting the run budget
 *  and degrading (or failing) silently. Advisory only — the pane warns, the run
 *  still proceeds. */
export const COMBINED_DIFF_WARN_BYTES = 96 * 1024;

/** Combined size of the raw patch text across the given diffs — a proxy for the
 *  diff portion of the review prompt, used to warn on oversized multi-selects. */
export function combinedPatchBytes(diffs: RepoCommitDiff[]): number {
  return diffs.reduce(
    (sum, d) => sum + new TextEncoder().encode(d.rawPatch).length,
    0,
  );
}

/** Stage 1's candidates as renderable findings, flagged unverified. The engine
 *  degrades to this whenever the verify pass fails; the pane renders the same
 *  thing when the run never reached a verify pass at all (the user stopped it,
 *  the app quit, the provider died). One function so "unverified" means the
 *  same shape and the same order in both places. */
export function unverifiedFindings(candidates: CandidateFinding[]): Finding[] {
  return candidates.map((c) => ({ ...c, verified: false })).sort(compareFindings);
}

export async function runCommitReview(
  input: RunCommitReviewInput,
): Promise<RunCommitReviewResult> {
  const tools = buildSuiteChatTools(input.repos);
  const contextImages = collectContextImages(input.contextBlocks);
  const attachments = [...input.attachments, ...contextImages];

  // A verify-stage resume is only meaningful with the candidates it was
  // verifying: without them stage 1 has to run again, and its freshly-minted
  // ids would never join back to the old transcript's verdicts.
  const resume =
    input.resume?.stage === "verify" && !input.resume.stage1Candidates
      ? undefined
      : input.resume;
  /** Budget + continuation transcript for `stage`. Only the stage the resume
   *  targets continues anything; the other one runs from scratch as always.
   *
   *  The transcript is compacted on the way in — a no-op at the live budget for
   *  anything a healthy run produced, and an aggressive squeeze when the reason
   *  we're here is that the request didn't fit.
   *
   *  A budget-exhausted resume tops up TOKENS and keeps the full step ceiling:
   *  the ceiling is a runaway guard, and cutting it to a top-up (which is what
   *  this did) starved a model that only needed a handful of cheap turns to
   *  write out findings it had already investigated. */
  const resumeArgs = (
    stage: RunStage,
    surfaceCap: number,
    surfaceTokens: number,
  ): {
    maxSteps: number;
    tokenBudget: number;
    resumeMessages: ModelMessage[] | undefined;
    maxOutputTokens?: number;
  } => {
    const full = { maxSteps: surfaceCap, tokenBudget: surfaceTokens };
    if (!resume || resume.stage !== stage) {
      return { ...full, resumeMessages: undefined };
    }
    const prior = resume.resumeMessages
      ? compactForResume(resume.resumeMessages, resume.afterOverflow === true)
      : undefined;
    if (!resume.stepCapNudge) {
      return { ...full, resumeMessages: prior };
    }
    const truncated = resume.raisedOutputCap !== undefined;
    return {
      maxSteps: surfaceCap,
      tokenBudget: RESUME_TOPUP_TOKENS,
      resumeMessages: [
        ...(prior ?? []),
        {
          role: "user",
          content: truncated ? TRUNCATED_ANSWER_NUDGE : FINISH_NOW_NUDGE,
        },
      ],
      ...(truncated ? { maxOutputTokens: resume.raisedOutputCap } : {}),
    };
  };

  let candidates: CandidateFinding[];
  // 0 on a resume that skips investigate — this call didn't pay for it.
  let stage1Ms = 0;

  if (resume?.stage === "verify" && resume.stage1Candidates) {
    candidates = resume.stage1Candidates;
  } else {
    // --- Stage 1: investigate ----------------------------------------------
    input.onStage?.("investigate");
    const stage1Args = resumeArgs(
      "investigate",
      SURFACE_STEP_CAPS.commitReviewInvestigate,
      SURFACE_TOKEN_BUDGETS.commitReviewInvestigate,
    );
    const stage1 = await streamTask({
      modelId: input.modelId,
      keys: input.keys,
      local: input.local ?? {},
      systemPrompt: investigateSystemPrompt(input.diffs.length, input.repos),
      customInstructions: input.customInstructions,
      prompt: buildInvestigatePrompt(input),
      attachments,
      tools: tools ?? null,
      temperature: 0,
      maxSteps: stage1Args.maxSteps,
      ...(stage1Args.maxOutputTokens !== undefined
        ? { maxOutputTokens: stage1Args.maxOutputTokens }
        : {}),
      tokenBudget: stage1Args.tokenBudget,
      resumeMessages: stage1Args.resumeMessages,
      schema: Stage1Schema,
      onToolEvent: input.onToolEvent,
      onCheckpoint: (cp) => input.onCheckpoint?.("investigate", cp),
      signal: input.signal,
      // We don't render the streamed JSON; findings appear when the run resolves.
      onText: () => {},
    });

    if (!stage1.ok) {
      // An answer that BROKE (cut off by the output cap, or item-wise invalid)
      // still carries the complete findings that landed before the break —
      // salvage those and continue, exactly as the generator keeps the cases
      // that arrived. NOT for `step_cap`: that loop was cut off mid-READ, so
      // anything findings-shaped in its narration is premature, and the resume
      // affordance (finish with what you have) is the honest recovery there.
      //
      // Scanned out of the FINAL step's text, not `text`: on the `empty` arm
      // `text` is every step's narration concatenated, so a finding the
      // reviewer sketched at step 4 and then ruled out would be salvaged,
      // verified, and shown to the user as a real one with an applyable patch.
      // `finalText` is empty exactly when no answer was written.
      const salvaged =
        stage1.reason === "step_cap"
          ? []
          : salvageCandidateFindings(stage1.finalText ?? stage1.text);
      if (salvaged.length === 0) {
        return {
          ok: false,
          reason: stage1.reason,
          ...(stage1.limit ? { limit: stage1.limit } : {}),
          ...(stage1.finishReason ? { finishReason: stage1.finishReason } : {}),
          ...(stage1.outputCap !== undefined
            ? { outputCap: stage1.outputCap }
            : {}),
          rawText: stage1.text,
          durationMs: stage1.durationMs,
        };
      }
      candidates = salvaged;
    } else {
      candidates = stage1.object.findings;
    }
    stage1Ms = stage1.durationMs;
    // The one moment the expensive investigate pass becomes durable — fired
    // before the (independently failable) verify pass, and before the
    // clean-commit early return, because an empty parse is knowledge too.
    input.onStage1Candidates?.(candidates);
  }

  // Clean commit — skip the verify pass entirely (no false positives to filter).
  if (candidates.length === 0) {
    return { ok: true, findings: [], durationMs: stage1Ms };
  }

  // --- Stage 2: verify / filter -------------------------------------------
  input.onStage?.("verify");
  // The unverified fallback: stage 1's candidates are already bought and paid
  // for, so a verify-pass failure of ANY kind — unparseable verdicts below, or
  // a thrown provider error here (a rate limit right after the token-heavy
  // investigate pass is the common case) — degrades to returning them
  // unverified instead of torching the whole run. Only a user abort propagates.
  let stage2;
  const stage2Args = resumeArgs(
    "verify",
    SURFACE_STEP_CAPS.commitReviewVerify,
    SURFACE_TOKEN_BUDGETS.commitReviewVerify,
  );
  try {
    stage2 = await runTask({
      modelId: input.modelId,
      keys: input.keys,
      local: input.local ?? {},
      systemPrompt: verifySystemPrompt(input.diffs.length, input.repos),
      customInstructions: input.customInstructions,
      prompt: buildVerifyPrompt(input, candidates),
      attachments,
      tools: tools ?? null,
      temperature: 0,
      maxSteps: stage2Args.maxSteps,
      ...(stage2Args.maxOutputTokens !== undefined
        ? { maxOutputTokens: stage2Args.maxOutputTokens }
        : {}),
      tokenBudget: stage2Args.tokenBudget,
      resumeMessages: stage2Args.resumeMessages,
      schema: Stage2Schema,
      onToolEvent: input.onToolEvent,
      onCheckpoint: (cp) => input.onCheckpoint?.("verify", cp),
      signal: input.signal,
    });
  } catch (e) {
    if ((e as { name?: string } | null)?.name === "AbortError") throw e;
    console.warn("[commit-review] verify pass failed, returning unverified:", e);
    return { ok: true, findings: unverifiedFindings(candidates), durationMs: stage1Ms };
  }

  const totalMs = stage1Ms + stage2.durationMs;

  // Verify failed to parse → fall back to the unfiltered candidates rather
  // than dropping everything; the confidence filter in the UI still applies.
  if (!stage2.ok) {
    return { ok: true, findings: unverifiedFindings(candidates), durationMs: totalMs };
  }

  const verdicts = new Map(stage2.object.verdicts.map((v) => [v.id, v]));
  const merged: Finding[] = [];
  for (const c of candidates) {
    const v = verdicts.get(c.id);
    if (!v) {
      // No verdict came back for this candidate — keep it but de-rate it.
      merged.push({ ...c, confidence: "low", verified: false });
      continue;
    }
    if (v.verdict === "refuted") continue; // false positive — drop
    merged.push({
      ...c,
      severity: v.finalSeverity ?? c.severity,
      confidence: v.finalConfidence ?? c.confidence,
      suggestedFix: v.suggestedFix ?? c.suggestedFix,
      verified: v.verdict === "confirmed",
    });
  }
  merged.sort(compareFindings);
  return { ok: true, findings: merged, durationMs: totalMs };
}

function diffHeader(diff: RepoCommitDiff): string {
  const totalAdds = diff.files.reduce((s, f) => s + f.additions, 0);
  const totalDels = diff.files.reduce((s, f) => s + f.deletions, 0);
  // The file LIST is prefixed — it's the model's map of the change, and every
  // path it emits has to be addressable. The raw patch below is left exactly as
  // git wrote it (rewriting `diff --git` headers would corrupt a patch the
  // model may hand to `git apply`), which is why the repo is named here.
  const fileList = diff.files
    .map(
      (f) =>
        `- ${f.status.toUpperCase()}: ${diff.repoName}/${f.path}  (+${f.additions} / -${f.deletions})`,
    )
    .join("\n");
  const repoLine = `**Repo:** ${diff.repoName} — paths inside the raw patch below are relative to it; prefix them with \`${diff.repoName}/\` to address them.`;
  if (diff.isLocal) {
    return `${repoLine}
**Working tree:** uncommitted local changes (staged + unstaged + new files, vs HEAD)
**Files changed:** ${diff.files.length}  (+${totalAdds} / -${totalDels})

${fileList || "_(no changes)_"}`;
  }
  const merge = diff.isMerge
    ? " (merge commit — diff is vs its first parent)"
    : diff.isRoot
      ? " (root commit — full initial content)"
      : "";
  return `${repoLine}
**Commit:** \`${diff.shortSha}\` — ${diff.subject}${merge}
**Author:** ${diff.author}  ·  **Date:** ${diff.date}
**Files changed:** ${diff.files.length}  (+${totalAdds} / -${totalDels})

${fileList || "_(no per-file stats — empty commit?)_"}`;
}

/** True when a commit predates the working tree (its tools read a newer HEAD).
 *  Compares on a fixed 7-char prefix so it's robust to differing abbreviation
 *  lengths or Rust returning a full headSha. */
export function isOldCommit(diff: RepoCommitDiff): boolean {
  return (
    // The local-changes diff is always against the live HEAD — never "old".
    !diff.isLocal &&
    !!diff.headSha &&
    !!diff.shortSha &&
    diff.shortSha.slice(0, 7) !== diff.headSha.slice(0, 7)
  );
}

/** The patch body for one commit plus the label above it. `focusPaths` (the
 *  verify stage only) narrows it to the files the candidate findings cite — see
 *  verifyFocus.ts for why that's a deterministic slice rather than a summary
 *  call, and for the guards that make it a no-op whenever narrowing wouldn't
 *  help or would leave the verifier blind. */
function patchBlock(
  d: RepoCommitDiff,
  focusPaths: readonly string[] | undefined,
  knownRepos: readonly string[],
): { label: string; body: string } {
  const scope = d.isLocal ? "all uncommitted changes" : "this commit's own change";
  // Cited paths are repo-prefixed; the patch's own headers are not. Map them
  // into this repo (and drop the ones that name a different one) before
  // matching, or nothing ever matches and the narrowing quietly never fires.
  const focused = focusPaths
    ? focusPatchOnFiles(
        d.rawPatch,
        focusPathsInRepo(focusPaths, d.repoName, knownRepos),
      )
    : null;
  if (!focused) {
    return { label: `RAW PATCH (${scope}):`, body: d.rawPatch || "(empty)" };
  }
  const n = focused.omitted.length;
  const where = d.isLocal
    ? "read_file (they're uncommitted, so the working tree is their content)"
    : `\`git show ${d.shortSha} -- <path>\` via run_command (repo: ${d.repoName})`;
  return {
    label:
      `RAW PATCH (${scope}) — only the hunks for files the candidate findings cite. ` +
      `${n} other changed file${n === 1 ? "" : "s"} omitted (${focused.omitted.join(", ")}); ` +
      `read ${n === 1 ? "it" : "them"} with ${where} if a verdict needs it.`,
    body: focused.text,
  };
}

/** Each commit's metadata + raw patch, as one labelled section per commit.
 *
 *  `readableRepos` is the whole workspace the tools can reach, not just the
 *  repos with a diff in the selection: a finding routinely cites a repo it only
 *  READ (that's the point of reviewing across repos), and `focusPathsInRepo`
 *  needs to recognise that prefix as a prefix rather than treat it as the first
 *  directory of a path in the repo it's currently narrowing. */
function commitSections(
  diffs: RepoCommitDiff[],
  readableRepos: readonly string[],
  focusPaths?: readonly string[],
): string {
  const knownRepos = [
    ...new Set([...diffs.map((d) => d.repoName), ...readableRepos]),
  ];
  if (diffs.length === 1) {
    const d = diffs[0];
    const { label, body } = patchBlock(d, focusPaths, knownRepos);
    return `${diffHeader(d)}

---
${label}

\`\`\`diff
${body}
\`\`\``;
  }
  return diffs
    .map((d, i) => {
      const { label, body } = patchBlock(d, focusPaths, knownRepos);
      return `### COMMIT ${i + 1} of ${diffs.length}
${diffHeader(d)}

${label}

\`\`\`diff
${body}
\`\`\``;
    })
    .join("\n\n---\n\n");
}

export function buildInvestigatePrompt(input: RunCommitReviewInput): string {
  const { diffs } = input;
  const truncationNote = diffs.some((d) => d.truncated)
    ? "\n\nNote: one or more patches were truncated to fit. Use the file lists + your read/grep tools to see anything not shown."
    : "";

  // Named per commit, with its repo: at more than one repo there is no single
  // "the working tree", so one shared head sha would be wrong for every commit
  // that didn't come from that repo.
  const old = diffs.filter(isOldCommit);
  const headWarning =
    old.length > 0
      ? `\n\n> ${old
          .map((d) => `\`${d.shortSha}\` (${d.repoName}, tree at \`${d.headSha}\`)`)
          .join(", ")} predate${old.length === 1 ? "s" : ""} the working tree. Your tools read the CURRENT tree, which may differ from those commits' state — see the working-tree caveat in your instructions.`
      : "";

  const spannedRepos = [...new Set(diffs.map((d) => d.repoName))];
  const spanNote =
    spannedRepos.length > 1
      ? `\n\n> These changes span ${spannedRepos.length} repos (${spannedRepos.join(", ")}) and are reviewed as ONE change. A bug can live in the seam between them — a caller in one repo against a contract changed in another — so trace across the boundary, not just within each repo.`
      : "";

  const noTools =
    input.repos.length > 0
      ? ""
      : "\n\n> No code-search tools are available this run (code search is off in Settings). Review the diff in isolation; you cannot grep callers or verify blast radius, so keep confidence modest and don't claim cross-file effects you can't see.";

  const contextText = formatContextBlocks(input.contextBlocks);
  const contextSection = contextText
    ? `\n\n---\nCONTEXT PROVIDED BY THE DEVELOPER (the ticket / requirements / standards):\n${contextText}`
    : "";

  return `${commitSections(diffs, input.repos.map((r) => r.name))}${truncationNote}${headWarning}${spanNote}${noTools}${contextSection}

Investigate ${diffs.length > 1 ? "these commits'" : "this commit's"} change and its blast radius, then return the findings JSON.`;
}

/** Verify's user turn. The candidates ARE the task here, so the diff is scoped
 *  to the files they cite instead of re-sent whole: the change was already paid
 *  for once by the investigate pass, and verify re-sends its prompt on every one
 *  of its agentic steps. */
export function buildVerifyPrompt(
  input: RunCommitReviewInput,
  candidates: CandidateFinding[],
): string {
  const { diffs } = input;
  const contextText = formatContextBlocks(input.contextBlocks);
  const contextSection = contextText
    ? `\n\n---\nDEVELOPER CONTEXT (ticket / requirements):\n${contextText}`
    : "";
  return `${commitSections(
    diffs,
    input.repos.map((r) => r.name),
    focusPathsFromCandidates(candidates),
  )}${contextSection}

---
CANDIDATE FINDINGS from the first pass — verify each by trying to refute it, then return verdicts keyed by id:

${JSON.stringify(candidates, null, 2)}`;
}

// The two-stage Commit Review engine: Investigate → Verify → merge.
// Both stages funnel through the shared task runner with read-only tools at
// temperature 0. See commitReviewPrompts.ts for the strategy rationale.

import { SURFACE_STEP_CAPS, type ModelId } from "@/modules/ai/config";
import { type ProviderKeys } from "@/modules/ai/lib/keyring";
import { runTask, streamTask } from "@/modules/ai/lib/taskRunner";
import type { LocalProviderConfig } from "@/modules/ai/lib/agent";
import { buildSuiteChatTools } from "@/modules/test-plans/lib/suiteChatTools";
import {
  collectContextImages,
  formatContextBlocks,
  type ContextBlock,
} from "@/modules/ai/lib/contextBlocks";
import { type Attachment } from "@/components/chat/attachments";
import type { ActivityEntry } from "@/modules/generator/lib/activityLog";
import type { CommitDiff } from "./gitCommitApi";
import {
  Stage1Schema,
  Stage2Schema,
  compareFindings,
  type Finding,
} from "./schema";
import {
  investigateSystemPrompt,
  verifySystemPrompt,
} from "./commitReviewPrompts";

export type RunStage = "investigate" | "verify";

export type RunCommitReviewInput = {
  modelId: ModelId;
  keys: ProviderKeys;
  local?: LocalProviderConfig;
  /** Local checkout the Read/Glob/Grep tools read. null ⇒ code search is off;
   *  the review then works from the diff alone (degraded — see the pane warning). */
  sourceRoot: string | null;
  /** The selected commits' diffs + metadata, from `git_commit_diff`. One entry
   *  is the common case; multiple are reviewed together as one combined change. */
  diffs: CommitDiff[];
  /** Best-practices + ticket/work-item context, already assembled by the store. */
  contextBlocks: ContextBlock[];
  /** Image attachments (screenshots of a ticket, etc.) for vision input. */
  attachments: Attachment[];
  customInstructions?: string;
  onToolEvent?: (e: ActivityEntry) => void;
  /** Fired as the engine moves between stages so the pane can label the wait. */
  onStage?: (stage: RunStage) => void;
  signal?: AbortSignal;
};

export type RunCommitReviewResult =
  | { ok: true; findings: Finding[]; durationMs: number }
  | {
      /** Stage 1 didn't return parseable findings — surface the raw text. */
      ok: false;
      reason: "schema_violation";
      rawText: string;
      durationMs: number;
    };

/** Soft ceiling on the combined raw-patch size fed to the model in one review.
 *  Each commit's patch is capped at 30 KiB (PATCH_MAX_BYTES in git.rs), sized
 *  so a single diff plus the system prompt fits the cheaper BYOK models. A
 *  multi-commit review concatenates them unbounded, so past this combined size
 *  the prompt risks overflowing the model's context or exhausting the step caps
 *  and degrading (or failing) silently. Advisory only — the pane warns, the run
 *  still proceeds. */
export const COMBINED_DIFF_WARN_BYTES = 96 * 1024;

/** Combined size of the raw patch text across the given diffs — a proxy for the
 *  diff portion of the review prompt, used to warn on oversized multi-selects. */
export function combinedPatchBytes(diffs: CommitDiff[]): number {
  return diffs.reduce(
    (sum, d) => sum + new TextEncoder().encode(d.rawPatch).length,
    0,
  );
}

export async function runCommitReview(
  input: RunCommitReviewInput,
): Promise<RunCommitReviewResult> {
  const tools = buildSuiteChatTools(input.sourceRoot);
  const contextImages = collectContextImages(input.contextBlocks);
  const attachments = [...input.attachments, ...contextImages];

  // --- Stage 1: investigate ------------------------------------------------
  input.onStage?.("investigate");
  const stage1 = await streamTask({
    modelId: input.modelId,
    keys: input.keys,
    local: input.local ?? {},
    systemPrompt: investigateSystemPrompt(input.diffs.length),
    customInstructions: input.customInstructions,
    prompt: buildInvestigatePrompt(input),
    attachments,
    tools: tools ?? null,
    temperature: 0,
    maxSteps: SURFACE_STEP_CAPS.commitReviewInvestigate,
    schema: Stage1Schema,
    onToolEvent: input.onToolEvent,
    signal: input.signal,
    // We don't render the streamed JSON; findings appear when the run resolves.
    onText: () => {},
  });

  if (!stage1.ok) {
    return {
      ok: false,
      reason: "schema_violation",
      rawText: stage1.text,
      durationMs: stage1.durationMs,
    };
  }

  const candidates = stage1.object.findings;
  // Clean commit — skip the verify pass entirely (no false positives to filter).
  if (candidates.length === 0) {
    return { ok: true, findings: [], durationMs: stage1.durationMs };
  }

  // --- Stage 2: verify / filter -------------------------------------------
  input.onStage?.("verify");
  const stage2 = await runTask({
    modelId: input.modelId,
    keys: input.keys,
    local: input.local ?? {},
    systemPrompt: verifySystemPrompt(input.diffs.length),
    customInstructions: input.customInstructions,
    prompt: buildVerifyPrompt(input, candidates),
    attachments,
    tools: tools ?? null,
    temperature: 0,
    maxSteps: SURFACE_STEP_CAPS.commitReviewVerify,
    schema: Stage2Schema,
    onToolEvent: input.onToolEvent,
    signal: input.signal,
  });

  const totalMs = stage1.durationMs + stage2.durationMs;

  // Verify failed to parse → fall back to the unfiltered candidates rather
  // than dropping everything; the confidence filter in the UI still applies.
  if (!stage2.ok) {
    const findings: Finding[] = candidates
      .map((c) => ({ ...c, verified: false }))
      .sort(compareFindings);
    return { ok: true, findings, durationMs: totalMs };
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

function diffHeader(diff: CommitDiff): string {
  const totalAdds = diff.files.reduce((s, f) => s + f.additions, 0);
  const totalDels = diff.files.reduce((s, f) => s + f.deletions, 0);
  const fileList = diff.files
    .map(
      (f) =>
        `- ${f.status.toUpperCase()}: ${f.path}  (+${f.additions} / -${f.deletions})`,
    )
    .join("\n");
  if (diff.isLocal) {
    return `**Working tree:** uncommitted local changes (staged + unstaged + new files, vs HEAD)
**Files changed:** ${diff.files.length}  (+${totalAdds} / -${totalDels})

${fileList || "_(no changes)_"}`;
  }
  const merge = diff.isMerge
    ? " (merge commit — diff is vs its first parent)"
    : diff.isRoot
      ? " (root commit — full initial content)"
      : "";
  return `**Commit:** \`${diff.shortSha}\` — ${diff.subject}${merge}
**Author:** ${diff.author}  ·  **Date:** ${diff.date}
**Files changed:** ${diff.files.length}  (+${totalAdds} / -${totalDels})

${fileList || "_(no per-file stats — empty commit?)_"}`;
}

/** True when a commit predates the working tree (its tools read a newer HEAD).
 *  Compares on a fixed 7-char prefix so it's robust to differing abbreviation
 *  lengths or Rust returning a full headSha. */
export function isOldCommit(diff: CommitDiff): boolean {
  return (
    // The local-changes diff is always against the live HEAD — never "old".
    !diff.isLocal &&
    !!diff.headSha &&
    !!diff.shortSha &&
    diff.shortSha.slice(0, 7) !== diff.headSha.slice(0, 7)
  );
}

/** Each commit's metadata + raw patch, as one labelled section per commit. */
function commitSections(diffs: CommitDiff[]): string {
  if (diffs.length === 1) {
    const d = diffs[0];
    const patchLabel = d.isLocal
      ? "RAW PATCH (all uncommitted changes):"
      : "RAW PATCH (this commit's own change):";
    return `${diffHeader(d)}

---
${patchLabel}

\`\`\`diff
${d.rawPatch || "(empty)"}
\`\`\``;
  }
  return diffs
    .map(
      (d, i) => `### COMMIT ${i + 1} of ${diffs.length}
${diffHeader(d)}

RAW PATCH (this commit's own change):

\`\`\`diff
${d.rawPatch || "(empty)"}
\`\`\``,
    )
    .join("\n\n---\n\n");
}

export function buildInvestigatePrompt(input: RunCommitReviewInput): string {
  const { diffs } = input;
  const truncationNote = diffs.some((d) => d.truncated)
    ? "\n\nNote: one or more patches were truncated to fit. Use the file lists + your read/grep tools to see anything not shown."
    : "";

  const headWarning = diffs.some(isOldCommit)
    ? `\n\n> Some reviewed commit(s) predate the working tree (at \`${diffs[0]?.headSha}\`). Your tools read the CURRENT tree, which may differ from those commits' state — see the working-tree caveat in your instructions.`
    : "";

  const noTools = input.sourceRoot
    ? ""
    : "\n\n> No code-search tools are available this run (code search is off in Settings). Review the diff in isolation; you cannot grep callers or verify blast radius, so keep confidence modest and don't claim cross-file effects you can't see.";

  const contextText = formatContextBlocks(input.contextBlocks);
  const contextSection = contextText
    ? `\n\n---\nCONTEXT PROVIDED BY THE DEVELOPER (the ticket / requirements / standards):\n${contextText}`
    : "";

  return `${commitSections(diffs)}${truncationNote}${headWarning}${noTools}${contextSection}

Investigate ${diffs.length > 1 ? "these commits'" : "this commit's"} change and its blast radius, then return the findings JSON.`;
}

function buildVerifyPrompt(
  input: RunCommitReviewInput,
  candidates: unknown,
): string {
  const { diffs } = input;
  const contextText = formatContextBlocks(input.contextBlocks);
  const contextSection = contextText
    ? `\n\n---\nDEVELOPER CONTEXT (ticket / requirements):\n${contextText}`
    : "";
  return `${commitSections(diffs)}${contextSection}

---
CANDIDATE FINDINGS from the first pass — verify each by trying to refute it, then return verdicts keyed by id:

${JSON.stringify(candidates, null, 2)}`;
}

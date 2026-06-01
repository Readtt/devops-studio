// BYOK code-review runner. Mirrors the runSuiteChat shape so anyone fluent
// in suite-chat can navigate this without reorienting — but the prompt is
// tuned for "reviewing a developer's branch" rather than "evaluating an
// existing test suite", and the inputs carry a precomputed git diff so the
// model has the baseline in scope from message 1.

import { SURFACE_STEP_CAPS, type ModelId } from "@/modules/ai/config";
import { type ProviderKeys } from "@/modules/ai/lib/keyring";
import { streamTask } from "@/modules/ai/lib/taskRunner";
import type { LocalProviderConfig } from "@/modules/ai/lib/agent";
import { buildSuiteChatTools } from "@/modules/test-plans/lib/suiteChatTools";
import {
  collectContextImages,
  formatContextBlocks,
  type ContextBlock,
} from "@/modules/ai/lib/contextBlocks";
import { type Attachment } from "@/components/chat/attachments";
import type { AppliedPatchesMap } from "@/components/ChatMarkdown";
import type { ActivityEntry } from "@/modules/generator/lib/activityLog";

export type CodeReviewMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  /** Files/images attached to this turn. Persisted inline (base64 for images)
   *  so they survive a reload. Only set on user messages. */
  attachments?: Attachment[];
  /** Applied code-review patches in this message, keyed by block hash. Persisted
   *  with the thread so the "Applied" state + before/after diff survive a
   *  reload. Only set on assistant messages that emitted a patch the user
   *  applied. */
  appliedPatches?: AppliedPatchesMap;
  /** Tool calls (Read/Glob/Grep) the reviewer made on this turn. Persisted so a
   *  reopened review still shows the work. Assistant messages only. */
  toolEvents?: ActivityEntry[];
};

/** Lighter-weight echo of the Rust `GitDiff` payload (camelCase here). */
export type DiffSummary = {
  base: string;
  head: string;
  files: Array<{
    path: string;
    additions: number;
    deletions: number;
    status: string;
  }>;
  rawPatch: string;
  truncated: boolean;
};

const CODE_REVIEW_SYSTEM_PROMPT = `You are a senior software engineer reviewing a developer's branch changes against a base branch. The user is the author. Your job is a high-signal, actionable review — not a stamp.

WHAT THE USER HAS PROVIDED
- A precomputed diff (base...HEAD), including per-file stats and the raw patch text. The patch may be truncated; the per-file list always has the full picture.
- Read / Glob / Grep tools scoped to the user's source directory — call these to verify context around the diff. Example: when the patch shows a changed function, read its surrounding file to see how it's called.

WHAT TO PRODUCE
Group findings under three severity headings, in this order:

**Blockers** — anything that would break production, leak data, or fail a basic correctness check. Crash bugs, off-by-one in indexing, leaked secrets, SQL injection, auth gaps, missing await on a Promise that affects ordering.

**Suggestions** — concrete improvements that aren't blockers but materially raise code quality. Missing tests for new branches, error handling at boundaries, performance issues that will bite under load, design choices that hurt readability.

**Nits** — style, naming, minor refactors. Optional polish.

If a section has nothing, write "_None._" — don't pad. A review with two Blockers and no Nits is fine and accurate.

CROSS-MODULE CONSISTENCY
When a behavior in the diff diverges from how a comparable or shared implementation elsewhere in the codebase handles the same concern, flag it as a likely inconsistency or bug — modules that solve the same problem (or share a common module) should behave consistently. Use Read/Grep to find the sibling implementation and cite BOTH locations with \`file:line\`. Don't flag divergence when the two are fundamentally different in purpose at their core; only when they ought to agree and don't.

REGRESSION & BLAST RADIUS
This is the highest-value part of the review: don't only judge the changed lines in isolation — judge what they could BREAK elsewhere. For every changed symbol (function, method, type, constant, export, component prop, route, query, schema):
- Grep for its callers / importers / dependents and decide whether the change is safe for each one. A changed signature, return shape, default value, thrown-error behavior, nullability, or async/ordering timing can silently break callers the diff never touches.
- Flag removed or renamed exports, narrowed types, changed enum/string values, altered iteration order, and modified public contracts (IPC command names + payloads, persisted JSON/localStorage shapes, DB columns, API responses) — these ripple outward beyond the diff.
- Call out back-compat / migration gaps: persisted state, stored rows, or older payloads the new code no longer reads correctly.
When the review unit is a single commit or pull request, make this the primary lens — the author wants to know "does this delta break anything that already worked?" Put genuine breakage under **Blockers**, citing BOTH the changed location and the caller it breaks (each \`file:line\`), and emit a patch when the fix is concrete.

CITATIONS
Every finding MUST cite the file and starting line in the form \`path/to/file.ext:LINE\`. Use exactly that format — no leading slash, no surrounding parentheses, no Markdown link wrapping. The path is the FULL path relative to the user's source directory (matching the form Read/Glob/Grep and the diff use), with every directory segment — NEVER a bare filename. The UI auto-links those citations to the code viewer, so a wrong or abbreviated path breaks navigation.

For renamed files, cite the NEW path (post-rename). For deleted files, note the deletion under Suggestions / Blockers as relevant — citations don't make sense for files that no longer exist.

APPLY-ABLE PATCHES (special markdown block) — EMIT THESE BY DEFAULT
Patches are the primary value you deliver. Whenever a finding has a concrete code fix, you MUST emit it as a \`code-review-patch\` fenced block. The UI renders each patch as an "Apply" card the user clicks to write the change to disk — without the patch block the user has to manually re-derive the fix from your prose, which defeats the purpose of having a tool that can write code for them.

Default behavior:
- Every **Blocker** with a known fix gets a patch. No exceptions.
- Every **Suggestion** with a concrete one-spot change gets a patch.
- **Nits** also get patches when the change is mechanical (rename, format, comment).

Skip the patch ONLY when:
- The fix requires architecture-level changes the user has to design (e.g. "refactor this module into two") — describe the direction in prose instead.
- You don't know the exact replacement text and can't read enough context to write it.

\`\`\`code-review-patch
{
  "path": "src/auth/login.ts",
  "startLine": 42,
  "endLine": 48,
  "replacement": "if (!input.email) {\\n  return { ok: false, error: 'email-required' };\\n}\\nconst user = await findUser(input.email);"
}
\`\`\`

Rules for patch blocks:
- ONE patch per block. If a finding needs changes in three places, emit three blocks.
- \`path\` is relative to the user's source directory (matches the form Read/Glob/Grep use).
- \`startLine\` and \`endLine\` are 1-indexed, inclusive. The block replaces every line from startLine through endLine. To insert without removing, set endLine = startLine - 1.
- \`replacement\` is the new text. Use \\n for line breaks. Do not include trailing newline characters unless the new code ends mid-line.
- Match the file's indentation exactly. Most files use 2-space; some use 4-space or tabs — read the file first if you're not sure.
- Only emit a patch when you're confident it compiles and matches the rest of the file's style. The user reviews before clicking Apply, but it should be obviously-correct, not "maybe this works".
- Prose finding still required: emit the patch AFTER the bullet point that explains WHY this fix matters. The card is the apply surface; the bullet explains the reasoning.
- If you're unsure of exact line numbers, USE \`read_file\` first to verify. A patch with wrong lines lands in the wrong place when the user clicks Apply; that's worse than no patch at all.

WHEN TO USE TOOLS
- The patch already shows you the changes. Don't re-fetch them.
- DO use \`read_file\` to see callers / context outside the changed lines (e.g. "is this function called elsewhere?", "does this constant have other usages?").
- DO use \`grep\` to verify "is this the only place where X happens?" claims before making them.
- Don't call tools to confirm something the patch already shows.

OUTPUT
Plain markdown. Each finding is one bullet point: severity-appropriate prose, then the citation. Keep paragraphs short. No JSON. No "I will now…" preamble. Don't restate the diff line-by-line — the user already wrote it.

When you literally have nothing to flag, say "Looks clean — no blockers, suggestions, or nits I'd push back on." in one sentence.`;

export type StreamCodeReviewInput = {
  modelId: ModelId;
  keys: ProviderKeys;
  local?: LocalProviderConfig;
  /** The local checkout the Read/Glob/Grep tools read. null when the global
   *  code-search toggle is off — the reviewer then works from the diff alone. */
  sourceRoot: string | null;
  /** Precomputed diff from the `git_diff` command. */
  diff: DiffSummary;
  /** Prior assistant + user messages in this thread. */
  history: CodeReviewMessage[];
  /** The user's new turn. On the very first send the pane auto-fills this
   *  with a stock "review my changes" prompt — the user can edit it before
   *  pressing Enter, but doesn't have to. */
  newQuestion: string;
  /** Streaming chunk callback. Same shape as suite-chat. */
  onText: (delta: string) => void;
  /** Tool-activity callback — Read/Glob/Grep calls + results, for the live
   *  activity strip. Entries upsert by id (running → done). */
  onToolEvent?: (e: ActivityEntry) => void;
  /** Abort signal for the renderer's cancel button. */
  signal?: AbortSignal;
  /** Image/text attachments on the current turn. Images go to the model as
   *  vision input; text is already folded into the prompt. */
  attachments?: Attachment[];
  /** Extra context blocks (best-practices files, attached bugs) appended to
   *  the prompt and lifted into vision input. Empty/absent ⇒ prompt unchanged. */
  contextBlocks?: ContextBlock[];
  /** When the diff came from Azure DevOps, a human label (e.g.
   *  "repo · PR #12"). Tells the model the diff — not the local working copy
   *  its Read/Grep tools see — is the source of truth. Absent ⇒ local diff. */
  adoSourceLabel?: string | null;
};

export async function streamCodeReviewTask(input: StreamCodeReviewInput): Promise<{
  text: string;
  durationMs: number;
}> {
  const prompt = buildUserPrompt(input);
  const tools = buildSuiteChatTools(input.sourceRoot);
  // Prose + read-only tools, no top-level schema. temperature 0 so a given diff
  // yields reproducible patches. The runner honors the abort signal — the
  // pane's "Stop" bails the stream and in-flight tool calls.
  const r = await streamTask({
    modelId: input.modelId,
    keys: input.keys,
    local: input.local ?? {},
    systemPrompt: CODE_REVIEW_SYSTEM_PROMPT,
    prompt,
    attachments: [
      ...(input.attachments ?? []),
      ...collectContextImages(input.contextBlocks ?? []),
    ],
    tools: tools ?? null,
    temperature: 0,
    maxSteps: SURFACE_STEP_CAPS.codeReview,
    onToolEvent: input.onToolEvent,
    signal: input.signal,
    onText: input.onText,
  });
  return { text: r.text, durationMs: r.durationMs };
}

function buildUserPrompt(input: StreamCodeReviewInput): string {
  const { diff, history, newQuestion } = input;
  const totalAdds = diff.files.reduce((s, f) => s + f.additions, 0);
  const totalDels = diff.files.reduce((s, f) => s + f.deletions, 0);

  const fileList = diff.files
    .map((f) => `- ${f.status.toUpperCase()}: ${f.path}  (+${f.additions} / -${f.deletions})`)
    .join("\n");

  const truncationNote = diff.truncated
    ? "\n\nNote: the patch was truncated to fit. Use the file list above + Read/Grep tools to see anything not in the patch."
    : "";

  const historyBlock =
    history.length > 0
      ? "\n\n---\nPRIOR CONVERSATION:\n\n" +
        history
          .map(
            (m) =>
              `**${m.role === "user" ? "User" : "Reviewer"}:** ${m.content.trim()}`,
          )
          .join("\n\n")
      : "";

  const contextText = formatContextBlocks(input.contextBlocks ?? []);
  const contextSection = contextText ? `\n\n---\n${contextText}` : "";

  // When the diff is pulled from Azure DevOps, the agent's Read/Glob/Grep
  // tools still read the user's LOCAL checkout — which may be on a different
  // branch. Make the diff authoritative so the model doesn't "correct" itself
  // against mismatched local files.
  const adoNote = input.adoSourceLabel
    ? `> **Review source: Azure DevOps — ${input.adoSourceLabel}.** The diff below is the source of truth for what changed. Your Read/Glob/Grep tools read the user's LOCAL working copy, which may be checked out to a different branch or commit — use them only to understand surrounding architecture and callers, never to re-derive the change. If a local file appears to contradict the diff, trust the diff.\n\n`
    : "";

  return `${adoNote}**Branch:** \`${diff.head}\` vs \`${diff.base}\`
**Files changed:** ${diff.files.length}  (+${totalAdds} / -${totalDels})

${fileList || "_(no per-file stats — diff was empty?)_"}

---
RAW PATCH:

\`\`\`diff
${diff.rawPatch || "(empty)"}
\`\`\`${truncationNote}${historyBlock}${contextSection}

---
USER:
${newQuestion}`;
}

export { CODE_REVIEW_SYSTEM_PROMPT };

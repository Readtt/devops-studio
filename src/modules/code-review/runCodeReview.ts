// BYOK code-review runner. Mirrors the runSuiteChat shape so anyone fluent
// in suite-chat can navigate this without reorienting — but the prompt is
// tuned for "reviewing a developer's branch" rather than "evaluating an
// existing test suite", and the inputs carry a precomputed git diff so the
// model has the baseline in scope from message 1.
//
// We deliberately ship only the Vercel SDK path in v1. The Claude CLI path
// can be added later by mirroring runSuiteChatClaude — the Read/Glob/Grep
// tool surface here is already byok-compatible with what the CLI offers.

import { stepCountIs, streamText } from "ai";
import { getModel, type ModelId } from "@/modules/ai/config";
import { buildLanguageModel } from "@/modules/ai/lib/agent";
import type { ProviderKeys } from "@/modules/ai/lib/keyring";
import { buildSuiteChatTools } from "@/modules/test-plans/lib/suiteChatTools";
import { buildUserTurn } from "@/modules/ai/lib/visionMessage";
import {
  collectContextImages,
  formatContextBlocks,
  type ContextBlock,
} from "@/modules/ai/lib/contextBlocks";
import type { Attachment } from "@/components/chat/attachments";

export type CodeReviewMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  /** Files/images attached to this turn. Persisted inline (base64 for images)
   *  so they survive a reload. Only set on user messages. */
  attachments?: Attachment[];
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

CITATIONS
Every finding MUST cite the file and starting line in the form \`path/to/file.ext:LINE\`. Use exactly that format — no leading slash, no surrounding parentheses, no Markdown link wrapping. The UI auto-links those citations to the code viewer, so getting the format wrong breaks navigation.

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
  sourceRoot: string;
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
  /** Abort signal for the renderer's cancel button. */
  signal?: AbortSignal;
  /** Image/text attachments on the current turn. Images go to the model as
   *  vision input; text is already folded into the prompt. */
  attachments?: Attachment[];
  /** Extra context blocks (best-practices files, attached bugs) appended to
   *  the prompt and lifted into vision input. Empty/absent ⇒ prompt unchanged. */
  contextBlocks?: ContextBlock[];
};

export async function streamCodeReview(input: StreamCodeReviewInput): Promise<{
  text: string;
  durationMs: number;
}> {
  const model = getModel(input.modelId);
  const lm = await buildLanguageModel(model.provider, input.keys, model.id, {});
  const tools = buildSuiteChatTools(input.sourceRoot);
  const prompt = buildUserPrompt(input);
  const start = Date.now();
  // streamText accepts abortSignal for cooperative cancellation. The pane's
  // "Stop" button drives this — when the user hits it, in-flight tool calls
  // and the model stream both bail.
  const result = streamText({
    model: lm,
    system: CODE_REVIEW_SYSTEM_PROMPT,
    ...buildUserTurn(prompt, [
      ...(input.attachments ?? []),
      ...collectContextImages(input.contextBlocks ?? []),
    ]),
    abortSignal: input.signal,
    ...(tools ? { tools, stopWhen: stepCountIs(10) } : {}),
  });
  let acc = "";
  for await (const chunk of result.textStream) {
    acc += chunk;
    input.onText(chunk);
  }
  return { text: acc, durationMs: Date.now() - start };
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

  return `**Branch:** \`${diff.head}\` vs \`${diff.base}\`
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

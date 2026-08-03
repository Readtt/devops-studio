// Free-text Q&A about the current draft. Distinct from refine() — the chat
// path returns markdown the user reads inline; it never rewrites the draft.

import {
  SURFACE_STEP_CAPS,
  SURFACE_TOKEN_BUDGETS,
  type ModelId,
} from "@/modules/ai/config";
import { type LocalProviderConfig } from "@/modules/ai/lib/agent";
import { streamTask } from "@/modules/ai/lib/taskRunner";
import { buildSuiteChatTools } from "@/modules/test-plans/lib/suiteChatTools";
import type { ProviderKeys } from "@/modules/ai/lib/keyring";
import type { ReviewedBug, ReviewedCase } from "./draftBatchSchema";
import {
  renderAttachmentBlocks,
  renderChangesetsBlock,
  renderTargetContext,
  type RunAttachment,
  type TargetContext,
} from "./qaAnalystRun";
import {
  collectContextImages,
  formatContextBlocks,
  type ContextBlock,
} from "@/modules/ai/lib/contextBlocks";
import type { ActivityEntry } from "./activityLog";

/** One message in the review-pane chat thread. */
export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  /** Markdown — the assistant returns prose with bullets / code fences,
   *  the user types whatever they want. */
  content: string;
  /** ISO-8601 timestamp the message was created. */
  timestamp: string;
  /** Tool calls (Read/Glob/Grep) the model made on this turn — Claude CLI path
   *  only (the BYOK path here is text-only). Persisted with the draft chat so a
   *  reopened session still shows them. Assistant messages only. */
  toolEvents?: ActivityEntry[];
};

export const CHAT_SYSTEM_PROMPT = `You are a senior QA test analyst chatting with the user about a draft test plan they have on screen. The plan was already generated; this conversation is for *understanding and improving* the draft, NOT for editing it. The user has a separate "refine" action when they want changes applied.

ROLE
- Be terse and specific. The user is a senior QA tester — they don't need
  hand-holding.
- Ground every answer in the spec + the current draft. Reference case titles
  exactly when relevant ("the [Auth] case about TOTP rotation …").
- Suggest edits freely, but make it clear the user has to use Refine to
  apply them. Don't pretend to have changed the draft yourself.
- Don't claim things you can't verify. If asked "do all test cases pass?",
  explain that passing requires running the cases against a build — you
  can only review whether the case definitions look sound.
- It's fine to point out gaps in coverage, missing edge cases, weak
  assertions, or vague step language. That's the whole point.

OUTPUT
- Plain markdown. Bullet lists, short paragraphs, fenced code when quoting
  source. No JSON. No HTML.
- When source access is available you have read-only Read / Glob / Grep tools
  plus a read-only shell (run_command: \`git log\` / \`git show\` / \`git blame\` /
  \`cat\` / \`rg\`, one command per call, writes refused) — use them to ground
  answers in the actual code and its recent history rather than guessing.
- When you point at a source file, write the citation as bare text in the form
  path/to/file.ext:LINE (or :START-END) — the FULL path relative to the source
  directory (every directory segment, exactly as the tools reported it), forward
  slashes, no leading slash, no parentheses, never a bare filename. The UI
  auto-links it to the in-app code viewer, so the user can click straight to it.
- Keep responses under ~12 lines unless the user asks for depth.`;

export type ChatRunInput = {
  /** The same spec the analyst ran against — full ground truth. */
  requirements: string;
  /** Same scope hint as the analyst. Helps the chat understand WHY a case
   *  might be missing ("the changeset said styling only…"). */
  changesets?: string;
  attachments: RunAttachment[];
  /** The CURRENT review-phase draft. Stripped of UI-only fields by the
   *  caller — the chat just needs to know what cases / bugs exist. */
  cases: ReviewedCase[];
  bugs: ReviewedBug[];
  targetContext?: TargetContext | null;
  /** Prior messages, oldest-first. Stays small in practice (the popover
   *  panel doesn't scroll past ~50 turns); we pass them verbatim so the
   *  model has full conversation memory. */
  history: ChatMessage[];
  /** The user's new question — already pushed onto history by the store
   *  before the run starts, but passed separately so the prompt builder
   *  has it on hand without re-walking the array. */
  newQuestion: string;
  /** Extra context blocks (best-practices files, attached bugs) appended to
   *  the prompt and lifted into vision input. Empty/absent ⇒ prompt unchanged. */
  contextBlocks?: ContextBlock[];
  /** Tool-activity callback for the live strip. Entries upsert by id. */
  onToolEvent?: (e: ActivityEntry) => void;
  /** Source directory for the read-only tools. null ⇒ run tool-less (code
   *  search disabled or no source set). */
  sourceRoot?: string | null;
};

export type ChatRunResult = {
  text: string;
  durationMs: number;
};

// --- Runner entrypoint ------------------------------------------------------

export type ChatTaskInput = ChatRunInput & {
  modelId: ModelId;
  keys: ProviderKeys;
  local?: LocalProviderConfig;
  /** User's freeform "Custom instructions" from Settings — appended to the
   *  system prompt on every surface. Empty/absent ⇒ base prompt unchanged. */
  customInstructions?: string;
  /** Abort handle threaded into the shared runner — cancelling actually stops
   *  the provider request (and billing), it doesn't just discard the result. */
  signal?: AbortSignal;
};

/** Streaming draft-chat run. Calls `onText` with each delta as the model
 *  produces it; resolves with the full accumulated text. Mirrors
 *  streamSuiteChatTask so the review-pane "Ask" reads tokens live like every
 *  other chat surface in the app. */
export async function streamChatTask(
  input: ChatTaskInput & { onText: (delta: string) => void },
): Promise<ChatRunResult> {
  // Route through the SHARED task runner like every other surface (Suite Chat,
  // Code Review, Confidence) so the Ask gets the same read-only source tools,
  // live tool-call strip, and citation grounding — previously it called
  // streamText directly with no tools, which is why tool calls never showed
  // and source citations couldn't be grounded in real code.
  const userPrompt = buildChatUserPrompt(input);
  const tools = buildSuiteChatTools(input.sourceRoot ?? null);
  const r = await streamTask({
    modelId: input.modelId,
    keys: input.keys,
    local: input.local,
    systemPrompt: CHAT_SYSTEM_PROMPT,
    customInstructions: input.customInstructions,
    prompt: userPrompt,
    attachments: [
      ...input.attachments,
      ...collectContextImages(input.contextBlocks ?? []),
    ],
    tools: tools ?? null,
    // Explicit, not inherited. This surface used to name neither, so it silently
    // ran on the runner's MAX_AGENT_STEPS fallback with no entry in either
    // surface table — a budget by accident. It reads the same code with the same
    // tools as Suite Chat, so it gets Suite Chat's numbers.
    maxSteps: SURFACE_STEP_CAPS.draftChat,
    tokenBudget: SURFACE_TOKEN_BUDGETS.draftChat,
    onText: input.onText,
    onToolEvent: input.onToolEvent,
    signal: input.signal,
  });
  return { text: r.text, durationMs: r.durationMs };
}

// --- Shared user-prompt builder --------------------------------------------

function buildChatUserPrompt(input: ChatRunInput): string {
  const targetBlock = renderTargetContext(input.targetContext);
  const changesetsBlock = renderChangesetsBlock(input.changesets);
  const draftBlock = renderDraftBlock(input.cases, input.bugs);
  const historyBlock = renderHistoryBlock(input.history);
  const contextText = formatContextBlocks(input.contextBlocks ?? []);
  const attached =
    input.attachments.length === 0
      ? ""
      : "\n\nAttachments:\n\n" + renderAttachmentBlocks(input.attachments);

  return [
    targetBlock,
    "ORIGINAL SPEC (ground truth):",
    input.requirements.trim() || "(no spec provided)",
    "",
    changesetsBlock || null,
    changesetsBlock ? "" : null,
    "CURRENT DRAFT (what the user is looking at right now):",
    draftBlock,
    "",
    historyBlock,
    historyBlock ? "" : null,
    contextText || null,
    contextText ? "" : null,
    "USER:",
    input.newQuestion.trim(),
    attached,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function renderDraftBlock(cases: ReviewedCase[], bugs: ReviewedBug[]): string {
  if (cases.length === 0 && bugs.length === 0) {
    return "(empty draft — no cases or bugs generated yet)";
  }
  const lines: string[] = [];
  if (cases.length > 0) {
    lines.push(`Cases (${cases.length}):`);
    for (const c of cases) {
      const status = c.decision === "keep" ? "KEEP" : "skip";
      lines.push(`  [${status}] ${c.title}`);
      if (c.rationale) lines.push(`    rationale: ${c.rationale}`);
      for (const s of c.steps) {
        lines.push(`    - ${s.action} → ${s.expected}`);
      }
    }
  }
  if (bugs.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(`Bug suggestions (${bugs.length}):`);
    for (const b of bugs) {
      const status = b.decision === "keep" ? "KEEP" : "skip";
      lines.push(`  [${status}] ${b.title} (severity: ${b.severity})`);
      if (b.reproSteps) {
        // Keep repro steps compact — they're already multiline.
        const compact = b.reproSteps.split("\n").join(" ");
        lines.push(
          `    ${compact.length > 220 ? compact.slice(0, 219) + "…" : compact}`,
        );
      }
    }
  }
  return lines.join("\n");
}

function renderHistoryBlock(history: ChatMessage[]): string {
  if (history.length === 0) return "";
  const lines: string[] = ["PRIOR CONVERSATION:"];
  for (const m of history) {
    lines.push(`${m.role === "user" ? "USER" : "ASSISTANT"}:`);
    lines.push(m.content);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

let chatMsgCounter = 0;
/** Stable id for a new chat message. Not cryptographic — just unique per
 *  session so React lists key correctly. */
export function newChatMessageId(): string {
  return `chat-${Date.now().toString(36)}-${(chatMsgCounter++).toString(36)}`;
}

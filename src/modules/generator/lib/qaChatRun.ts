// Free-text Q&A about the current draft. Distinct from refine() — the chat
// path returns markdown the user reads inline; it never rewrites the draft.

import { generateText, streamText } from "ai";
import { getModel, type ModelId } from "@/modules/ai/config";
import { buildLanguageModel } from "@/modules/ai/lib/agent";
import type { ProviderKeys } from "@/modules/ai/lib/keyring";
import type { ReviewedBug, ReviewedCase } from "./draftBatchSchema";
import {
  formatAttachmentBlock,
  renderChangesetsBlock,
  renderTargetContext,
  type RunAttachment,
  type TargetContext,
} from "./qaAnalystRun";
import { buildUserTurn } from "@/modules/ai/lib/visionMessage";
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
- When you point at a source file, write the citation as bare text in the form
  path/to/file.ext:LINE (or :START-END) — relative path, forward slashes, no
  leading slash, no parentheses. The UI auto-links it to the in-app code viewer,
  so the user can click straight to it.
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
  /** Tool-activity callback for the live strip (Claude CLI path only — the
   *  Vercel path here runs without tools). Entries upsert by id. */
  onToolEvent?: (e: ActivityEntry) => void;
};

export type ChatRunResult = {
  text: string;
  durationMs: number;
};

// --- Vercel SDK path (any provider) -----------------------------------------

export type ChatTaskInput = ChatRunInput & {
  modelId: ModelId;
  keys: ProviderKeys;
  lmstudioBaseURL?: string;
};

export async function runChatTask(input: ChatTaskInput): Promise<ChatRunResult> {
  const model = getModel(input.modelId);
  const lm = await buildLanguageModel(model.provider, input.keys, model.id, {
    lmstudioBaseURL: input.lmstudioBaseURL,
  });
  const userPrompt = buildChatUserPrompt(input);
  const start = Date.now();
  const result = await generateText({
    model: lm,
    system: CHAT_SYSTEM_PROMPT,
    ...buildUserTurn(userPrompt, [
      ...input.attachments,
      ...collectContextImages(input.contextBlocks ?? []),
    ]),
  });
  return { text: result.text ?? "", durationMs: Date.now() - start };
}

/** Streaming variant of runChatTask. Calls `onText` with each delta as the
 *  model produces it; resolves with the full accumulated text. Mirrors
 *  streamSuiteChatTask so the review-pane "Ask" reads tokens live like every
 *  other chat surface in the app. */
export async function streamChatTask(
  input: ChatTaskInput & { onText: (delta: string) => void },
): Promise<ChatRunResult> {
  const model = getModel(input.modelId);
  const lm = await buildLanguageModel(model.provider, input.keys, model.id, {
    lmstudioBaseURL: input.lmstudioBaseURL,
  });
  const userPrompt = buildChatUserPrompt(input);
  const start = Date.now();
  const result = streamText({
    model: lm,
    system: CHAT_SYSTEM_PROMPT,
    ...buildUserTurn(userPrompt, [
      ...input.attachments,
      ...collectContextImages(input.contextBlocks ?? []),
    ]),
  });
  let acc = "";
  for await (const chunk of result.textStream) {
    acc += chunk;
    input.onText(chunk);
  }
  return { text: acc, durationMs: Date.now() - start };
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
      : "\n\nAttachments:\n\n" +
        input.attachments.map(formatAttachmentBlock).join("\n\n");

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

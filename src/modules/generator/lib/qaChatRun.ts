// Free-text Q&A about the current draft. Distinct from refine() — the chat
// path returns markdown the user reads inline; it never rewrites the draft.
// Both engines (Vercel SDK + Claude CLI) are supported because users on a
// CLI OAuth session don't have an Anthropic API key for the SDK path.

import { generateText, streamText } from "ai";
import { getModel, type ModelId } from "@/modules/ai/config";
import { buildLanguageModel } from "@/modules/ai/lib/agent";
import { runClaudeQuery, type ClaudeEvent } from "@/modules/ai/lib/claude";
import type { ClaudeAuthMode } from "@/modules/ai/lib/engine";
import { getKey } from "@/modules/ai/lib/keyring";
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
import { imageAttachmentToBase64 } from "@/components/chat/attachments";

/** Lift image attachments into stream-json image blocks for the CLI path. */
function claudeImages(
  attachments: RunAttachment[],
): { mediaType: string; dataBase64: string }[] | undefined {
  const imgs = attachments
    .map(imageAttachmentToBase64)
    .filter((x): x is { mediaType: string; dataBase64: string } => x !== null);
  return imgs.length > 0 ? imgs : undefined;
}

/** One message in the review-pane chat thread. */
export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  /** Markdown — the assistant returns prose with bullets / code fences,
   *  the user types whatever they want. */
  content: string;
  /** ISO-8601 timestamp the message was created. */
  timestamp: string;
};

const CHAT_SYSTEM_PROMPT = `You are a senior QA test analyst chatting with the user about a draft test plan they have on screen. The plan was already generated; this conversation is for *understanding and improving* the draft, NOT for editing it. The user has a separate "refine" action when they want changes applied.

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
};

export type ChatRunResult = {
  text: string;
  durationMs: number;
};

// --- Vercel SDK path (any provider) -----------------------------------------

export type VercelChatInput = ChatRunInput & {
  modelId: ModelId;
  keys: ProviderKeys;
  lmstudioBaseURL?: string;
};

export async function runQaChat(input: VercelChatInput): Promise<ChatRunResult> {
  const model = getModel(input.modelId);
  const lm = await buildLanguageModel(model.provider, input.keys, model.id, {
    lmstudioBaseURL: input.lmstudioBaseURL,
  });
  const userPrompt = buildChatUserPrompt(input);
  const start = Date.now();
  const result = await generateText({
    model: lm,
    system: CHAT_SYSTEM_PROMPT,
    ...buildUserTurn(userPrompt, input.attachments),
  });
  return { text: result.text ?? "", durationMs: Date.now() - start };
}

/** Streaming variant of runQaChat. Calls `onText` with each delta as the
 *  model produces it; resolves with the full accumulated text. Mirrors
 *  streamSuiteChat so the review-pane "Ask" reads tokens live like every
 *  other chat surface in the app. */
export async function streamQaChat(
  input: VercelChatInput & { onText: (delta: string) => void },
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
    ...buildUserTurn(userPrompt, input.attachments),
  });
  let acc = "";
  for await (const chunk of result.textStream) {
    acc += chunk;
    input.onText(chunk);
  }
  return { text: acc, durationMs: Date.now() - start };
}

// --- Claude CLI path --------------------------------------------------------

export type ClaudeChatInput = ChatRunInput & {
  modelId: ModelId;
  sourceRoot: string | null;
  authMode: ClaudeAuthMode;
  bareMode?: boolean;
  /** Run id for cancellation — the caller picks one and stashes it. */
  runId: string;
};

export async function runQaChatClaude(
  input: ClaudeChatInput,
): Promise<ChatRunResult> {
  const env: Record<string, string> = {};
  if (input.authMode === "api-key") {
    const key = await getKey("anthropic");
    if (key) env.ANTHROPIC_API_KEY = key;
  }
  const userPrompt = buildChatUserPrompt(input);
  const start = Date.now();
  const result = await runClaudeQuery({
    runId: input.runId,
    prompt: userPrompt,
    images: claudeImages(input.attachments),
    systemPrompt: CHAT_SYSTEM_PROMPT,
    cwd: input.sourceRoot ?? undefined,
    model: input.modelId,
    permissionMode: "bypassPermissions",
    allowedTools: ["Read", "Glob", "Grep"],
    bare: input.bareMode,
    env,
  });
  return { text: result.text ?? "", durationMs: Date.now() - start };
}

/** Streaming Claude CLI variant. Surfaces each assistant text delta via
 *  `onText`, deduping by message id the same way streamSuiteChatClaude does
 *  (the CLI re-emits consolidated messages). Tool-use blocks are ignored —
 *  the chat only needs the prose. */
export async function streamQaChatClaude(
  input: ClaudeChatInput & { onText: (delta: string) => void },
): Promise<ChatRunResult> {
  const env: Record<string, string> = {};
  if (input.authMode === "api-key") {
    const key = await getKey("anthropic");
    if (key) env.ANTHROPIC_API_KEY = key;
  }
  const userPrompt = buildChatUserPrompt(input);
  const start = Date.now();
  const seenByMsgId = new Map<string, string>();
  const onEvent = (event: ClaudeEvent) => {
    if (event.type !== "assistant") return;
    const msg = event.message as
      | { id?: string; content?: Array<Record<string, unknown>> }
      | undefined;
    const msgId = msg?.id ?? "anon";
    const blocks = msg?.content ?? [];
    let combined = "";
    for (const b of blocks) {
      if (b && (b as { type?: string }).type === "text") {
        combined += (b as { text?: string }).text ?? "";
      }
    }
    const prior = seenByMsgId.get(msgId) ?? "";
    if (combined.length > prior.length && combined.startsWith(prior)) {
      seenByMsgId.set(msgId, combined);
      input.onText(combined.slice(prior.length));
    } else if (combined && combined !== prior) {
      seenByMsgId.set(msgId, combined);
      input.onText(combined);
    }
  };
  const result = await runClaudeQuery(
    {
      runId: input.runId,
      prompt: userPrompt,
      images: claudeImages(input.attachments),
      systemPrompt: CHAT_SYSTEM_PROMPT,
      cwd: input.sourceRoot ?? undefined,
      model: input.modelId,
      permissionMode: "bypassPermissions",
      allowedTools: ["Read", "Glob", "Grep"],
      bare: input.bareMode,
      env,
    },
    onEvent,
  );
  return { text: result.text ?? "", durationMs: Date.now() - start };
}

// --- Shared user-prompt builder --------------------------------------------

function buildChatUserPrompt(input: ChatRunInput): string {
  const targetBlock = renderTargetContext(input.targetContext);
  const changesetsBlock = renderChangesetsBlock(input.changesets);
  const draftBlock = renderDraftBlock(input.cases, input.bugs);
  const historyBlock = renderHistoryBlock(input.history);
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

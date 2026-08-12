// Free-text Q&A about the current draft. Distinct from refine() — the chat
// path returns markdown the user reads inline; it never rewrites the draft.

import {
  RESUME_TOPUP_TOKENS,
  SURFACE_STEP_CAPS,
  SURFACE_TOKEN_BUDGETS,
  type ModelId,
} from "@/modules/ai/config";
import {
  answeredThisTurn,
  finishPassMessages,
  hasToolResult,
  sanitizeTranscript,
  withoutFinishNudge,
} from "@/modules/ai/lib/finishPass";
import type { ModelMessage } from "ai";
import { type LocalProviderConfig } from "@/modules/ai/lib/agent";
import { streamTask } from "@/modules/ai/lib/taskRunner";
import { buildSuiteChatTools } from "@/modules/test-plans/lib/suiteChatTools";
import { REPO_PATH_RULE, renderRepoRoster } from "@/modules/ai/lib/repoPaths";
import type { WorkspaceRepo } from "@/modules/settings/store";
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
import { renderRefineHistory } from "./refineDiff";
import type { RefineRound } from "./history";

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
  /** The MODEL-facing record of this assistant turn: its text, the tool calls
   *  it made, and the results those calls returned, exactly as the provider
   *  emitted them. `toolEvents` is the display twin of this and is not
   *  interchangeable — it's shaped for the activity strip and carries no
   *  toolCallId pairing, so it can't be replayed.
   *
   *  Assistant messages only. Absent ⇒ the turn is replayed as plain text, which
   *  is what every turn used to be. */
  transcript?: ModelMessage[];
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

${REPO_PATH_RULE}

OUTPUT
- Plain markdown. Bullet lists, short paragraphs, fenced code when quoting
  source. No JSON. No HTML.
- When source access is available you have read-only Read / Glob / Grep tools
  plus a read-only shell (run_command: \`git log\` / \`git show\` / \`git blame\` /
  \`cat\` / \`rg\`, one command per call, writes refused) — use them to ground
  answers in the actual code and its recent history rather than guessing.
- When you point at a source file, write the citation as bare text in the form
  <repo>/path/to/file.ext:LINE (or :START-END) — the full repo-prefixed path
  (every directory segment, exactly as the tools reported it), forward slashes,
  no leading slash, no parentheses, never a bare filename. The UI auto-links it
  to the in-app code viewer, so the user can click straight to it.
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
  /** Follow-ups already applied to this draft. The Ask and the Refine dock sit
   *  in the same pane, so "why is case 3 like that?" is usually a question
   *  about a round the user ran — unanswerable from the draft alone. */
  refineRounds?: RefineRound[];
  /** Undo point for the newest round; see RefinePromptInput.lastRefineSnapshot. */
  lastRefineSnapshot?: { cases: ReviewedCase[]; bugs: ReviewedBug[] } | null;
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
  /** Called after every completed step with the turn's transcript so far. The
   *  caller keeps the latest and hangs it on the assistant message, which is
   *  what makes the NEXT turn a continuation instead of a restart. Fed
   *  per-step rather than once at the end so a turn that is cancelled — or
   *  fails — still banks the reads it already paid for. */
  onTranscript?: (messages: ModelMessage[]) => void;
  /** Source repos the read-only tools read. Empty ⇒ run tool-less (code search
   *  disabled or no repos configured). */
  repos?: WorkspaceRepo[];
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

/** The chat prompt plus the repos this turn may read. Same placement as the
 *  analyst's roster — the system prompt, which the finish pass below re-sends
 *  unchanged while the transcript it replays gets compacted. */
function chatSystemPrompt(repos: WorkspaceRepo[]): string {
  if (repos.length === 0) return CHAT_SYSTEM_PROMPT;
  return `${CHAT_SYSTEM_PROMPT}

SOURCE REPOS you can read:
${renderRepoRoster(repos)}`;
}

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
  const tools = buildSuiteChatTools(input.repos ?? []);
  const shared = {
    modelId: input.modelId,
    keys: input.keys,
    local: input.local,
    systemPrompt: chatSystemPrompt(input.repos ?? []),
    customInstructions: input.customInstructions,
    contextPrompt: buildChatContext(input),
    // A banked transcript is only replayable while the tools that produced it
    // are still on the request. `repos` is re-read from preferences every turn,
    // so turning code search off — or removing every repo —
    // between two questions in the same draft chat left the history carrying
    // tool-call/tool-result blocks with no tool definitions behind them, and
    // every follow-up failed with a provider 400 until the user turned it back
    // on. Without tools the turns replay as the prose they ended with, which is
    // what every turn was before transcripts existed.
    priorMessages: historyMessages(input.history, tools !== undefined),
    prompt: buildChatQuestion(input),
    attachments: [
      ...input.attachments,
      ...collectContextImages(input.contextBlocks ?? []),
    ],
    onText: input.onText,
    onToolEvent: input.onToolEvent,
    signal: input.signal,
  };

  // Banked every step, and always — the finish pass below replays it, so the
  // transcript is no longer only the caller's business.
  let transcript: ModelMessage[] = [];
  const bank = (messages: ModelMessage[]) => {
    transcript = messages;
    input.onTranscript?.(messages);
  };

  const r = await streamTask({
    ...shared,
    tools: tools ?? null,
    // Explicit, not inherited. This surface used to name neither, so it silently
    // ran on the runner's MAX_AGENT_STEPS fallback with no entry in either
    // surface table — a budget by accident. It reads the same code with the same
    // tools as Suite Chat, so it gets Suite Chat's numbers.
    maxSteps: SURFACE_STEP_CAPS.draftChat,
    tokenBudget: SURFACE_TOKEN_BUDGETS.draftChat,
    onCheckpoint: (cp) => bank(cp.messages),
  });

  // When the last step wrote nothing and the narration did, the loop ended on a
  // tool call and the user is looking at "I'll dig into the collect/migrate
  // code…" presented as the answer. That is the reported bug, and it survived a
  // follow-up asking for the explanation because the follow-up hit the same
  // wall.
  const replay = sanitizeTranscript(transcript);
  if (answeredThisTurn(r) || !hasToolResult(replay)) {
    return { text: r.text, durationMs: r.durationMs };
  }

  // One more pass over what it already read. The reading is bought and paid
  // for; without this the user pays for twelve steps of it and gets a sentence
  // of narration. Bounded two ways: it runs at most once, and it is rationed by
  // the resume top-up rather than a second full chat budget — the same way the
  // generator's resume bounds the same replay.
  //
  // The tools ride along deliberately — see finishPassMessages. Sending
  // `tools: null` here (what "tool-less finish pass" reads like) puts
  // tool_use/tool_result blocks in a request with no tools to answer to, which
  // Anthropic rejects with a 400, turning the recovery into a second failure
  // the user still pays for.
  const finish = await streamTask({
    ...shared,
    tools: tools ?? null,
    // Named, not inherited: without it this call falls through to the runner's
    // MAX_AGENT_STEPS default — a bigger step ceiling than the turn it is
    // finishing.
    maxSteps: SURFACE_STEP_CAPS.draftChat,
    resumeMessages: finishPassMessages(replay),
    tokenBudget: RESUME_TOPUP_TOKENS,
    // Banked WITHOUT the nudge: this transcript is persisted and replayed as
    // conversation history, and a banked "do not call any more tools" turns one
    // turn's instruction into every later turn's standing order.
    onCheckpoint: (cp) => bank(withoutFinishNudge(cp.messages)),
  });
  // The narration and the rescue are BOTH streamed live — the user watches it
  // work — but what settles into the thread is the answer alone. Reporting the
  // machinery ("stopped after 12 reading steps…") describes our plumbing, not
  // their question, and it is what the reading strip is for. If the rescue
  // produced nothing either, the narration stays rather than leaving a blank
  // bubble.
  const answer = (finish.finalText ?? finish.text).trim();
  return {
    text: answer.length > 0 ? answer : r.text,
    durationMs: r.durationMs + finish.durationMs,
  };
}

// --- Shared user-prompt builder --------------------------------------------

/** The stable half: the spec, the draft on screen, the standards blocks. Same
 *  split, and for the same reason, as Suite Chat's — see buildSuiteChatContext.
 *  The conversation used to be re-inlined as prose in the middle of this, which
 *  put a moving edit right where a cached prefix has to stay still. */
function buildChatContext(input: ChatRunInput): string {
  const targetBlock = renderTargetContext(input.targetContext);
  const changesetsBlock = renderChangesetsBlock(input.changesets);
  const draftBlock = renderDraftBlock(input.cases, input.bugs);
  const contextText = formatContextBlocks(input.contextBlocks ?? []);
  const historyBlock = renderRefineHistory({
    rounds: input.refineRounds ?? [],
    lastSnapshot: input.lastRefineSnapshot,
    cases: input.cases,
    bugs: input.bugs,
  });

  return [
    targetBlock,
    "ORIGINAL SPEC (ground truth):",
    input.requirements.trim() || "(no spec provided)",
    "",
    changesetsBlock || null,
    changesetsBlock ? "" : null,
    historyBlock || null,
    historyBlock ? "" : null,
    "CURRENT DRAFT (what the user is looking at right now):",
    draftBlock,
    contextText ? "" : null,
    contextText || null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

/** The turn being answered. Attachments ride with it rather than with the
 *  stable context: they belong to the turn the user just sent, and putting
 *  anything that changes per turn in front of the history would defeat the
 *  split. */
function buildChatQuestion(input: ChatRunInput): string {
  const attached =
    input.attachments.length === 0
      ? ""
      : "\n\nAttachments:\n\n" + renderAttachmentBlocks(input.attachments);
  return `${input.newQuestion.trim()}${attached}`;
}

/** The thread so far as real conversation turns — the roles carry what the
 *  `USER:` / `ASSISTANT:` labels used to. Empty turns are dropped: harmless as a
 *  blank line of prose, a 400 from Anthropic as a text block with no text.
 *
 *  An assistant turn that carries a transcript is replayed AS the transcript —
 *  its tool calls and their results included — rather than as the prose it
 *  ended with. This is the difference between a conversation that remembers
 *  what it read and one that doesn't: replaying text alone told the model
 *  nothing about the sixteen files it had open a moment ago, so a follow-up as
 *  small as "you didn't explain" re-ran every one of those reads from scratch.
 *  The transcript already contains the assistant's own text, so it replaces
 *  that message rather than joining it — EXCEPT where it doesn't; see below.
 *
 *  `replayTools` is the caller saying whether this turn has the tools that
 *  transcript's blocks refer to. Without them the transcript is unsendable, so
 *  the turns fall back to prose. */
function historyMessages(
  history: ChatMessage[],
  replayTools: boolean,
): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const m of history) {
    const transcript = replayTools ? m.transcript : undefined;
    if (m.role === "assistant" && transcript && transcript.length > 0) {
      out.push(...transcript);
      // A transcript holds COMPLETED steps only. A turn the user stopped
      // mid-answer has its visible prose in `content` and nowhere else — the
      // store keeps that partial bubble deliberately ("that text is still
      // useful to the user") — so replacing the message wholesale dropped
      // exactly the text the user is looking at. "Keep going from where you
      // stopped" then reached a model with no record of having written
      // anything, and it started the answer over.
      const visible = m.content.trim();
      if (visible && !assistantText(transcript).includes(visible)) {
        out.push({ role: "assistant", content: m.content });
      }
      continue;
    }
    if (m.content.trim().length === 0) continue;
    out.push({ role: m.role, content: m.content });
  }
  return out;
}

/** Everything the assistant WROTE in a transcript, tool traffic excluded — used
 *  only to tell "the transcript already has this text" from "the bubble has
 *  text the transcript never banked". */
function assistantText(messages: ModelMessage[]): string {
  let out = "";
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    if (typeof m.content === "string") {
      out += m.content;
      continue;
    }
    if (!Array.isArray(m.content)) continue;
    for (const p of m.content) {
      const part = p as { type?: string; text?: string };
      if (part.type === "text" && typeof part.text === "string") out += part.text;
    }
  }
  return out;
}

/** Repro steps are five labeled sections by contract (PRECONDITION → … →
 *  ENVIRONMENT); at 220 chars — the old budget — the text was cut inside the
 *  first one, so "explain this bug" reached the model as a sentence fragment.
 *  A whole repro runs 400–900 chars, and this is the block the prompt cache
 *  covers, so the generous bound costs a few hundred cached tokens and saves
 *  the tool calls the model was making to recover what it had already been
 *  told. */
const REPRO_MAX_CHARS = 1200;

function clampRepro(text: string): string {
  return text.length > REPRO_MAX_CHARS
    ? `${text.slice(0, REPRO_MAX_CHARS)}\n… (repro truncated)`
    : text;
}

/** `src/a.ts:42-58 (Sym)` — the form the system prompt already asks the model
 *  to cite in, so a bug's own anchors come back out as clickable citations. */
function renderCodeRefs(bug: ReviewedBug): string | null {
  const refs = (bug.codeRefs ?? []).map((r) => {
    const span = r.endLine && r.endLine !== r.startLine
      ? `${r.startLine}-${r.endLine}`
      : `${r.startLine}`;
    return `${r.file}:${span}${r.symbol ? ` (${r.symbol})` : ""}`;
  });
  return refs.length > 0 ? refs.join(", ") : null;
}

function renderSourceLinks(c: ReviewedCase): string | null {
  const links = (c.sourceLinks ?? []).map(
    (l) => `${l.filePath}${l.symbol ? ` (${l.symbol})` : ""}`,
  );
  return links.length > 0 ? links.join(", ") : null;
}

/** The draft as the model sees it.
 *
 *  Everything the generator ALREADY discovered ships with the draft: each
 *  bug's `codeRefs`, each case's `sourceLinks`, and the full repro. Without
 *  them a question as shallow as "explain bug 2" forced the model to re-derive
 *  file locations it had itself written down one run earlier — a live Ask spent
 *  16 tool calls doing exactly that and still never answered.
 *
 *  Items are numbered from 1 to match ORDERING & NUMBERING in the analyst
 *  prompt and the review pane the user is reading, so "case 3" means the same
 *  thing to both ends of the conversation. */
function renderDraftBlock(cases: ReviewedCase[], bugs: ReviewedBug[]): string {
  if (cases.length === 0 && bugs.length === 0) {
    return "(empty draft — no cases or bugs generated yet)";
  }
  const lines: string[] = [];
  if (cases.length > 0) {
    lines.push(`Cases (${cases.length}):`);
    cases.forEach((c, i) => {
      const status = c.decision === "keep" ? "KEEP" : "skip";
      lines.push(`  case ${i + 1} [${status}] ${c.title}`);
      if (c.rationale) lines.push(`    rationale: ${c.rationale}`);
      const source = renderSourceLinks(c);
      if (source) lines.push(`    source: ${source}`);
      c.steps.forEach((s, n) => {
        lines.push(`    ${n + 1}. ${s.action} → ${s.expected}`);
      });
    });
  }
  if (bugs.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(`Bug suggestions (${bugs.length}):`);
    bugs.forEach((b, i) => {
      const status = b.decision === "keep" ? "KEEP" : "skip";
      const linked =
        typeof b.linkedDraftCaseIndex === "number" &&
        b.linkedDraftCaseIndex >= 0 &&
        b.linkedDraftCaseIndex < cases.length
          ? ` → case ${b.linkedDraftCaseIndex + 1}`
          : "";
      lines.push(
        `  bug ${i + 1} [${status}] ${b.title} (severity: ${b.severity})${linked}`,
      );
      const refs = renderCodeRefs(b);
      if (refs) lines.push(`    code: ${refs}`);
      if (b.reproSteps) {
        lines.push("    repro:");
        for (const line of clampRepro(b.reproSteps).split("\n")) {
          lines.push(`      ${line}`);
        }
      }
    });
  }
  return lines.join("\n");
}

let chatMsgCounter = 0;
/** Stable id for a new chat message. Not cryptographic — just unique per
 *  session so React lists key correctly. */
export function newChatMessageId(): string {
  return `chat-${Date.now().toString(36)}-${(chatMsgCounter++).toString(36)}`;
}

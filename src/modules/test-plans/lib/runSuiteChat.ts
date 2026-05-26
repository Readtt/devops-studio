// Q&A over a PUBLISHED test suite. Distinct from the generator's review chat:
// the cases here already live in ADO, the user can't directly mutate them
// from this view, and the model is encouraged to reach into source code via
// Read/Glob/Grep to evaluate whether the suite actually exercises the
// behavior the cases claim to.
//
// Two engine paths mirror the analyst runners — Vercel SDK for users on an
// API-key flow, Claude CLI for users on OAuth (no API key). The CLI path is
// the more useful one here because the file-system tools let the model
// validate test cases against the real codebase.

import { generateText, stepCountIs, streamText } from "ai";
import { getModel, type ModelId } from "@/modules/ai/config";
import { buildLanguageModel } from "@/modules/ai/lib/agent";
import { runClaudeQuery, type ClaudeEvent } from "@/modules/ai/lib/claude";
import type { ClaudeAuthMode } from "@/modules/ai/lib/engine";
import { getKey } from "@/modules/ai/lib/keyring";
import type { ProviderKeys } from "@/modules/ai/lib/keyring";
import type { TestCase } from "@/modules/ado";
import { buildSuiteChatTools } from "./suiteChatTools";
import { buildUserTurn } from "@/modules/ai/lib/visionMessage";
import {
  imageAttachmentToBase64,
  type Attachment,
} from "@/components/chat/attachments";

/** Persisted record of an ADO edit that the user applied from this message.
 *  Keyed in `SuiteChatMessage.appliedEdits` by a content hash of the
 *  devops-edit JSON body, so we can re-render the same block as "applied"
 *  when the chat is reopened later.
 *
 *  `caseId` and `before` snapshot the state the case was in *before* the
 *  apply. They power the Undo button — clicking Undo revives this exact
 *  prior state regardless of what's currently in ADO (the case may have
 *  been modified elsewhere in between). If the snapshot is missing (e.g.
 *  on a record persisted before this field existed) the Undo button is
 *  hidden. */
export type AppliedEditRecord = {
  appliedAt: string;
  /** Result message the ADO write returned ("Replaced 3 steps on #15310"). */
  message: string;
  /** Case the edit targeted. Stored so undo doesn't have to re-parse the
   *  devops-edit body to find the id. */
  caseId?: number;
  /** Pre-apply state of the case. `kind` mirrors the edit kind. */
  before?:
    | { kind: "rename"; title: string }
    | {
        kind: "rewrite-steps";
        steps: { action: string; expected: string }[];
      };
};

export type SuiteChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  /** Map of devops-edit content hash → applied record. Optional so older
   *  persisted threads still load. */
  appliedEdits?: Record<string, AppliedEditRecord>;
  /** Files/images the user attached to this turn. Persisted inline (base64
   *  for images) so they survive a reload. Only set on user messages. */
  attachments?: Attachment[];
};

const SUITE_CHAT_SYSTEM_PROMPT = `You are a senior QA engineer chatting with the user about a SUITE OF TEST CASES that already exist in Azure DevOps. The cases have been published; this conversation is for analysis, review, suggested edits, and "does this actually cover what the spec says it does".

APPLYING EDITS (special markdown block)
When the user wants to change a case and you have a concrete recommendation, emit the change as a fenced code block with the language tag \`devops-edit\`. The UI renders these blocks as an "Apply to ADO" card the user can click. Three kinds are supported:

\`\`\`devops-edit
{
  "kind": "rename",
  "caseId": 15310,
  "title": "[Auth] When user logs in with valid TOTP then session is created"
}
\`\`\`

\`\`\`devops-edit
{
  "kind": "rewrite-steps",
  "caseId": 15310,
  "steps": [
    { "action": "Navigate to /login", "expected": "Login form renders" },
    { "action": "Enter valid credentials", "expected": "Submit button enables" }
  ]
}
\`\`\`

\`\`\`devops-edit
{
  "kind": "create-case",
  "title": "[Auth] Rate-limit lockout shows clear retry-after countdown",
  "steps": [
    { "action": "Submit invalid credentials 5 times in 60s", "expected": "Account locks; UI shows retry-after timer" },
    { "action": "Wait for the timer to elapse and retry with valid credentials", "expected": "Login succeeds" }
  ]
}
\`\`\`

\`\`\`devops-edit
{
  "kind": "delete-case",
  "caseId": 15310,
  "reason": "Duplicate of #15287 — same flow, same assertions"
}
\`\`\`

\`\`\`devops-edit
{
  "kind": "set-outcome",
  "caseId": 15310,
  "outcome": "Failed"
}
\`\`\`

Rules for edit blocks:
- ONE concrete case per block. Don't bundle multiple cases.
- "kind" is exactly "rename", "rewrite-steps", "create-case",
  "delete-case", or "set-outcome". Other kinds aren't supported yet.
- "caseId" is required for "rename", "rewrite-steps", "delete-case", and
  "set-outcome", and must match a case in the loaded scope. For
  "create-case", do NOT include caseId — the case doesn't exist yet, and
  the new case is filed under the suite the user is chatting about.
- "set-outcome" records an EXECUTION result on this case's test point in the
  suite you're chatting about. "outcome" is exactly one of "Passed",
  "Failed", "Blocked", "NotApplicable", or "Active" (Active resets it to
  "not run"). Use this when the user tells you a run result — e.g. "mark the
  login case as failed", "these three passed", "block #15310, env is down".
  It writes the latest outcome only; it does NOT attach a comment, so if the
  user gives a failure reason, mention in prose that they can add it (and
  file a bug) from the test case's Execute bar.
- "create-case" needs a non-empty "title" and at least one step. The new
  case is published to the active suite as soon as the user clicks Apply.
- "rewrite-steps" steps are 1..N; the UI re-indexes on apply.
- "delete-case" moves the work item to ADO's Recycle Bin (recoverable
  for 30 days), it does NOT permanently destroy. Always include a short
  "reason" string so the user knows why you're suggesting deletion. The
  UI shows a Yes/No confirm before the delete actually goes through.
- Only suggest delete-case when the case is clearly redundant, obsolete,
  or contradicts the spec. If you're unsure, recommend rewrite-steps or
  ask the user in prose. Deletion is irreversible-feeling even though
  it's actually a soft delete.
- ALWAYS show the user what you're proposing in plain text BEFORE the
  block ("Here's a tighter version of step 3 — apply to push it to ADO:").
  Don't just dump a block with no context.
- Only emit a block when you're confident the change is an improvement.
  When the user asks "what's wrong with X" without explicitly asking for
  a rewrite, answer in prose first.
- For new cases ("we're missing X coverage"), prefer to ask before
  emitting a create-case block unless the user explicitly asked for the
  case to be created. The block is an *action*, not a draft.

WHAT YOU HAVE
- Every case in the suite (id, title, steps, expected results, description).
- The user's working source directory (when set) accessible via a set of
  read-only filesystem tools — the Claude CLI engine exposes them as
  Read / Glob / Grep, and the BYOK provider engine exposes them as
  read_file / list_files / grep. Behaviour is the same either way:
  read files, list paths, regex-search. USE THEM to validate that cases
  actually map to real code paths, that assertions match actual function
  behaviour, and to surface coverage gaps you can see by walking the code.

WHAT YOU DON'T HAVE
- The ability to RUN the tests. If the user asks "do these all pass", say
  so honestly: you can only review case DEFINITIONS against the code, not
  observe test runs. Offer a per-case static analysis instead.
- The ability to edit cases. If the user asks for a change, suggest the
  exact rewrite in your reply and tell them they can apply it from the
  test case detail pane (which has inline title + step editing).

HOW TO ANSWER
- Be terse and concrete. The user is a working QA engineer.
- Cite cases by their #id when you reference them ("#15310 covers the SSO
  invalidation, but it doesn't assert the session token is purged…"). The
  UI auto-renders bare \`#15310\` as a clickable chip that opens the case
  in-app, so write the id inline — never as a fenced block.
- Cite source files inline using the form \`path/to/file.ext:LINE\` or
  \`path/to/file.ext:START-END\`. The UI renders these as clickable chips
  that jump straight into the in-app code viewer ("step 3 expects a 403,
  but src/auth/loginController.ts:42 returns 401"). Only write a path
  you actually read with the fs tools.
- For "review against the code" requests:
    1. Identify the code paths the case claims to exercise (read the steps
       + the case description).
    2. Verify by reading the actual files (use the fs tools).
    3. Report mismatches concretely with both the #caseId and the
       file:line reference so the user can jump straight in.
- For "what's missing" requests: list specific gaps, not generic advice.
- Don't fabricate file paths. If you can't ground a claim in code you've
  actually read, say so.
- When the source directory isn't available, fall back to reviewing case
  definitions on their own merits (clarity, assertion specificity,
  coverage of common edge cases) and call out that code grounding wasn't
  possible.

OUTPUT
- Plain markdown. Bullet lists, short paragraphs, fenced code when quoting
  source. No JSON. Keep responses under ~15 lines unless the question
  demands depth (e.g. an audit of N cases).`;

export type SuiteChatRunInput = {
  suiteName: string | null;
  suitePath: string[];
  planName: string | null;
  /** Full TestCase objects already fetched from ADO. The runner trusts the
   *  caller to have populated steps + descriptions; we don't re-fetch. */
  cases: TestCase[];
  history: SuiteChatMessage[];
  newQuestion: string;
  /** Image/text attachments on the current turn. Images are sent to the
   *  model as vision input; text was already folded into the prompt. */
  attachments?: Attachment[];
};

export type SuiteChatRunResult = {
  text: string;
  durationMs: number;
};

// --- Vercel SDK path --------------------------------------------------------

export type VercelSuiteChatInput = SuiteChatRunInput & {
  modelId: ModelId;
  keys: ProviderKeys;
  lmstudioBaseURL?: string;
  /** When set, the BYOK runner exposes Read/Glob/Grep tools to the model
   *  backed by the user's source directory — so code-grounded answers
   *  work just like they do on the Claude CLI path. When null, the
   *  runner is text-only and the prompt warns the model. */
  sourceRoot: string | null;
};

export async function runSuiteChat(
  input: VercelSuiteChatInput,
): Promise<SuiteChatRunResult> {
  const model = getModel(input.modelId);
  const lm = await buildLanguageModel(model.provider, input.keys, model.id, {
    lmstudioBaseURL: input.lmstudioBaseURL,
  });
  const userPrompt = buildSuiteChatUserPrompt(input, input.sourceRoot);
  const tools = buildSuiteChatTools(input.sourceRoot);
  const start = Date.now();
  const result = await generateText({
    model: lm,
    system: SUITE_CHAT_SYSTEM_PROMPT,
    ...buildUserTurn(userPrompt, input.attachments),
    ...(tools ? { tools, stopWhen: stepCountIs(8) } : {}),
  });
  return { text: result.text ?? "", durationMs: Date.now() - start };
}

/** Streaming variant of runSuiteChat. Calls `onText` with each text delta
 *  as the model produces it; resolves once the stream finishes. The full
 *  accumulated text is returned for debugging/logging — the caller is
 *  expected to have already rendered it via onText. */
export async function streamSuiteChat(
  input: VercelSuiteChatInput & { onText: (delta: string) => void },
): Promise<SuiteChatRunResult> {
  const model = getModel(input.modelId);
  const lm = await buildLanguageModel(model.provider, input.keys, model.id, {
    lmstudioBaseURL: input.lmstudioBaseURL,
  });
  const userPrompt = buildSuiteChatUserPrompt(input, input.sourceRoot);
  const tools = buildSuiteChatTools(input.sourceRoot);
  const start = Date.now();
  // When a source dir is set, hand the model read-only fs tools and let
  // it loop through up to 8 tool-calling steps before forcing a final
  // text turn. Mirrors the Claude CLI path's Read/Glob/Grep capability so
  // BYOK users get the same code-grounded behaviour.
  const result = streamText({
    model: lm,
    system: SUITE_CHAT_SYSTEM_PROMPT,
    ...buildUserTurn(userPrompt, input.attachments),
    ...(tools ? { tools, stopWhen: stepCountIs(8) } : {}),
  });
  let acc = "";
  for await (const chunk of result.textStream) {
    acc += chunk;
    input.onText(chunk);
  }
  return { text: acc, durationMs: Date.now() - start };
}

// --- Claude CLI path --------------------------------------------------------

export type ClaudeSuiteChatInput = SuiteChatRunInput & {
  modelId: ModelId;
  sourceRoot: string | null;
  authMode: ClaudeAuthMode;
  bareMode?: boolean;
  runId: string;
};

/** Lift image attachments into stream-json image blocks for the CLI path.
 *  Returns undefined when there are none so the plain-text stdin path stays. */
function claudeImages(
  attachments: Attachment[] | undefined,
): { mediaType: string; dataBase64: string }[] | undefined {
  const imgs = (attachments ?? [])
    .map(imageAttachmentToBase64)
    .filter((x): x is { mediaType: string; dataBase64: string } => x !== null);
  return imgs.length > 0 ? imgs : undefined;
}

export async function runSuiteChatClaude(
  input: ClaudeSuiteChatInput,
): Promise<SuiteChatRunResult> {
  const env: Record<string, string> = {};
  if (input.authMode === "api-key") {
    const key = await getKey("anthropic");
    if (key) env.ANTHROPIC_API_KEY = key;
  }
  const userPrompt = buildSuiteChatUserPrompt(input, input.sourceRoot);
  const start = Date.now();
  const result = await runClaudeQuery({
    runId: input.runId,
    prompt: userPrompt,
    images: claudeImages(input.attachments),
    systemPrompt: SUITE_CHAT_SYSTEM_PROMPT,
    cwd: input.sourceRoot ?? undefined,
    model: input.modelId,
    permissionMode: "bypassPermissions",
    allowedTools: ["Read", "Glob", "Grep"],
    bare: input.bareMode,
    env,
  });
  return { text: result.text ?? "", durationMs: Date.now() - start };
}

/** Streaming Claude CLI variant. The CLI emits one `assistant` event per
 *  model message; each event's content array can have `text` blocks (what
 *  we surface as a delta) and `tool_use` blocks (which we ignore for chat
 *  UX — the user only needs the prose). We dedup-by-emitted-prefix so the
 *  final-text reconciliation in the runner doesn't double-append. */
export async function streamSuiteChatClaude(
  input: ClaudeSuiteChatInput & { onText: (delta: string) => void },
): Promise<SuiteChatRunResult> {
  const env: Record<string, string> = {};
  if (input.authMode === "api-key") {
    const key = await getKey("anthropic");
    if (key) env.ANTHROPIC_API_KEY = key;
  }
  const userPrompt = buildSuiteChatUserPrompt(input, input.sourceRoot);
  const start = Date.now();
  // Track already-emitted text by message id so a repeated assistant event
  // (which the CLI sometimes does as it consolidates) doesn't duplicate.
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
        const t = (b as { text?: string }).text ?? "";
        combined += t;
      }
    }
    const prior = seenByMsgId.get(msgId) ?? "";
    if (combined.length > prior.length && combined.startsWith(prior)) {
      const delta = combined.slice(prior.length);
      seenByMsgId.set(msgId, combined);
      input.onText(delta);
    } else if (combined && combined !== prior) {
      // Non-prefix update (rare — CLI rewrote the body). Emit the whole
      // thing as a new chunk so the user still sees the model output.
      seenByMsgId.set(msgId, combined);
      input.onText(combined);
    }
  };
  const result = await runClaudeQuery(
    {
      runId: input.runId,
      prompt: userPrompt,
      images: claudeImages(input.attachments),
      systemPrompt: SUITE_CHAT_SYSTEM_PROMPT,
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

// --- Shared prompt builder --------------------------------------------------

function buildSuiteChatUserPrompt(
  input: SuiteChatRunInput,
  sourceRoot: string | null,
): string {
  const suiteLine = renderSuiteLine(input);
  const sourceLine = sourceRoot
    ? `Source directory: ${sourceRoot} (use the fs tools to verify cases against actual code).`
    : "Source directory: NOT SET — code grounding isn't available. Tell the user if they ask for it.";
  const casesBlock = renderCasesBlock(input.cases);
  const historyBlock = renderHistoryBlock(input.history);
  return [
    suiteLine,
    sourceLine,
    "",
    casesBlock,
    "",
    historyBlock || null,
    historyBlock ? "" : null,
    "USER:",
    input.newQuestion.trim(),
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function renderSuiteLine(input: SuiteChatRunInput): string {
  const plan = input.planName ?? "(unknown plan)";
  const pathParts = [...input.suitePath, input.suiteName ?? "(unnamed suite)"];
  return `SUITE: ${plan} › ${pathParts.join(" › ")} — ${input.cases.length} case${input.cases.length === 1 ? "" : "s"}`;
}

function renderCasesBlock(cases: TestCase[]): string {
  if (cases.length === 0) {
    return "(no cases in this suite — the user can still ask design / coverage questions)";
  }
  const lines: string[] = ["CASES IN SCOPE:"];
  for (const c of cases) {
    lines.push("");
    lines.push(`Case #${c.id} — ${c.title}`);
    if (c.state) lines.push(`  State: ${c.state}`);
    if (c.priority != null) lines.push(`  Priority: ${c.priority}`);
    if (c.tags.length > 0) lines.push(`  Tags: ${c.tags.join(", ")}`);
    if (c.steps.length === 0) {
      lines.push("  Steps: (none)");
    } else {
      lines.push("  Steps:");
      for (const s of c.steps) {
        lines.push(`    ${s.index}. ${oneLine(s.action)} → ${oneLine(s.expected)}`);
      }
    }
  }
  return lines.join("\n");
}

function renderHistoryBlock(history: SuiteChatMessage[]): string {
  if (history.length === 0) return "";
  const lines: string[] = ["PRIOR CONVERSATION:"];
  for (const m of history) {
    lines.push(`${m.role === "user" ? "USER" : "ASSISTANT"}:`);
    lines.push(m.content);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

// Collapse newlines in step text so each step renders on one line in the
// prompt; the model still picks up multi-line intent from the rest of the
// case context. Long fields get clipped to keep the prompt size sane for
// suites with dozens of cases.
function oneLine(s: string, cap = 220): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > cap ? `${flat.slice(0, cap - 1)}…` : flat;
}

let chatMsgCounter = 0;
export function newSuiteChatMessageId(): string {
  return `sc-${Date.now().toString(36)}-${(chatMsgCounter++).toString(36)}`;
}

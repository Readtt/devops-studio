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

import { generateText, streamText } from "ai";
import { getModel, type ModelId } from "@/modules/ai/config";
import { buildLanguageModel } from "@/modules/ai/lib/agent";
import { runClaudeQuery, type ClaudeEvent } from "@/modules/ai/lib/claude";
import type { ClaudeAuthMode } from "@/modules/ai/lib/engine";
import { getKey } from "@/modules/ai/lib/keyring";
import type { ProviderKeys } from "@/modules/ai/lib/keyring";
import type { TestCase } from "@/modules/ado";

export type SuiteChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
};

const SUITE_CHAT_SYSTEM_PROMPT = `You are a senior QA engineer chatting with the user about a SUITE OF TEST CASES that already exist in Azure DevOps. The cases have been published; this conversation is for analysis, review, suggested edits, and "does this actually cover what the spec says it does".

APPLYING EDITS (special markdown block)
When the user wants to change a case and you have a concrete recommendation, emit the change as a fenced code block with the language tag \`devops-edit\`. The UI renders these blocks as an "Apply to ADO" card the user can click. Format:

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

Rules for edit blocks:
- ONE concrete case per block. Don't bundle multiple cases.
- "kind" is exactly "rename" or "rewrite-steps". Other kinds aren't supported yet.
- "caseId" is required and must match a case actually in the loaded scope.
- "rewrite-steps" steps are 1..N; the UI re-indexes on apply.
- ALWAYS show the user what you're proposing in plain text BEFORE the
  block ("Here's a tighter version of step 3 — apply to push it to ADO:").
  Don't just dump a block with no context.
- Only emit a block when you're confident the change is an improvement.
  When the user asks "what's wrong with X" without explicitly asking for
  a rewrite, answer in prose first.

WHAT YOU HAVE
- Every case in the suite (id, title, steps, expected results, description).
- The user's working source directory (when set) accessible via the Read,
  Glob, and Grep tools. USE THEM to validate that cases actually map to
  real code paths, that assertions match actual function behavior, and to
  surface coverage gaps you can see by walking the code.

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
  invalidation, but it doesn't assert the session token is purged…").
- For "review against the code" requests:
    1. Identify the code paths the case claims to exercise (read the steps
       + the case description).
    2. Verify by reading the actual files (Read/Glob/Grep).
    3. Report mismatches concretely: "step 3 expects a 403, but
       loginController.ts:42 returns 401 here".
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
  /** Available to the Vercel path purely as informational context — the SDK
   *  runners here don't get filesystem tools, so this just appears in the
   *  prompt so the model can tell the user "set a source dir to use code
   *  grounding". */
  sourceRootHint: string | null;
};

export async function runSuiteChat(
  input: VercelSuiteChatInput,
): Promise<SuiteChatRunResult> {
  const model = getModel(input.modelId);
  const lm = await buildLanguageModel(model.provider, input.keys, model.id, {
    lmstudioBaseURL: input.lmstudioBaseURL,
  });
  const userPrompt = buildSuiteChatUserPrompt(input, input.sourceRootHint);
  const start = Date.now();
  const result = await generateText({
    model: lm,
    system: SUITE_CHAT_SYSTEM_PROMPT,
    prompt: userPrompt,
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
  const userPrompt = buildSuiteChatUserPrompt(input, input.sourceRootHint);
  const start = Date.now();
  const result = streamText({
    model: lm,
    system: SUITE_CHAT_SYSTEM_PROMPT,
    prompt: userPrompt,
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
    ? `Source directory: ${sourceRoot} (use Read/Glob/Grep to verify cases against code).`
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

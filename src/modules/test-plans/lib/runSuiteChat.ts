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

import { generateText } from "ai";
import { getModel, type ModelId } from "@/modules/ai/config";
import { buildLanguageModel } from "@/modules/ai/lib/agent";
import { runClaudeQuery } from "@/modules/ai/lib/claude";
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

const SUITE_CHAT_SYSTEM_PROMPT = `You are a senior QA engineer chatting with the user about a SUITE OF TEST CASES that already exist in Azure DevOps. The cases have been published; this conversation is for analysis, review, and "does this actually cover what the spec says it does" — not for editing.

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

import { generateText, stepCountIs } from "ai";
import { getModel, type ModelId } from "@/modules/ai/config";
import { buildLanguageModel } from "@/modules/ai/lib/agent";
import type { ProviderKeys } from "@/modules/ai/lib/keyring";
import {
  DraftBatchLLMSchema,
  type DraftBatchLLM,
} from "./draftBatchSchema";
import { QA_ANALYST_PROMPT } from "./qaAnalystPrompt";
import type { TestCaseRef } from "@/modules/ado";
import {
  clampOutputFull,
  clampOutputSummary,
  newActivityId,
  summarizeToolInput,
  type ActivityEntry,
} from "./activityLog";

const MAX_STEPS = 12;

export type GenerationMode = "happy" | "thorough" | "bug-hunt";

export type RunInput = {
  requirements: string;
  attachments: Array<{ path: string; content: string }>;
  existingCaseTitles: Pick<TestCaseRef, "id" | "title">[];
  mode: GenerationMode;
  /** Provider keys hydrated from the OS keychain (chatStore.apiKeys). */
  keys: ProviderKeys;
  modelId: ModelId;
  lmstudioBaseURL?: string;
  /** Structured per-step activity for the streaming log UI. Called for each
   *  tool call (with input + result) and for "thinking" steps without tools. */
  onActivity?: (entry: ActivityEntry) => void;
};

export type RunResult = {
  batch: DraftBatchLLM;
  rawText: string;
  durationMs: number;
};

export async function runQaAnalyst(input: RunInput): Promise<RunResult> {
  const model = getModel(input.modelId);
  const lm = await buildLanguageModel(model.provider, input.keys, model.id, {
    lmstudioBaseURL: input.lmstudioBaseURL,
  });

  const userPrompt = buildUserPrompt(input);
  const start = Date.now();

  // SAFETY: the analyst path runs WITHOUT tools — text-in, JSON-out. The
  // model only sees attachments we pass in `userPrompt`; it can't read or
  // mutate the user's filesystem through this path. Do NOT add a `tools`
  // field here without revisiting the read-only contract enforced in the
  // Claude CLI path (allowedTools: Read/Glob/Grep). If you need tools for a
  // different flow, build a new entrypoint instead of editing this one.
  const result = await generateText({
    model: lm,
    system: QA_ANALYST_PROMPT,
    prompt: userPrompt,
    stopWhen: stepCountIs(MAX_STEPS),
    onStepFinish: (step) => {
      const onActivity = input.onActivity;
      if (!onActivity) return;
      const calls = step.toolCalls ?? [];
      const results = step.toolResults ?? [];
      if (calls.length === 0) {
        // No tool — record the model's thinking step so the log has a
        // breadcrumb even when nothing observable happened.
        onActivity({
          id: newActivityId(),
          ts: Date.now() - start,
          kind: "thinking",
        });
        return;
      }
      for (const call of calls) {
        const matching = results.find(
          (r) => (r as { toolCallId?: string }).toolCallId === call.toolCallId,
        );
        const rawResult = matching
          ? stringifyResult((matching as { output?: unknown }).output)
          : undefined;
        onActivity({
          id: newActivityId(),
          ts: Date.now() - start,
          kind: "tool",
          toolName: call.toolName,
          inputSummary: summarizeToolInput(
            call.toolName,
            (call.input ?? {}) as Record<string, unknown>,
          ),
          outputSummary: rawResult ? clampOutputSummary(rawResult) : undefined,
          outputFull: rawResult ? clampOutputFull(rawResult) : undefined,
        });
      }
    },
  });

  const text = result.text || "";
  const batch = parseBatch(text);
  return { batch, rawText: text, durationMs: Date.now() - start };
}

function buildUserPrompt(input: RunInput): string {
  const modeLine =
    input.mode === "happy"
      ? "Mode: happy — only generate happy-path cases."
      : input.mode === "thorough"
        ? "Mode: thorough — happy + edge cases + negative paths."
        : "Mode: bug-hunt — thorough plus flag concrete bug suggestions where warranted.";

  const existing =
    input.existingCaseTitles.length === 0
      ? "No existing cases in the target suite — generate freely."
      : "Existing case titles in this suite (do not duplicate):\n" +
        input.existingCaseTitles
          .map((c) => `  #${c.id}: ${c.title}`)
          .join("\n");

  const attached =
    input.attachments.length === 0
      ? ""
      : "\n\nSource code attached for grounding:\n\n" +
        input.attachments
          .map((a) => `--- ${a.path} ---\n${a.content}`)
          .join("\n\n");

  return [
    modeLine,
    "",
    "Feature requirements:",
    input.requirements.trim(),
    "",
    existing,
    attached,
    "",
    "Return ONLY the DraftBatch JSON. Schema:",
    JSON.stringify(DRAFT_BATCH_SHAPE, null, 2),
  ].join("\n");
}

/** Schema-shape hint embedded in the prompt — keeps the model honest. */
const DRAFT_BATCH_SHAPE = {
  cases: [
    {
      title: "[Auth] When user logs in with valid TOTP then session is created",
      description: "Optional context for the tester running this case.",
      steps: [
        {
          action: "Navigate to /login",
          expected: "Login form renders",
        },
      ],
      tags: ["auth", "regression"],
      rationale:
        "Why this case exists in one sentence — shown to reviewers.",
    },
  ],
  bugs: [
    {
      title: "[Auth] SMS fallback ignores rate-limit",
      reproSteps: "Step-by-step repro in plain prose.",
      severity: "2 - High",
      linkedDraftCaseIndex: 0,
    },
  ],
};

function parseBatch(text: string): DraftBatchLLM {
  const trimmed = text.trim();
  const candidate = extractJson(trimmed);
  try {
    return DraftBatchLLMSchema.parse(JSON.parse(candidate));
  } catch {
    // Be permissive — return an empty batch rather than crashing the UI.
    return { cases: [], bugs: [] };
  }
}

function stringifyResult(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Strip code fences / preamble if the model didn't fully obey the rules. */
function extractJson(s: string): string {
  // Remove ```json … ``` fences.
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) return fence[1].trim();
  // Take from the first { to the last } if there's surrounding prose.
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first >= 0 && last > first) return s.slice(first, last + 1);
  return s;
}

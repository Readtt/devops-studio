// High-level glue: gather engine/keys/source/best-practices the same way the
// chat surfaces do, then run the confidence evaluation. Keeps the call sites
// (TestCasePane, generator review) to a single await.

import { useChatStore } from "@/modules/ai/store/chatStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { resolveClaudeModelId, selectEngine } from "@/modules/ai/lib/engine";
import { supportsVision } from "@/modules/ai/config";
import { loadBestPracticeBlocks } from "@/modules/ai/lib/bestPractices";
import { evaluateConfidence, type EvalCase } from "./runConfidenceEval";
import type { ConfidenceVerdict } from "./confidence";

export async function evaluateCaseConfidence(
  testCase: EvalCase,
  opts?: { runs?: number; signal?: AbortSignal },
): Promise<ConfidenceVerdict> {
  const chat = useChatStore.getState();
  const prefs = usePreferencesStore.getState();
  const modelId = chat.selectedModelId;
  const engineSel = selectEngine(modelId);
  const useClaude =
    engineSel.engine === "claude-agent-sdk" && engineSel.active;
  const resolvedModel = useClaude
    ? (resolveClaudeModelId(modelId) as typeof modelId)
    : modelId;
  const { blocks } = await loadBestPracticeBlocks(prefs.bestPracticeFiles, {
    visionCapable: useClaude ? true : supportsVision(resolvedModel),
  });
  return evaluateConfidence({
    testCase,
    sourceRoot: prefs.sourceRoot ?? null,
    modelId: resolvedModel,
    useClaude,
    keys: chat.apiKeys,
    authMode: engineSel.authMode ?? "api-key",
    bareMode: prefs.claudeBareMode,
    lmstudioBaseURL: prefs.lmstudioBaseURL,
    runs: opts?.runs ?? 1,
    contextBlocks: blocks,
    signal: opts?.signal,
  });
}

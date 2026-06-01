// High-level glue: gather engine/keys/source/best-practices the same way the
// chat surfaces do, then run the confidence evaluation. Keeps the call sites
// (TestCasePane, generator review) to a single await.

import { useChatStore } from "@/modules/ai/store/chatStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
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
  const { blocks } = await loadBestPracticeBlocks(prefs.bestPracticeFiles, {
    visionCapable: supportsVision(modelId),
  });
  return evaluateConfidence({
    testCase,
    // Global code-search toggle gates source access for every surface.
    sourceRoot: prefs.codeSearchEnabled ? (prefs.sourceRoot ?? null) : null,
    modelId,
    keys: chat.apiKeys,
    lmstudioBaseURL: prefs.lmstudioBaseURL,
    runs: opts?.runs ?? 1,
    contextBlocks: blocks,
    signal: opts?.signal,
  });
}

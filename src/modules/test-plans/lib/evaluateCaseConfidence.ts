// High-level glue: gather engine/keys/source/best-practices the same way the
// chat surfaces do, then run the confidence evaluation. Keeps the call sites
// (TestCasePane, generator review) to a single await.

import { invoke } from "@tauri-apps/api/core";
import { useChatStore } from "@/modules/ai/store/chatStore";
import {
  localProviderConfig,
  usePreferencesStore,
} from "@/modules/settings/preferences";
import { supportsVision } from "@/modules/ai/config";
import { loadBestPracticeBlocks } from "@/modules/ai/lib/bestPractices";
import { evaluateConfidence, type EvalCase } from "./runConfidenceEval";
import type { ConfidenceVerdict } from "./confidence";
import type { GitRepoInfo } from "@/modules/git";

export async function evaluateCaseConfidence(
  testCase: EvalCase,
  opts?: { runs?: number; signal?: AbortSignal },
): Promise<ConfidenceVerdict> {
  const chat = useChatStore.getState();
  const prefs = usePreferencesStore.getState();
  const modelId = chat.selectedModelId;
  // Global code-search toggle gates source access for every surface.
  const sourceRoot = prefs.codeSearchEnabled ? (prefs.sourceRoot ?? null) : null;
  // Stamp the source state we're grading against (branch + HEAD sha) so a stored
  // verdict can later be flagged stale once the working tree moves past it — the
  // same provenance the generator captures at publish time. Best-effort: a
  // non-repo / git failure just leaves the verdict unstamped (staleness = unknown).
  let sourceSha: string | null = null;
  let sourceBranch: string | null = null;
  if (sourceRoot) {
    try {
      const info = await invoke<GitRepoInfo>("git_repo_info", {
        path: sourceRoot,
      });
      sourceSha = info.commit ?? null;
      sourceBranch = info.branch ?? null;
    } catch {
      // leave unstamped
    }
  }
  const { blocks } = await loadBestPracticeBlocks(prefs.bestPracticeFiles, {
    visionCapable: supportsVision(modelId),
  });
  return evaluateConfidence({
    testCase,
    sourceRoot,
    sourceSha,
    sourceBranch,
    modelId,
    keys: chat.apiKeys,
    local: localProviderConfig(prefs),
    runs: opts?.runs ?? 1,
    contextBlocks: blocks,
    customInstructions: prefs.customInstructions || undefined,
    signal: opts?.signal,
  });
}

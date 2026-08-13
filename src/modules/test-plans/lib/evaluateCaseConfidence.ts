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
import type { ConfidenceVerdict, VerdictSource } from "./confidence";
import type { TargetRequirement } from "@/modules/ado";
import type { GitRepoInfo } from "@/modules/git";

export async function evaluateCaseConfidence(
  testCase: EvalCase,
  opts?: {
    runs?: number;
    signal?: AbortSignal;
    /** Requirement this case's suite tracks. Callers that know the suite
     *  resolve it once (see `resolveSuiteRequirement`) and pass it in — a bulk
     *  run must not re-fetch the same work item per case. */
    requirement?: TargetRequirement | null;
    requirementId?: number | null;
  },
): Promise<ConfidenceVerdict> {
  const chat = useChatStore.getState();
  const prefs = usePreferencesStore.getState();
  const modelId = chat.selectedModelId;
  // Global code-search toggle gates source access for every surface; when it's
  // on, every configured repo is readable.
  const repos = prefs.codeSearchEnabled ? prefs.repos : [];
  // Stamp the source state we're grading against (branch + HEAD sha) PER REPO,
  // so a stored verdict is flagged stale once any repo it read moves past it —
  // the same provenance the generator captures at publish time. Best-effort and
  // per repo: one unreadable root only costs its own stamp.
  const sources = (
    await Promise.all(
      repos.map(async (repo) => {
        try {
          const info = await invoke<GitRepoInfo>("git_repo_info", {
            path: repo.root,
          });
          return {
            repoId: repo.id,
            repoName: repo.name,
            branch: info.branch ?? null,
            sha: info.commit ?? null,
          };
        } catch {
          return null;
        }
      }),
    )
  ).filter((s): s is VerdictSource => s !== null && s.sha !== null);
  const { blocks } = await loadBestPracticeBlocks(prefs.bestPracticeFiles, {
    visionCapable: supportsVision(modelId),
  });
  return evaluateConfidence({
    testCase,
    repos,
    sources,
    modelId,
    keys: await chat.ensureApiKeys(),
    local: localProviderConfig(prefs),
    runs: opts?.runs ?? 1,
    contextBlocks: blocks,
    customInstructions: prefs.customInstructions || undefined,
    requirement: opts?.requirement ?? null,
    requirementId: opts?.requirementId ?? null,
    signal: opts?.signal,
  });
}

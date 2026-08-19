// High-level glue: gather engine/keys/source/best-practices the same way the
// chat surfaces do, then run the confidence evaluation. Keeps the call sites
// (TestCasePane, generator review) to a single await.

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
import { gitRepoInfo } from "@/modules/git/gitOps";
import type { WorkspaceRepo } from "@/modules/settings/store";

/** The source state a verdict is graded against (branch + HEAD sha) PER REPO,
 *  so a stored verdict is flagged stale once any repo it read moves past it —
 *  the same provenance the generator captures at publish time. Best-effort and
 *  per repo: one unreadable root only costs its own stamp. */
export async function readRepoSources(
  repos: WorkspaceRepo[],
): Promise<VerdictSource[]> {
  const stamped = await Promise.all(
    repos.map(async (repo) => {
      try {
        const info = await gitRepoInfo(repo.root);
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
  );
  return stamped.filter((s): s is VerdictSource => s !== null && s.sha !== null);
}

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
    /** Branch + HEAD sha per repo. Same deal as `requirement`: a bulk run
     *  resolves it ONCE (see `readRepoSources`) and passes it in, because it
     *  cannot change mid-batch and re-probing costs one git subprocess per repo
     *  PER CASE — a 200-case suite across 5 repos spawned a thousand of them. */
    sources?: VerdictSource[];
  },
): Promise<ConfidenceVerdict> {
  const chat = useChatStore.getState();
  const prefs = usePreferencesStore.getState();
  const modelId = chat.selectedModelId;
  // Global code-search toggle gates source access for every surface; when it's
  // on, every configured repo is readable.
  const repos = prefs.codeSearchEnabled ? prefs.repos : [];
  const sources = opts?.sources ?? (await readRepoSources(repos));
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

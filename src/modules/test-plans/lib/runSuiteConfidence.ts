// Bulk confidence: score a pre-resolved list of suite cases sequentially.
// Discovery (listing, skip-already-scored, the large-suite confirm gate) lives
// in the useSuiteConfidence store; this module just iterates.
//
// Sequential by design — it warms the Anthropic prompt cache for cases 2..N
// (system + tool definitions read from cache) and avoids provider rate limits.
// Continue-on-error: one failing case is recorded and the batch keeps going; a
// user cancel (AbortError) stops the loop immediately.

import { getCase } from "@/modules/ado";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  evaluateCaseConfidence,
  readRepoSources,
} from "./evaluateCaseConfidence";
import { fromTestCase } from "./runConfidenceEval";
import { resolveSuiteRequirement } from "./resolveSuiteRequirement";
import { saveConfidence } from "./confidenceApi";
import type { ConfidenceVerdict } from "./confidence";

export type ScoreTarget = { id: number; title: string };

export type ScoreCallbacks = {
  signal: AbortSignal;
  /** Reserve a case before scoring it. Returns false when another evaluation —
   *  a manual re-analyze on the open test-case tab, say — already owns it; the
   *  case is then skipped to avoid a wasted concurrent double-eval. */
  claim: (id: number) => boolean;
  /** Release the reservation once the case is done (always runs). */
  release: (id: number) => void;
  /** Fired as each case begins (drives the "currently scoring" label). */
  onCaseStart: (id: number, title: string) => void;
  /** Fired after a case is scored and persisted — carries the fresh verdict so
   *  the store can push it to any open case tab live. */
  onCaseDone: (id: number, verdict: ConfidenceVerdict) => void;
  /** Fired when a case is skipped because something else already owns it — still
   *  advances progress so the bar can complete. */
  onCaseSkip: (id: number) => void;
  /** Fired when a case fails; the batch continues with the next one. */
  onCaseFailure: (id: number, title: string, error: unknown) => void;
};

function isAbort(e: unknown): boolean {
  return (e as { name?: string } | null)?.name === "AbortError";
}

/** Score each target case in order, persisting verdicts to SQLite as it goes.
 *
 *  `target` is optional so existing callers keep working; passing it lets a
 *  requirement-bound suite grade its cases against the acceptance criteria
 *  they were written from. */
export async function scoreCases(
  cases: ScoreTarget[],
  cb: ScoreCallbacks,
  target?: { planId: number | null; suiteId: number | null },
): Promise<void> {
  const req = await resolveSuiteRequirement(target?.planId, target?.suiteId);
  // Same reasoning as the requirement below: HEAD can't move under a batch, and
  // probing it per case costs one git subprocess per repo per case.
  const prefs = usePreferencesStore.getState();
  const sources = await readRepoSources(
    prefs.codeSearchEnabled ? prefs.repos : [],
  );
  for (const c of cases) {
    if (cb.signal.aborted) return;
    if (!cb.claim(c.id)) {
      cb.onCaseSkip(c.id); // another evaluation already owns this case
      continue;
    }
    cb.onCaseStart(c.id, c.title);
    try {
      const tc = await getCase(c.id); // full detail incl. parsed steps
      const verdict = await evaluateCaseConfidence(fromTestCase(tc), {
        runs: 1,
        signal: cb.signal,
        // Resolved ONCE before the loop — a requirement suite has one work
        // item, and re-fetching it per case would multiply the cost of a bulk
        // run by the case count for no new information.
        requirement: req.requirement,
        requirementId: req.requirementId,
        sources,
      });
      if (cb.signal.aborted) return; // cancelled while this case was scoring
      await saveConfidence(c.id, verdict);
      cb.onCaseDone(c.id, verdict);
    } catch (e) {
      // Stop on cancel — whether the in-flight call rejected with a recognizable
      // AbortError OR the signal simply tripped (some providers surface a
      // generic error). Either way a cancelled case is never a "failure".
      if (isAbort(e) || cb.signal.aborted) return;
      cb.onCaseFailure(c.id, c.title, e); // record + keep going
    } finally {
      cb.release(c.id);
    }
  }
}

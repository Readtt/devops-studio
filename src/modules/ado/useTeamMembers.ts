import { useEffect, useState, useSyncExternalStore } from "react";
import { listTeamMembers } from "./native";
import type { TeamMember } from "./types";

// Module-level cache shared by every consumer (e.g. each Suite Chat create-bug
// card, every generator tab's bug list). The project roster changes rarely, so
// one fetch per session is plenty; caching here means N cards on screen don't
// trigger N identical ADO calls.
//
// This is the app's single most expensive read: `ado_list_team_members`
// enumerates every TEAM in the project and fetches each one's members, so a
// project with forty teams is forty-odd requests per call. Anything that makes
// it run more than once is a rate-limit incident, not a slow pane — which is
// why the failure path below backs off instead of retrying per mount.
let cache: TeamMember[] | null = null;
let inflight: Promise<TeamMember[]> | null = null;
/** When the last attempt failed, so remounts don't re-run the fan-out. */
let failedAt = 0;
/** Bumped by {@link invalidateTeamMembers}. A fan-out already in flight can't
 *  be cancelled, so it checks this before writing: a roster for the project we
 *  just switched AWAY from must not land in the cache, or every reader
 *  short-circuits on the old project's people for the rest of the session —
 *  the exact staleness invalidating exists to clear. */
let generation = 0;

/** How long a failure suppresses retries. Long enough that a picker opening and
 *  closing can't hammer ADO, short enough that fixing a PAT and coming back
 *  works without a restart. */
export const TEAM_MEMBERS_RETRY_MS = 60_000;

/** The cache in front of `ado_list_team_members`: one shared fetch, one shared
 *  result, and a backoff after failure. Exported for its own tests — the hook
 *  below is a thin wrapper over exactly this.
 *
 *  Takes a CLOCK rather than a timestamp because the failure has to be stamped
 *  when it happened, not when the request went out: the fan-out is dozens of
 *  requests and a 429 or a timeout can take most a minute to reject, which used
 *  to spend most of the backoff window before it began. */
export function loadTeamMembers(
  clock: () => number = Date.now,
): Promise<TeamMember[]> {
  if (cache) return Promise.resolve(cache);
  if (failedAt && clock() - failedAt < TEAM_MEMBERS_RETRY_MS) {
    return Promise.reject(new Error("team members unavailable; backing off"));
  }
  if (!inflight) {
    const started = generation;
    inflight = listTeamMembers()
      .then((m) => {
        // Superseded mid-flight: answer this caller, poison nothing.
        if (started !== generation) return m;
        cache = m;
        failedAt = 0;
        return m;
      })
      .catch((e) => {
        // Drop the in-flight promise so a later mount CAN retry — but stamp the
        // failure so "later" means after the backoff, not on the next render.
        if (started === generation) {
          inflight = null;
          failedAt = clock();
        }
        throw e;
      });
  }
  return inflight;
}

/**
 * Forget the cached roster. Call when the ADO connection changes: the roster is
 * per PROJECT, so after a project switch the cache holds the previous project's
 * people — names that aren't assignable on the work items being created now.
 */
export function invalidateTeamMembers(): void {
  generation++;
  cache = null;
  inflight = null;
  failedAt = 0;
  // Clearing the module cache is only half of it: every mounted `useTeamMembers`
  // holds its roster in component state, seeded once, and its effect only re-runs
  // when `enabled` flips. Without this wake-up an open review tab keeps offering
  // the PREVIOUS project's people — assignable nowhere — which is the exact
  // staleness invalidating exists to clear.
  for (const listen of [...listeners]) listen();
}

/** Mounted consumers, woken by {@link invalidateTeamMembers}. */
const listeners = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

function getGeneration(): number {
  return generation;
}

/** Tests only — the cache is process-lifetime state. */
export function __resetTeamMembers(): void {
  invalidateTeamMembers();
}

/**
 * Lazily load the project's team members for a developer picker, shared across
 * all callers via a module cache. Pass `enabled` so a host that only sometimes
 * needs people (e.g. a chat card that's only sometimes a create-bug card)
 * doesn't fetch until it does. Degrades to an empty list on failure — the
 * picker stays usable and shows a "check your ADO connection" empty state.
 */
export function useTeamMembers(enabled: boolean): {
  members: TeamMember[];
  loading: boolean;
} {
  const [members, setMembers] = useState<TeamMember[]>(() => cache ?? []);
  const [loading, setLoading] = useState(false);
  // Re-runs the effect on invalidation, so a project switch refetches instead of
  // leaving a mounted picker on the old roster.
  const generationTick = useSyncExternalStore(subscribe, getGeneration, getGeneration);

  useEffect(() => {
    if (!enabled) return;
    if (cache) {
      setMembers(cache);
      return;
    }
    let alive = true;
    // Drop what's on screen first: after an invalidation this list is the old
    // project's people, and holding it through the refetch offers names the new
    // project can't assign.
    setMembers([]);
    setLoading(true);
    loadTeamMembers()
      .then((m) => {
        if (alive) setMembers(m);
      })
      .catch(() => {
        if (alive) setMembers([]);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [enabled, generationTick]);

  return { members, loading };
}

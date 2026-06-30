import { useEffect, useState } from "react";
import { listTeamMembers } from "./native";
import type { TeamMember } from "./types";

// Module-level cache shared by every consumer (e.g. each Suite Chat create-bug
// card). The project roster changes rarely, so one fetch per session is plenty;
// caching here means N cards on screen don't trigger N identical ADO calls.
let cache: TeamMember[] | null = null;
let inflight: Promise<TeamMember[]> | null = null;

function fetchOnce(): Promise<TeamMember[]> {
  if (cache) return Promise.resolve(cache);
  if (!inflight) {
    inflight = listTeamMembers()
      .then((m) => {
        cache = m;
        return m;
      })
      .catch((e) => {
        // Drop the in-flight promise so a later mount can retry rather than
        // being stuck with a rejected one.
        inflight = null;
        throw e;
      });
  }
  return inflight;
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

  useEffect(() => {
    if (!enabled) return;
    if (cache) {
      setMembers(cache);
      return;
    }
    let alive = true;
    setLoading(true);
    fetchOnce()
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
  }, [enabled]);

  return { members, loading };
}

// Lightweight in-memory search index built from whatever plans / suites /
// cases the useTestPlans store has cached. Rebuilt on the read side from
// the existing zustand snapshots — no parallel data source to keep in sync.

import { useMemo } from "react";
import { useTestPlans } from "@/modules/test-plans";
import type { SuiteType } from "@/modules/ado";

export type SearchEntry =
  | {
      kind: "case";
      id: number;
      title: string;
      planId: number;
      planName: string;
      suiteId: number;
      suiteName: string;
    }
  | {
      kind: "suite";
      id: number;
      title: string;
      planId: number;
      planName: string;
      /** So a result row can badge requirement/query suites and callers can
       *  avoid routing a query-based suite into the generator. */
      suiteType: SuiteType;
    }
  | { kind: "plan"; id: number; title: string };

export type SearchResult = SearchEntry & { score: number };

/** Read the cached plan/suite/case data out of the test-plans store and
 *  return a search() callback that performs a case-insensitive substring
 *  match across titles. Tokenized scoring so multi-word queries surface
 *  the closest matches first. */
export function useSearchIndex() {
  const plans = useTestPlans((s) => s.plans);
  const bySuite = useTestPlans((s) => s.bySuite);

  const entries = useMemo<SearchEntry[]>(() => {
    const out: SearchEntry[] = [];
    for (const p of plans) {
      out.push({ kind: "plan", id: p.id, title: p.name });
      const load = bySuite.get(p.id);
      if (!load) continue;
      for (const s of load.suites) {
        out.push({
          kind: "suite",
          id: s.id,
          title: s.name,
          planId: p.id,
          planName: p.name,
          suiteType: s.suiteType,
        });
        const cases = load.suiteCases.get(s.id)?.cases ?? [];
        for (const c of cases) {
          out.push({
            kind: "case",
            id: c.id,
            title: c.title,
            planId: p.id,
            planName: p.name,
            suiteId: s.id,
            suiteName: s.name,
          });
        }
      }
    }
    return out;
  }, [plans, bySuite]);

  const search = useMemo(() => {
    return (query: string, limit = 30): SearchResult[] => {
      const q = query.trim().toLowerCase();
      if (!q) return [];
      const tokens = q.split(/\s+/).filter(Boolean);
      if (tokens.length === 0) return [];
      const results: SearchResult[] = [];
      for (const e of entries) {
        const hay = e.title.toLowerCase();
        let score = 0;
        let allMatch = true;
        for (const t of tokens) {
          const i = hay.indexOf(t);
          if (i < 0) {
            allMatch = false;
            break;
          }
          // Earlier match = higher score; exact-prefix bonus.
          score += 100 - Math.min(i, 90);
          if (i === 0) score += 25;
          if (hay === t) score += 50;
        }
        if (!allMatch) continue;
        // Cases outrank suites outrank plans when the title matches equally
        // — usually the case is what the user is hunting for.
        if (e.kind === "case") score += 10;
        else if (e.kind === "suite") score += 5;
        results.push({ ...e, score });
      }
      results.sort((a, b) => b.score - a.score);
      return results.slice(0, limit);
    };
  }, [entries]);

  return { search, entryCount: entries.length };
}

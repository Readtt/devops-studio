import { describe, expect, it } from "vitest";
import {
  isAutoPassCandidate,
  passReadiness,
  readinessTone,
  verdictSourceState,
  type ConfidenceVerdict,
  type CurrentSource,
  type VerdictSource,
} from "./confidence";

function verdict(p: Partial<ConfidenceVerdict>): ConfidenceVerdict {
  return {
    predictedOutcome: "Pass",
    passLikelihood: 95,
    evidence: [],
    reasoning: "",
    ...p,
  } as ConfidenceVerdict;
}

const ONE: CurrentSource[] = [{ repoId: "r1", repoName: "repo-one", sha: "abc1234" }];
const TWO: CurrentSource[] = [
  { repoId: "r1", repoName: "repo-one", sha: "abc1234" },
  { repoId: "r2", repoName: "repo-two", sha: "ddd4444" },
];

function source(p: Partial<VerdictSource> & { repoId: string }): VerdictSource {
  return { repoName: p.repoId, branch: "main", sha: null, ...p };
}

describe("verdictSourceState", () => {
  it("is fresh when the verdict's source sha matches the current HEAD", () => {
    const s = verdictSourceState(
      { sources: [source({ repoId: "r1", sha: "abc1234" })] },
      ONE,
    );
    expect(s.kind).toBe("fresh");
    expect(s.kind === "fresh" && s.repos[0].evaluatedSha).toBe("abc1234");
  });

  it("matches on a 7-char prefix (differing abbreviation lengths)", () => {
    expect(
      verdictSourceState(
        { sources: [source({ repoId: "r1", sha: "abc1234ff00" })] },
        ONE,
      ).kind,
    ).toBe("fresh");
  });

  it("is stale when the tree has moved past the evaluated commit", () => {
    const s = verdictSourceState(
      { sources: [source({ repoId: "r1", sha: "aaaaaaa" })] },
      ONE,
    );
    expect(s.kind).toBe("stale");
    if (s.kind === "stale") {
      expect(s.moved).toHaveLength(1);
      expect(s.moved[0].evaluatedSha).toBe("aaaaaaa");
      expect(s.moved[0].currentSha).toBe("abc1234");
    }
  });

  it("is unknown without a stamp or without a current sha (no repo / code search off)", () => {
    expect(verdictSourceState({}, ONE).kind).toBe("unknown");
    expect(verdictSourceState({ sources: [] }, ONE).kind).toBe("unknown");
    expect(
      verdictSourceState({ sources: [source({ repoId: "r1", sha: null })] }, ONE)
        .kind,
    ).toBe("unknown");
    expect(
      verdictSourceState({ sources: [source({ repoId: "r1", sha: "abc1234" })] }, [])
        .kind,
    ).toBe("unknown");
    expect(
      verdictSourceState({ sources: [source({ repoId: "r1", sha: "abc1234" })] }, [
        { repoId: "r1", repoName: "repo-one", sha: null },
      ]).kind,
    ).toBe("unknown");
  });

  it("compares each repo against ITS OWN head, not the first repo's", () => {
    // Graded against repo-two only. Its head is unchanged; repo-one's differs —
    // which must not make this verdict stale.
    const s = verdictSourceState(
      { sources: [source({ repoId: "r2", repoName: "repo-two", sha: "ddd4444" })] },
      TWO,
    );
    expect(s.kind).toBe("fresh");
  });

  it("is stale when ANY recorded repo moved, and names only the ones that did", () => {
    const s = verdictSourceState(
      {
        sources: [
          source({ repoId: "r1", repoName: "repo-one", sha: "abc1234" }),
          source({ repoId: "r2", repoName: "repo-two", sha: "999zzzz" }),
        ],
      },
      TWO,
    );
    expect(s.kind).toBe("stale");
    expect(s.kind === "stale" && s.moved.map((m) => m.repoName)).toEqual([
      "repo-two",
    ]);
  });

  it("drops a repo that left the workspace rather than calling it moved", () => {
    const s = verdictSourceState(
      {
        sources: [
          source({ repoId: "r1", repoName: "repo-one", sha: "abc1234" }),
          source({ repoId: "gone", repoName: "repo-gone", sha: "777aaaa" }),
        ],
      },
      ONE,
    );
    expect(s.kind).toBe("fresh");
    expect(s.kind === "fresh" && s.repos.map((r) => r.repoName)).toEqual([
      "repo-one",
    ]);
  });

  it("reads a legacy scalar stamp as the first repo's", () => {
    expect(
      verdictSourceState({ sourceSha: "abc1234", sourceBranch: "main" }, TWO).kind,
    ).toBe("fresh");
    expect(verdictSourceState({ sourceSha: "aaaaaaa" }, TWO).kind).toBe("stale");
    // …and with no repos at all there's nothing to attribute it to.
    expect(verdictSourceState({ sourceSha: "abc1234" }, []).kind).toBe("unknown");
  });

  it("prefers the per-repo stamp over a legacy scalar when both are present", () => {
    const s = verdictSourceState(
      {
        sources: [source({ repoId: "r2", repoName: "repo-two", sha: "ddd4444" })],
        sourceSha: "aaaaaaa",
      },
      TWO,
    );
    expect(s.kind).toBe("fresh");
  });
});

describe("passReadiness", () => {
  it("uses passLikelihood directly for graded outcomes", () => {
    expect(passReadiness({ predictedOutcome: "Pass", passLikelihood: 92 })).toBe(92);
    expect(passReadiness({ predictedOutcome: "Fail", passLikelihood: 10 })).toBe(10);
  });

  it("returns null for Unknown — the chip's '?' state", () => {
    expect(passReadiness({ predictedOutcome: "Unknown" })).toBeNull();
  });

  it("derives readiness from a legacy confidence value (back-compat)", () => {
    // 94%-confident Fail => 6% pass-ready.
    expect(passReadiness({ predictedOutcome: "Fail", confidence: 94 })).toBe(6);
    expect(passReadiness({ predictedOutcome: "Pass", confidence: 88 })).toBe(88);
  });

  it("clamps out-of-range values", () => {
    expect(passReadiness({ predictedOutcome: "Pass", passLikelihood: 140 })).toBe(100);
    expect(passReadiness({ predictedOutcome: "Pass", passLikelihood: -5 })).toBe(0);
  });
});

describe("isAutoPassCandidate", () => {
  it("is true only for a Pass at/above the 90% bar", () => {
    expect(isAutoPassCandidate(verdict({ passLikelihood: 90 }))).toBe(true);
    expect(isAutoPassCandidate(verdict({ passLikelihood: 89 }))).toBe(false);
  });

  it("is never true for Fail/Blocked/Unknown, even at high readiness", () => {
    expect(isAutoPassCandidate(verdict({ predictedOutcome: "Fail", passLikelihood: 95 }))).toBe(false);
    expect(isAutoPassCandidate(verdict({ predictedOutcome: "Unknown" }))).toBe(false);
    expect(isAutoPassCandidate(null)).toBe(false);
  });
});

describe("readinessTone", () => {
  it("greens only a Pass clearing the bar; Unknown is neutral", () => {
    expect(readinessTone(95, "Pass").className).toContain("emerald");
    expect(readinessTone(95, "Fail").className).not.toContain("emerald");
    expect(readinessTone(null, "Unknown").className).toContain("muted-foreground");
    expect(readinessTone(40, "Fail").className).toContain("rose");
  });
});

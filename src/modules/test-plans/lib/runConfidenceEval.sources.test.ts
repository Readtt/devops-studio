// A verdict's `sources` stamp is what `verdictSourceState` compares, and it is
// stale-if-ANY. Stamping every configured repo therefore let a commit in a repo
// the case never touched invalidate the verdict — which turned the "skip fresh"
// gate in bulk suite scoring into a no-op on the app's dominant cost path.
//
// These pin the narrowing and, more importantly, the two guards that keep it
// from being a regression.

import { beforeEach, describe, expect, it, vi } from "vitest";

const runTask = vi.fn();
vi.mock("@/modules/ai/lib/taskRunner", () => ({
  runTask: (...a: unknown[]) => runTask(...a),
}));
vi.mock("./suiteChatTools", () => ({
  buildSuiteChatTools: (repos: unknown[]) =>
    repos.length > 0 ? ({ read_file: {} } as never) : undefined,
}));

import { evaluateConfidence, type ConfidenceEvalInput } from "./runConfidenceEval";
import { verdictSourceState, type VerdictSource } from "./confidence";

const REPOS = [
  { id: "r1", name: "repo-one", root: "C:/src/repo-one", ado: null },
  { id: "r2", name: "repo-two", root: "C:/src/repo-two", ado: null },
  { id: "r3", name: "repo-three", root: "C:/src/repo-three", ado: null },
];

const SOURCES: VerdictSource[] = REPOS.map((r, i) => ({
  repoId: r.id,
  repoName: r.name,
  branch: "main",
  sha: `sha${i + 1}`,
}));

function verdict(refs: (string | null)[]) {
  return {
    predictedOutcome: "Pass",
    passLikelihood: 80,
    evidence: refs.map((ref, i) => ({ step: i + 1, finding: "traced", ref })),
    reasoning: "traced",
    caveats: [],
  };
}

function input(over: Partial<ConfidenceEvalInput> = {}): ConfidenceEvalInput {
  return {
    testCase: { id: 1, title: "case", steps: [] },
    repos: REPOS,
    sources: SOURCES,
    modelId: "claude-opus-5" as ConfidenceEvalInput["modelId"],
    keys: {} as ConfidenceEvalInput["keys"],
    ...over,
  } as ConfidenceEvalInput;
}

beforeEach(() => runTask.mockReset());

describe("verdict source stamps · narrowed to the repos it cites", () => {
  it("keeps only the repos the evidence refs name", async () => {
    runTask.mockResolvedValue({
      ok: true,
      object: verdict(["repo-two/src/auth/login.ts:42-58", "repo-two/src/x.ts:9"]),
      text: "",
    });
    const v = await evaluateConfidence(input());
    // repo-one and repo-three moving can no longer invalidate this verdict.
    expect(v.sources?.map((s) => s.repoName)).toEqual(["repo-two"]);
  });

  it("keeps every repo a multi-repo case traced through", async () => {
    runTask.mockResolvedValue({
      ok: true,
      object: verdict(["repo-one/src/api/handler.cs:12", "repo-three/src/ui/form.tsx:80"]),
      text: "",
    });
    const v = await evaluateConfidence(input());
    expect(v.sources?.map((s) => s.repoName)).toEqual(["repo-one", "repo-three"]);
  });

  // Guard A. An ungrounded verdict is the one that most needs re-running when
  // anything moves — new code anywhere could be the code it couldn't find. An
  // empty stamp would read as `unknown` and be SKIPPED by bulk forever.
  it("keeps the full stamp when the verdict grounded nothing", async () => {
    runTask.mockResolvedValue({ ok: true, object: verdict([null, null]), text: "" });
    const v = await evaluateConfidence(input());
    expect(v.sources).toEqual(SOURCES);
  });

  it("keeps the full stamp when a verdict has no evidence at all", async () => {
    runTask.mockResolvedValue({ ok: true, object: verdict([]), text: "" });
    const v = await evaluateConfidence(input());
    expect(v.sources).toEqual(SOURCES);
  });

  // Guard B. Narrowing may only remove stamps, never invent one — otherwise a
  // verdict could go fresh → stale, which is the failure this exists to end.
  it("invents nothing from a ref naming a repo that isn't configured", async () => {
    runTask.mockResolvedValue({
      ok: true,
      object: verdict(["repo-gone/src/x.ts:1"]),
      text: "",
    });
    const v = await evaluateConfidence(input());
    expect(v.sources).toEqual(SOURCES);
  });

  it("is a no-op at one repo, whatever the refs say", async () => {
    runTask.mockResolvedValue({
      ok: true,
      object: verdict(["repo-one/src/x.ts:1"]),
      text: "",
    });
    const only = [SOURCES[0]];
    const v = await evaluateConfidence(
      input({ repos: [REPOS[0]], sources: only }),
    );
    expect(v.sources).toEqual(only);
  });

  // The point of all of it, stated end to end: this is the comparison the bulk
  // gate in useSuiteConfidence runs, and `stale` is what makes it re-score.
  it("survives a commit in a repo it never cited, and still catches its own", async () => {
    runTask.mockResolvedValue({
      ok: true,
      object: verdict(["repo-two/src/auth/login.ts:42"]),
      text: "",
    });
    const v = await evaluateConfidence(input());

    const moved = (repoId: string) =>
      REPOS.map((r, i) => ({
        repoId: r.id,
        repoName: r.name,
        sha: r.id === repoId ? "moved00" : `sha${i + 1}`,
      }));

    // repo-one and repo-three churn all week; this verdict is untouched.
    expect(verdictSourceState(v, moved("r1")).kind).toBe("fresh");
    expect(verdictSourceState(v, moved("r3")).kind).toBe("fresh");
    // Its own repo moving still invalidates it.
    expect(verdictSourceState(v, moved("r2")).kind).toBe("stale");
  });

  it("stamps nothing when there was nothing to stamp", async () => {
    runTask.mockResolvedValue({
      ok: true,
      object: verdict(["repo-one/src/x.ts:1"]),
      text: "",
    });
    const v = await evaluateConfidence(input({ repos: [], sources: [] }));
    expect(v.sources).toEqual([]);
  });
});

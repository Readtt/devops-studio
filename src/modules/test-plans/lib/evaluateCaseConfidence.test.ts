import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
const evaluateConfidence = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));
vi.mock("@/modules/ai/store/chatStore", () => ({
  useChatStore: {
    getState: () => ({
      selectedModelId: "claude-opus-5",
      ensureApiKeys: async () => ({}),
    }),
  },
}));
vi.mock("@/modules/ai/lib/bestPractices", () => ({
  loadBestPracticeBlocks: async () => ({ blocks: [] }),
}));
vi.mock("./runConfidenceEval", () => ({
  evaluateConfidence: (...a: unknown[]) => evaluateConfidence(...a),
}));

import { evaluateCaseConfidence } from "./evaluateCaseConfidence";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { createRepo } from "@/modules/settings/store";
import type { VerdictSource } from "./confidence";

const CASE = { id: 1, title: "case", steps: [] };
const one = createRepo("C:/repo-one");
const two = createRepo("C:/repo-two");
const three = createRepo("C:/repo-three");

/** The `sources` array handed to the evaluator on the last call. */
function stamped(): VerdictSource[] {
  return (evaluateConfidence.mock.calls[0][0] as { sources: VerdictSource[] })
    .sources;
}

beforeEach(() => {
  invoke.mockReset();
  evaluateConfidence.mockReset();
  evaluateConfidence.mockResolvedValue({ predictedOutcome: "Pass" });
  usePreferencesStore.setState({
    repos: [one, two, three],
    codeSearchEnabled: true,
    bestPracticeFiles: [],
  });
});

describe("evaluateCaseConfidence provenance", () => {
  it("stamps every readable repo's own branch and head", async () => {
    invoke.mockImplementation((_cmd: string, args: { path: string }) =>
      Promise.resolve({
        branch: `br-${args.path.slice(-1)}`,
        commit: `sha-${args.path.slice(-1)}`,
        isRepo: true,
      }),
    );
    await evaluateCaseConfidence(CASE);
    expect(stamped()).toEqual([
      { repoId: one.id, repoName: one.name, branch: "br-e", sha: "sha-e" },
      { repoId: two.id, repoName: two.name, branch: "br-o", sha: "sha-o" },
      { repoId: three.id, repoName: three.name, branch: "br-e", sha: "sha-e" },
    ]);
  });

  it("lets one unreadable repo cost only its own stamp", async () => {
    invoke.mockImplementation((_cmd: string, args: { path: string }) =>
      args.path === two.root
        ? Promise.reject(new Error("not a repo"))
        : Promise.resolve({ branch: "main", commit: "aaa1111", isRepo: true }),
    );
    await evaluateCaseConfidence(CASE);
    expect(stamped().map((s) => s.repoName)).toEqual([one.name, three.name]);
  });

  it("drops a repo with no commit rather than stamping a null sha", async () => {
    // A configured folder that isn't a git repo answers, but with nothing to
    // compare later — a null sha would just be noise on the verdict.
    invoke.mockImplementation((_cmd: string, args: { path: string }) =>
      Promise.resolve(
        args.path === three.root
          ? { branch: null, commit: null, isRepo: false }
          : { branch: "main", commit: "aaa1111", isRepo: true },
      ),
    );
    await evaluateCaseConfidence(CASE);
    expect(stamped().map((s) => s.repoName)).toEqual([one.name, two.name]);
  });

  it("stamps nothing and probes nothing with code search off", async () => {
    usePreferencesStore.setState({ codeSearchEnabled: false });
    await evaluateCaseConfidence(CASE);
    expect(invoke).not.toHaveBeenCalled();
    expect(stamped()).toEqual([]);
    expect(
      (evaluateConfidence.mock.calls[0][0] as { repos: unknown[] }).repos,
    ).toEqual([]);
  });
});

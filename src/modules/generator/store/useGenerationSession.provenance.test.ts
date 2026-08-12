import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGenerationSessionStore } from "./useGenerationSession";
import type { ReviewedBug, ReviewedCase } from "../lib/draftBatchSchema";
import { parseSourceLinks } from "@/modules/test-plans/lib/sourceLinksParser";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { createRepo } from "@/modules/settings/store";

const BRANCH = "feature/2fa";
const SHA = "9f3c1ab";

const mockRepoInfo: { branch: string | null; commit: string | null } = {
  branch: BRANCH,
  commit: SHA,
};
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) =>
    cmd === "git_repo_info" ? mockRepoInfo : undefined,
  ),
}));

const createCaseInSuite = vi.fn();
const createBugAndLink = vi.fn();
vi.mock("@/modules/ado", async () => {
  const actual =
    await vi.importActual<typeof import("@/modules/ado")>("@/modules/ado");
  return {
    ...actual,
    getConnection: async () => ({
      orgUrl: "https://dev.azure.com/contoso",
      project: "P",
    }),
    createCaseInSuite: (...args: unknown[]) => createCaseInSuite(...args),
    createBugAndLink: (...args: unknown[]) => createBugAndLink(...args),
  };
});

function mkCase(): ReviewedCase {
  return {
    uid: "c0",
    decision: "keep",
    similarMatches: [],
    title: "Case c0",
    description: "Body.",
    steps: [],
    sourceLinks: [
      { repoName: "repo-one", filePath: "src/auth/login.cs" },
    ],
  } as unknown as ReviewedCase;
}

function mkBug(): ReviewedBug {
  return {
    uid: "b0",
    decision: "keep",
    title: "A bug with a sufficiently long title",
    reproSteps: "x",
    severity: "2 - High",
    linkedDraftCaseIndex: 0,
    codeRefs: [{ file: "src/auth/login.cs", startLine: 12 }],
  } as unknown as ReviewedBug;
}

/** Publish one case + one bug and hand back what actually reached ADO. */
async function publish(tagSourceBranch: boolean) {
  const store = createGenerationSessionStore();
  store.setState({
    phase: "review",
    cases: [mkCase()],
    bugs: [mkBug()],
    planId: 1,
    suiteId: 2,
    targetSuiteType: "staticTestSuite",
    tagSourceBranch,
  });

  await store.getState().publish();

  const draft = createCaseInSuite.mock.calls[0]?.[2] as {
    sourceLinksBlock: string | null;
  };
  const bug = createBugAndLink.mock.calls[0]?.[1] as {
    codeLinks: { commitSha: string | null }[];
  };
  return {
    link: parseSourceLinks(draft?.sourceLinksBlock ?? "")[0],
    bugCommitSha: bug?.codeLinks[0]?.commitSha ?? null,
  };
}

describe("publish stamps source provenance", () => {
  beforeEach(() => {
    createCaseInSuite.mockClear().mockResolvedValue({ id: 999, url: "" });
    createBugAndLink.mockClear().mockResolvedValue({ id: 1000, url: "" });
    usePreferencesStore.setState({ repos: [createRepo("C:/src/repo-one")] });
    mockRepoInfo.branch = BRANCH;
    mockRepoInfo.commit = SHA;
  });

  it("records the branch AND the commit the cases were generated from", async () => {
    // The sha was hardcoded empty for the whole life of the feature, so every
    // published case claimed a branch but no commit to anchor it to.
    const { link, bugCommitSha } = await publish(true);
    expect(link.trackingBranch).toBe(BRANCH);
    expect(link.generationSha).toBe(SHA);
    expect(bugCommitSha).toBe(SHA);
  });

  it("stamps nothing at all when the user opts out", async () => {
    const { link, bugCommitSha } = await publish(false);
    // The link itself must survive — only the provenance goes.
    expect(link.filePath).toBe("src/auth/login.cs");
    expect(link.trackingBranch).toBe("");
    expect(link.generationSha).toBe("");
    expect(bugCommitSha).toBeNull();
  });

  it("on a detached HEAD stamps the commit but never invents a branch", async () => {
    // The one state where the two stamps read different things off the same
    // probe: git gives a commit but no branch. The commit is true and useful,
    // so it's still recorded; the branch is unknown, and "main" would be a
    // guess about code the user never generated from.
    mockRepoInfo.branch = null;

    const { link, bugCommitSha } = await publish(true);
    expect(link.trackingBranch).toBe("");
    expect(link.generationSha).toBe(SHA);
    expect(bugCommitSha).toBe(SHA);
  });

  it("stamps nothing when the source dir isn't a git repo", async () => {
    mockRepoInfo.branch = null;
    mockRepoInfo.commit = null;

    const { link, bugCommitSha } = await publish(true);
    expect(link.filePath).toBe("src/auth/login.cs");
    expect(link.trackingBranch).toBe("");
    expect(link.generationSha).toBe("");
    expect(bugCommitSha).toBeNull();
  });
});

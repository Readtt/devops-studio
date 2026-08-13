import { describe, expect, it } from "vitest";
import { planViewerTitle } from "./codeViewerTitles";
import type { CodeViewerTab } from "./store/types";

function tab(p: Partial<CodeViewerTab> & { id: number; path: string }): CodeViewerTab {
  return {
    kind: "code-viewer",
    pinned: false,
    title: p.path.split(/[\\/]/).pop()!,
    repoName: null,
    ...p,
  } as CodeViewerTab;
}

describe("planViewerTitle", () => {
  it("titles a lone viewer with the bare basename", () => {
    const plan = planViewerTitle(
      { path: "C:/repo-one/src/auth.ts", repoName: "repo-one" },
      [],
    );
    expect(plan.title).toBe("auth.ts");
    expect(plan.retitle).toEqual([]);
  });

  it("keeps the line range in the title", () => {
    expect(
      planViewerTitle(
        { path: "C:/r/src/auth.ts", repoName: "r", startLine: 12, endLine: 20 },
        [],
      ).title,
    ).toBe("auth.ts:12–20");
    expect(
      planViewerTitle(
        { path: "C:/r/src/auth.ts", repoName: "r", startLine: 12, endLine: 12 },
        [],
      ).title,
    ).toBe("auth.ts:12");
  });

  it("does not prefix when the open tab is the same file (dedup's job)", () => {
    const plan = planViewerTitle(
      { path: "C:/repo-one/src/auth.ts", repoName: "repo-one" },
      [tab({ id: 1, path: "C:/repo-one/src/auth.ts", repoName: "repo-one" })],
    );
    expect(plan.title).toBe("auth.ts");
  });

  it("does not prefix a same-basename file from the SAME repo", () => {
    // Two `index.ts` in one repo are already told apart by the pane header;
    // prefixing both with the same repo name adds nothing.
    const plan = planViewerTitle(
      { path: "C:/repo-one/src/b/index.ts", repoName: "repo-one" },
      [tab({ id: 1, path: "C:/repo-one/src/a/index.ts", repoName: "repo-one" })],
    );
    expect(plan.title).toBe("index.ts");
    expect(plan.retitle).toEqual([]);
  });

  it("prefixes BOTH sides when two repos collide on a basename", () => {
    const plan = planViewerTitle(
      { path: "C:/repo-two/src/index.ts", repoName: "repo-two" },
      [
        tab({
          id: 7,
          path: "C:/repo-one/src/index.ts",
          repoName: "repo-one",
          title: "index.ts",
        }),
      ],
    );
    expect(plan.title).toBe("repo-two/index.ts");
    expect(plan.retitle).toEqual([{ id: 7, title: "repo-one/index.ts" }]);
  });

  it("retitles an existing tab without losing its line range", () => {
    const plan = planViewerTitle(
      { path: "C:/repo-two/src/index.ts", repoName: "repo-two" },
      [
        tab({
          id: 7,
          path: "C:/repo-one/src/index.ts",
          repoName: "repo-one",
          title: "index.ts:40–44",
        }),
      ],
    );
    expect(plan.retitle).toEqual([{ id: 7, title: "repo-one/index.ts:40–44" }]);
  });

  it("doesn't re-prefix a tab that already carries its repo", () => {
    const plan = planViewerTitle(
      { path: "C:/repo-three/src/index.ts", repoName: "repo-three" },
      [
        tab({
          id: 7,
          path: "C:/repo-one/src/index.ts",
          repoName: "repo-one",
          title: "repo-one/index.ts",
        }),
      ],
    );
    expect(plan.title).toBe("repo-three/index.ts");
    expect(plan.retitle).toEqual([]);
  });

  it("leaves an unattributable path unprefixed", () => {
    // No repo claimed it (outside every configured root) — there's no prefix
    // to give it, and the other tab keeps its own title.
    const plan = planViewerTitle(
      { path: "D:/elsewhere/index.ts", repoName: null },
      [tab({ id: 7, path: "C:/repo-one/src/index.ts", repoName: "repo-one" })],
    );
    expect(plan.title).toBe("index.ts");
    expect(plan.retitle).toEqual([]);
  });
});

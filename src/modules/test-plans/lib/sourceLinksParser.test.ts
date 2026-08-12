import { describe, expect, it } from "vitest";
import type { SourceLink } from "@/modules/ado";
import {
  injectSourceLinks,
  parseSourceLinks,
  renderBlock,
} from "./sourceLinksParser";

const OPEN = "<!-- devops-studio:source-links:v1 -->";
const CLOSE = "<!-- /devops-studio:source-links -->";

function link(over: Partial<SourceLink> = {}): SourceLink {
  return {
    repoId: "11111111-2222-3333-4444-555555555555",
    repoName: "repo-one",
    generationBranch: "main",
    generationSha: "9f3c1ab",
    trackingBranch: "main",
    filePath: "src/auth/login.cs",
    symbol: "LoginController.Authenticate",
    lineRange: { start: 42, end: 78 },
    ...over,
  };
}

/** The trip every published case makes: rendered into the ADO description on
 *  publish, parsed back out when the Test Case pane opens. */
function roundTrip(l: SourceLink): SourceLink | undefined {
  return parseSourceLinks(renderBlock([l]))[0];
}

/** Hand-build a block so parsing can be tested against wire text we didn't
 *  serialize ourselves — legacy rows, unknown keys, malformed lines. Fields are
 *  separated by a plain ` / `; only slashes *inside* a value become ` ∕ `. */
function block(...lines: string[]): string {
  return `${OPEN}\n${lines.map((l) => `- ${l}`).join("\n")}\n${CLOSE}`;
}

describe("round-trip", () => {
  it("survives a file path containing slashes", () => {
    expect(roundTrip(link())).toEqual(link());
  });

  it("survives a branch containing slashes", () => {
    const l = link({
      trackingBranch: "feature/2fa",
      generationBranch: "feature/2fa",
    });
    expect(roundTrip(l)).toEqual(l);
  });

  it("keeps a link whose branch was never stamped", () => {
    // "Tag with source branch" off, or a non-git / detached-HEAD source dir.
    // The link is still useful — it just carries no provenance.
    const l = link({ trackingBranch: "", generationBranch: "" });
    const rendered = renderBlock([l]);
    // Not `not.toContain("branch:")` — that would also match generation-branch.
    expect(rendered).not.toContain("/ branch:");
    expect(roundTrip(l)).toEqual(l);
  });

  it("survives a missing symbol and line range", () => {
    const parsed = roundTrip(link({ symbol: null, lineRange: null }));
    expect(parsed?.filePath).toBe("src/auth/login.cs");
    expect(parsed?.symbol).toBeUndefined();
    expect(parsed?.lineRange).toBeUndefined();
  });

  it("carries a generation branch that differs from the tracking branch", () => {
    const l = link({
      generationBranch: "feature/2fa",
      trackingBranch: "main",
    });
    expect(roundTrip(l)).toEqual(l);
  });

  it("carries the generation sha", () => {
    expect(roundTrip(link())?.generationSha).toBe("9f3c1ab");
  });

  it("keeps a repo id distinct from the repo name", () => {
    const l = link({ repoId: "abc-123", repoName: "repo-two" });
    expect(roundTrip(l)?.repoId).toBe("abc-123");
  });

  it("escapes slashes inside values so the separator stays unambiguous", () => {
    // Pins the wire format: ` / ` separates fields, so a value's own slashes
    // must not be plain ASCII slashes. This is why unescape exists.
    expect(renderBlock([link()])).toContain("file: src ∕ auth ∕ login.cs");
  });
});

describe("parseSourceLinks", () => {
  it("ignores unknown keys instead of failing the line", () => {
    // Forward compatibility: a newer build may add keys this one can't read.
    const parsed = parseSourceLinks(
      block(
        "repo: repo-one / branch: main / file: src ∕ app.ts / some-future-key: whatever",
      ),
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0].filePath).toBe("src/app.ts");
    expect(parsed[0].repoName).toBe("repo-one");
  });

  it("drops a line with no repo", () => {
    expect(parseSourceLinks(block("branch: main / file: src ∕ app.ts"))).toEqual(
      [],
    );
  });

  it("drops a line with no file", () => {
    expect(parseSourceLinks(block("repo: repo-one / branch: main"))).toEqual([]);
  });

  it("reads a link published before the unescape existed", () => {
    const parsed = parseSourceLinks(
      block(
        "repo: repo-one / branch: feature ∕ 2fa / file: src ∕ auth ∕ login.cs / sha: 9f3c1ab",
      ),
    );
    expect(parsed[0].filePath).toBe("src/auth/login.cs");
    expect(parsed[0].trackingBranch).toBe("feature/2fa");
  });

  it("tolerates values that were never escaped", () => {
    const parsed = parseSourceLinks(block("repo: repo-one / file: app.ts"));
    expect(parsed[0].filePath).toBe("app.ts");
    expect(parsed[0].trackingBranch).toBe("");
  });

  it("reads every link in a multi-line block", () => {
    const links = [link(), link({ filePath: "src/auth/sms.cs", symbol: null })];
    expect(parseSourceLinks(renderBlock(links))).toHaveLength(2);
  });

  it("returns nothing when there's no block", () => {
    expect(parseSourceLinks("Just a description.")).toEqual([]);
    expect(parseSourceLinks(`${OPEN}\n- repo: x / file: y`)).toEqual([]);
  });
});

describe("injectSourceLinks", () => {
  it("appends a block to a description that has none", () => {
    const out = injectSourceLinks("Repro steps.", [link()]);
    expect(out.startsWith("Repro steps.")).toBe(true);
    expect(parseSourceLinks(out)).toHaveLength(1);
  });

  it("replaces an existing block rather than stacking a second one", () => {
    const first = injectSourceLinks("Repro steps.", [link()]);
    const second = injectSourceLinks(first, [
      link({ filePath: "src/auth/sms.cs" }),
    ]);
    expect(second.split(OPEN)).toHaveLength(2);
    expect(parseSourceLinks(second).map((l) => l.filePath)).toEqual([
      "src/auth/sms.cs",
    ]);
  });

  it("keeps description text that follows the block", () => {
    const withBlock = `Before.\n${renderBlock([link()])}\nAfter.`;
    expect(injectSourceLinks(withBlock, [link()])).toContain("After.");
  });
});

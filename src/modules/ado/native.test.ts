import { describe, expect, it, vi } from "vitest";

// `native.ts` reaches for Tauri at import time; the URL builders under test are
// pure, so a stub is enough to get the module loaded.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { buildAdoReposWebUrl } from "./native";

const BASE = {
  orgUrl: "https://dev.azure.com/contoso",
  project: "Payments",
  repoName: "Payments.Api",
  filePath: "src/Auth/Login.cs",
};

describe("buildAdoReposWebUrl", () => {
  it("pins the file to the branch the link recorded", () => {
    const url = buildAdoReposWebUrl({ ...BASE, branch: "feature/2fa" });
    expect(url).toContain("version=GBfeature%2F2fa");
    expect(url).toContain("path=src%2FAuth%2FLogin.cs");
  });

  // A case published with "Tag with source branch" off — or from a detached
  // HEAD — deliberately records no branch. Inventing `main` for it 404s on
  // every repo whose default is `master` or `develop`; omitting `version`
  // lands on whatever the repo's own default actually is.
  it("omits the version when the link carries no branch", () => {
    expect(buildAdoReposWebUrl(BASE)).not.toContain("version=");
    expect(buildAdoReposWebUrl({ ...BASE, branch: "" })).not.toContain(
      "version=",
    );
  });

  it("keeps the line range when there is one", () => {
    const url = buildAdoReposWebUrl({
      ...BASE,
      branch: "main",
      lineRange: { start: 42, end: 78 },
    });
    expect(url).toContain("line=42");
    expect(url).toContain("lineEnd=78");
  });
});

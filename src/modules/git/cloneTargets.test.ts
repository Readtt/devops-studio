import { describe, expect, it } from "vitest";

import { resolveCloneTargets, sanitizeDir } from "./cloneTargets";

describe("sanitizeDir", () => {
  it("strips path-significant and illegal characters", () => {
    expect(sanitizeDir("my:repo")).toBe("my-repo");
    expect(sanitizeDir("a/b\\c")).toBe("a-b-c");
    expect(sanitizeDir('we<i>rd?"|*')).toBe("we-i-rd");
  });

  it("trims whitespace and leading/trailing separators", () => {
    expect(sanitizeDir("  spaced  ")).toBe("spaced");
    expect(sanitizeDir("/leading/")).toBe("leading");
  });
});

describe("resolveCloneTargets", () => {
  it("keeps distinct names as-is, in order", () => {
    const out = resolveCloneTargets([
      { id: "1", name: "web-app", project: "Platform" },
      { id: "2", name: "api-gateway", project: "Platform" },
    ]);
    expect(out.map((t) => t.folder)).toEqual(["web-app", "api-gateway"]);
  });

  it("disambiguates same-named repos by project", () => {
    const out = resolveCloneTargets([
      { id: "1", name: "web", project: "Platform" },
      { id: "2", name: "web", project: "Design" },
    ]);
    expect(out.map((t) => t.folder)).toEqual(["web", "web-Design"]);
  });

  it("is case-insensitive so Windows/macOS folders don't collide", () => {
    const out = resolveCloneTargets([
      { id: "1", name: "Web", project: null },
      { id: "2", name: "web", project: null },
    ]);
    // No project to disambiguate → numeric fallback, keyed case-insensitively.
    expect(out[1].folder.toLowerCase()).not.toBe(out[0].folder.toLowerCase());
    expect(out.map((t) => t.folder)).toEqual(["Web", "web-2"]);
  });

  it("falls back to a numeric suffix when the project suffix also clashes", () => {
    const out = resolveCloneTargets([
      { id: "1", name: "web", project: "Platform" },
      { id: "2", name: "web", project: "Platform" },
      { id: "3", name: "web", project: "Platform" },
    ]);
    expect(out.map((t) => t.folder)).toEqual(["web", "web-Platform", "web-Platform-2"]);
  });

  it("falls back to a numeric suffix when the project is missing", () => {
    const out = resolveCloneTargets([
      { id: "1", name: "tools", project: null },
      { id: "2", name: "tools", project: null },
      { id: "3", name: "tools", project: null },
    ]);
    expect(out.map((t) => t.folder)).toEqual(["tools", "tools-2", "tools-3"]);
  });

  it("handles a name that sanitizes to empty", () => {
    const out = resolveCloneTargets([{ id: "1", name: "///", project: null }]);
    expect(out[0].folder).toBe("repo");
  });
});

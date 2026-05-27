import { describe, expect, it } from "vitest";
import { fmtRange, isCodeRefToken, parseCodeRef, shortenPath } from "./codeRef";

describe("parseCodeRef", () => {
  it("returns null for empty / whitespace / bare scheme", () => {
    expect(parseCodeRef("")).toBeNull();
    expect(parseCodeRef("   ")).toBeNull();
    expect(parseCodeRef("file:")).toBeNull();
  });

  it("parses a path with no line range", () => {
    expect(parseCodeRef("src/foo.ts")).toEqual({
      path: "src/foo.ts",
      ranges: [],
    });
  });

  it("parses a single line", () => {
    expect(parseCodeRef("src/foo.ts:42")).toEqual({
      path: "src/foo.ts",
      ranges: [{ start: 42, end: undefined }],
    });
  });

  it("parses a hyphen range and an en-dash range", () => {
    expect(parseCodeRef("src/foo.ts:42-58")?.ranges).toEqual([
      { start: 42, end: 58 },
    ]);
    expect(parseCodeRef("src/foo.ts:42–58")?.ranges).toEqual([
      { start: 42, end: 58 },
    ]);
  });

  it("keeps every range in a multi-range ref (the regression that started this)", () => {
    expect(parseCodeRef("foo.cs:376,594-600,1080")?.ranges).toEqual([
      { start: 376, end: undefined },
      { start: 594, end: 600 },
      { start: 1080, end: undefined },
    ]);
  });

  it("tolerates per-range leading ':' and 'L' markers", () => {
    expect(parseCodeRef("foo.cs:L376, :594-600")?.ranges).toEqual([
      { start: 376, end: undefined },
      { start: 594, end: 600 },
    ]);
  });

  it("splits a Windows absolute path at the line colon, not the drive colon", () => {
    expect(parseCodeRef("C:\\repo\\Foo.cs:42")).toEqual({
      path: "C:\\repo\\Foo.cs",
      ranges: [{ start: 42, end: undefined }],
    });
  });

  it("strips a leading file: scheme", () => {
    expect(parseCodeRef("file:src/Foo.cshtml:42")).toEqual({
      path: "src/Foo.cshtml",
      ranges: [{ start: 42, end: undefined }],
    });
  });

  it("keeps dotted directory + file segments intact", () => {
    expect(parseCodeRef("MyApp.Web/Controllers/HomeController.cs:120")).toEqual({
      path: "MyApp.Web/Controllers/HomeController.cs",
      ranges: [{ start: 120, end: undefined }],
    });
  });
});

describe("isCodeRefToken", () => {
  it("accepts a back-tickable file ref carrying a line/range", () => {
    expect(isCodeRefToken("src/foo.ts:42")).toBe(true);
    expect(isCodeRefToken("foo.cs:376,594-600,1080")).toBe(true);
    expect(isCodeRefToken("iSyncKit2/RESTAPI/Controllers/AccountsController.cs:1")).toBe(true);
    expect(isCodeRefToken("  MyApp.Web/Controllers/HomeController.cs:120  ")).toBe(true);
  });

  it("rejects tokens that aren't a real file ref (so inline code stays code)", () => {
    expect(isCodeRefToken("package.json")).toBe(false); // no line spec
    expect(isCodeRefToken("npm run build")).toBe(false);
    expect(isCodeRefToken("someVariable")).toBe(false);
    expect(isCodeRefToken("config:")).toBe(false);
    expect(isCodeRefToken("foo.xyz:42")).toBe(false); // extension not allowlisted
  });
});

describe("fmtRange", () => {
  it("collapses a single-line range and renders an en-dash span", () => {
    expect(fmtRange({ start: 42 })).toBe("42");
    expect(fmtRange({ start: 42, end: 42 })).toBe("42");
    expect(fmtRange({ start: 42, end: 58 })).toBe("42–58");
  });
});

describe("shortenPath", () => {
  it("keeps short paths and tails long ones to the last two segments", () => {
    expect(shortenPath("src/foo.ts")).toBe("src/foo.ts");
    expect(shortenPath("src/auth/very/deep/loginController.ts")).toBe(
      "…/deep/loginController.ts",
    );
  });

  it("normalizes backslashes for display", () => {
    expect(shortenPath("src\\foo.ts")).toBe("src/foo.ts");
  });
});

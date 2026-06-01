import { describe, expect, it } from "vitest";
import { PatchSchema, parsePatch } from "./patchSchema";

describe("PatchSchema / parsePatch", () => {
  const valid = {
    path: "src/auth/login.ts",
    startLine: 42,
    endLine: 48,
    replacement: "const x = 1;",
  };

  it("accepts a well-formed patch", () => {
    const r = parsePatch(JSON.stringify(valid));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(valid);
  });

  it("accepts an insert (endLine = startLine - 1, so endLine 0 is legal)", () => {
    const r = parsePatch(
      JSON.stringify({ ...valid, startLine: 1, endLine: 0 }),
    );
    expect(r.ok).toBe(true);
  });

  it("rejects an empty path", () => {
    const r = parsePatch(JSON.stringify({ ...valid, path: "" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/path/);
  });

  it("rejects a non-positive startLine", () => {
    const r = parsePatch(JSON.stringify({ ...valid, startLine: 0 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/startLine/);
  });

  it("rejects a missing replacement", () => {
    const { replacement: _omit, ...rest } = valid;
    const r = parsePatch(JSON.stringify(rest));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/replacement/);
  });

  it("rejects malformed JSON without throwing", () => {
    const r = parsePatch("{ not json");
    expect(r.ok).toBe(false);
  });

  it("PatchSchema rejects a fractional startLine", () => {
    expect(PatchSchema.safeParse({ ...valid, startLine: 4.5 }).success).toBe(
      false,
    );
  });
});

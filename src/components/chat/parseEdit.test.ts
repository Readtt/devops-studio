import { describe, expect, it } from "vitest";
import { parseEdit } from "./ApplyEditCard";

// parseEdit is the single source of truth for validating `devops-edit` blocks;
// ChatMarkdown's render-time guard renders a warning when it returns !ok.
describe("parseEdit", () => {
  it("accepts a rename edit", () => {
    const r = parseEdit(
      JSON.stringify({ kind: "rename", caseId: 15310, title: "A clearer title" }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.kind).toBe("rename");
  });

  it("accepts a rewrite-steps edit", () => {
    const r = parseEdit(
      JSON.stringify({
        kind: "rewrite-steps",
        caseId: 15310,
        steps: [{ action: "Navigate", expected: "Form renders" }],
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("accepts a create-bug edit", () => {
    const r = parseEdit(
      JSON.stringify({
        kind: "create-bug",
        title: "Rate-limit ignored on SMS fallback",
        severity: "2 - High",
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("maps an unrecognized kind to \"unknown\" (the render guard rejects that)", () => {
    const r = parseEdit(JSON.stringify({ kind: "frobnicate", caseId: 1 }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.kind).toBe("unknown");
  });

  it("returns !ok on malformed JSON without throwing", () => {
    const r = parseEdit("{ not json");
    expect(r.ok).toBe(false);
  });

  it("returns !ok when the payload isn't a JSON object", () => {
    const r = parseEdit(JSON.stringify("just a string"));
    expect(r.ok).toBe(false);
  });
});

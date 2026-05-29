import { describe, expect, it, vi } from "vitest";
import { extractBatchJson, parseDraftBatch } from "./draftBatchSchema";

describe("extractBatchJson", () => {
  it("unwraps a ```json fenced block", () => {
    const out = extractBatchJson('```json\n{"cases":[]}\n```');
    expect(out).toBe('{"cases":[]}');
  });

  it("unwraps a bare ``` fence", () => {
    expect(extractBatchJson("```\n{\"a\":1}\n```")).toBe('{"a":1}');
  });

  it("slices the object out of surrounding prose", () => {
    const out = extractBatchJson('Sure! Here you go: {"cases":[]} — done.');
    expect(out).toBe('{"cases":[]}');
  });

  it("returns the input unchanged when there's no object", () => {
    expect(extractBatchJson("no json here")).toBe("no json here");
  });
});

describe("parseDraftBatch", () => {
  it("parses a well-formed batch", () => {
    const batch = parseDraftBatch(
      JSON.stringify({
        cases: [
          {
            title: "Sign in with valid credentials",
            steps: [{ action: "Enter creds", expected: "Logged in" }],
          },
        ],
        bugs: [],
      }),
    );
    expect(batch.cases).toHaveLength(1);
    expect(batch.cases[0].title).toBe("Sign in with valid credentials");
    // Schema defaults fill in the optional arrays.
    expect(batch.cases[0].tags).toEqual([]);
    expect(batch.bugs).toEqual([]);
  });

  it("parses a fenced batch wrapped in prose", () => {
    const text =
      'Here are the cases:\n```json\n{"cases":[{"title":"A valid title here","steps":[{"action":"x","expected":"y"}]}],"bugs":[]}\n```';
    expect(parseDraftBatch(text).cases).toHaveLength(1);
  });

  it("returns an empty batch (and logs) on malformed JSON instead of throwing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const batch = parseDraftBatch("{ not valid json");
    expect(batch).toEqual({ cases: [], bugs: [] });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("returns an empty batch when the schema rejects the shape", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // title too short → DraftCaseLLMSchema rejects → permissive empty batch.
    const batch = parseDraftBatch(
      JSON.stringify({ cases: [{ title: "x", steps: [] }], bugs: [] }),
    );
    expect(batch).toEqual({ cases: [], bugs: [] });
    warn.mockRestore();
  });
});

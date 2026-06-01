import { describe, expect, it, vi } from "vitest";
import {
  clampBugLinks,
  extractBatchJson,
  parseDraftBatch,
  salvageDraftBatch,
  type DraftBatchLLM,
} from "./draftBatchSchema";

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

describe("salvageDraftBatch (partial-batch acceptance)", () => {
  it("keeps the valid cases and drops only the malformed one", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const batch = salvageDraftBatch(
      JSON.stringify({
        cases: [
          {
            title: "A perfectly valid case title",
            steps: [{ action: "do x", expected: "y happens" }],
          },
          { title: "x", steps: [] }, // invalid: title too short, no steps
          {
            title: "Another perfectly valid case",
            steps: [{ action: "do z", expected: "w happens" }],
          },
        ],
        bugs: [],
      }),
    );
    expect(batch.cases).toHaveLength(2);
    expect(batch.cases.map((c) => c.title)).toEqual([
      "A perfectly valid case title",
      "Another perfectly valid case",
    ]);
    expect(err).toHaveBeenCalled(); // dropped index logged
    err.mockRestore();
  });

  it("salvages from fenced/prose-wrapped text", () => {
    const text =
      'Here:\n```json\n{"cases":[{"title":"A valid salvageable title","steps":[{"action":"a","expected":"b"}]}],"bugs":[]}\n```';
    expect(salvageDraftBatch(text).cases).toHaveLength(1);
  });

  it("returns an empty batch when nothing parses", () => {
    expect(salvageDraftBatch("not json at all")).toEqual({
      cases: [],
      bugs: [],
    });
  });
});

describe("clampBugLinks", () => {
  const mk = (linkedDraftCaseIndex: number | null): DraftBatchLLM => ({
    cases: [
      {
        title: "Only case in this batch",
        description: "",
        steps: [{ action: "a", expected: "b" }],
        tags: [],
        rationale: "",
        sourceLinks: [],
      },
    ],
    bugs: [
      {
        title: "A bug linked to a case",
        reproSteps: "steps",
        severity: "2 - High",
        linkedDraftCaseIndex,
        codeRefs: [],
      },
    ],
  });

  it("keeps an in-range link untouched", () => {
    const out = clampBugLinks(mk(0));
    expect(out.bugs[0].linkedDraftCaseIndex).toBe(0);
  });

  it("nulls an out-of-range link (and logs)", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const out = clampBugLinks(mk(5));
    expect(out.bugs[0].linkedDraftCaseIndex).toBeNull();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

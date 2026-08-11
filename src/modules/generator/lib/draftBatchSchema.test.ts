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

// The `finish: length` shape: the provider cut the answer at the output-token
// cap, so the JSON ends mid-structure and JSON.parse throws on all of it. The
// complete case objects that arrived before the cut are real, publishable work
// — "3 of 5 cases, truncated" instead of nothing.
describe("salvageDraftBatch (truncated mid-structure — finish: length)", () => {
  const caseObj = (title: string) =>
    `{"title":"${title}","steps":[{"action":"do a","expected":"see b"}]}`;

  it("keeps the complete cases when the cut lands inside a later case", () => {
    const text = `{"cases":[${caseObj("First complete case title")},${caseObj(
      "Second complete case title",
    )},{"title":"Third case the cut landed i`;
    const batch = salvageDraftBatch(text);
    expect(batch.cases.map((c) => c.title)).toEqual([
      "First complete case title",
      "Second complete case title",
    ]);
    expect(batch.bugs).toEqual([]);
  });

  it("keeps all cases and the complete bugs when the cut lands inside bugs", () => {
    const bug = `{"title":"A complete bug title","reproSteps":"PRECONDITION:\\nn/a","severity":"2 - High"}`;
    const text = `{"cases":[${caseObj(
      "The only complete case here",
    )}],"bugs":[${bug},{"title":"Bug the cut land`;
    const batch = salvageDraftBatch(text);
    expect(batch.cases).toHaveLength(1);
    expect(batch.bugs).toHaveLength(1);
    expect(batch.bugs[0].title).toBe("A complete bug title");
  });

  it("is not fooled by braces and escaped quotes inside string values", () => {
    const tricky = `{"title":"Handles {braces} and \\"quotes\\" in values","steps":[{"action":"type {x} then \\"y\\"","expected":"renders ]}"}]}`;
    const text = `{"cases":[${tricky},{"title":"cut here`;
    const batch = salvageDraftBatch(text);
    expect(batch.cases).toHaveLength(1);
    expect(batch.cases[0].title).toBe('Handles {braces} and "quotes" in values');
  });

  it("recovers from a fenced block whose closing fence never arrived", () => {
    const text =
      '```json\n{"cases":[' + caseObj("Fenced but complete case title") + ',{"ti';
    expect(salvageDraftBatch(text).cases).toHaveLength(1);
  });

  it("drops truncated-and-invalid items but keeps valid ones (per-item safeParse still applies)", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // Second case is COMPLETE but invalid (short title) — dropped by schema,
    // not by the scanner; third is cut — dropped by the scanner.
    const text = `{"cases":[${caseObj(
      "Valid and complete case title",
    )},{"title":"x","steps":[]},{"title":"cut mid`;
    const batch = salvageDraftBatch(text);
    expect(batch.cases).toHaveLength(1);
    err.mockRestore();
  });

  it("a mention of the key inside prose doesn't derail the scan", () => {
    const text = `The "cases" I found are below.\n{"cases":[${caseObj(
      "Case after a prose mention",
    )},{"cut`;
    expect(salvageDraftBatch(text).cases).toHaveLength(1);
  });

  // The scanner used to return on the FIRST `"cases": [` it found, so an answer
  // that opened by restating the schema — or the suite's existing cases —
  // salvaged the example and silently discarded everything the model actually
  // wrote. A cut lands at the END, so the real payload is the last array.
  it("takes the LAST array under the key, not an example echoed in front of it", () => {
    const text =
      `Following the shape {"cases":[{"title":"Example only","steps":[]}]}, here is the batch:\n` +
      `{"cases":[${caseObj("First real case of the batch")},${caseObj(
        "Second real case of the batch",
      )},{"title":"cut here`;
    expect(salvageDraftBatch(text).cases.map((c) => c.title)).toEqual([
      "First real case of the batch",
      "Second real case of the batch",
    ]);
  });

  // …but an empty later occurrence must not displace a good earlier one, or a
  // trailing `"cases": []` in a closing note would zero the whole salvage.
  it("keeps the earlier array when a later one yields nothing", () => {
    const text = `{"cases":[${caseObj(
      "The batch that actually landed",
    )},{"cut`.concat('\n(no more "cases": [ ] to report)');
    expect(salvageDraftBatch(text).cases).toHaveLength(1);
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

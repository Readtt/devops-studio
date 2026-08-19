import { describe, it, expect, vi, beforeEach } from "vitest";

const getCase = vi.fn();
const evaluateCaseConfidence = vi.fn();
const saveConfidence = vi.fn();

vi.mock("@/modules/ado", () => ({ getCase: (...a: unknown[]) => getCase(...a) }));
vi.mock("./evaluateCaseConfidence", () => ({
  evaluateCaseConfidence: (...a: unknown[]) => evaluateCaseConfidence(...a),
  // Resolved once per batch by the orchestrator; the git probe behind it is
  // exercised in its own module's tests.
  readRepoSources: () => Promise.resolve([]),
}));
// fromTestCase is a pure adapter; identity is fine for the orchestrator.
vi.mock("./runConfidenceEval", () => ({ fromTestCase: (tc: unknown) => tc }));
vi.mock("./confidenceApi", () => ({
  saveConfidence: (...a: unknown[]) => saveConfidence(...a),
}));

import { scoreCases, type ScoreCallbacks, type ScoreTarget } from "./runSuiteConfidence";

const targets: ScoreTarget[] = [
  { id: 1, title: "one" },
  { id: 2, title: "two" },
  { id: 3, title: "three" },
];

/** Callbacks with inert defaults; tests override only what they assert on. */
function callbacks(over: Partial<ScoreCallbacks> = {}): ScoreCallbacks {
  return {
    signal: new AbortController().signal,
    claim: () => true,
    release: () => {},
    onCaseStart: () => {},
    onCaseDone: () => {},
    onCaseSkip: () => {},
    onCaseFailure: () => {},
    ...over,
  };
}

function abortError() {
  return new DOMException("cancelled", "AbortError");
}

beforeEach(() => {
  getCase.mockReset();
  evaluateCaseConfidence.mockReset();
  saveConfidence.mockReset();
  getCase.mockImplementation(async (id: number) => ({ id, steps: [] }));
  evaluateCaseConfidence.mockResolvedValue({ predictedOutcome: "Pass" });
  saveConfidence.mockResolvedValue(undefined);
});

describe("scoreCases", () => {
  it("scores every case in order, persists, reports, and releases each", async () => {
    const order: string[] = [];
    const reported: Array<[number, unknown]> = [];
    const released: number[] = [];
    await scoreCases(
      targets,
      callbacks({
        onCaseStart: (id) => order.push(`start:${id}`),
        onCaseDone: (id, v) => {
          order.push(`done:${id}`);
          reported.push([id, v]);
        },
        onCaseFailure: (id) => order.push(`fail:${id}`),
        release: (id) => released.push(id),
      }),
    );
    expect(order).toEqual([
      "start:1",
      "done:1",
      "start:2",
      "done:2",
      "start:3",
      "done:3",
    ]);
    expect(saveConfidence).toHaveBeenCalledTimes(3);
    expect(reported).toEqual([
      [1, { predictedOutcome: "Pass" }],
      [2, { predictedOutcome: "Pass" }],
      [3, { predictedOutcome: "Pass" }],
    ]);
    expect(released).toEqual([1, 2, 3]); // reservation released for every case
  });

  it("skips a case it cannot claim and keeps going", async () => {
    const skipped: number[] = [];
    const done: number[] = [];
    await scoreCases(
      targets,
      callbacks({
        claim: (id) => id !== 2, // case 2 is owned by a manual re-analyze
        onCaseSkip: (id) => skipped.push(id),
        onCaseDone: (id) => done.push(id),
      }),
    );
    expect(skipped).toEqual([2]);
    expect(done).toEqual([1, 3]);
    expect(getCase).not.toHaveBeenCalledWith(2); // never scored the claimed case
  });

  it("continues past a failing case and records it", async () => {
    evaluateCaseConfidence.mockImplementation(async (c: { id?: number }) => {
      if (c?.id === 2) throw new Error("boom");
      return { predictedOutcome: "Pass" };
    });
    const done: number[] = [];
    const failed: Array<{ id: number; message: string }> = [];
    const released: number[] = [];
    await scoreCases(
      targets,
      callbacks({
        onCaseDone: (id) => done.push(id),
        onCaseFailure: (id, _t, e) =>
          failed.push({ id, message: (e as Error).message }),
        release: (id) => released.push(id),
      }),
    );
    expect(done).toEqual([1, 3]);
    expect(failed).toEqual([{ id: 2, message: "boom" }]);
    expect(released).toEqual([1, 2, 3]); // released even on failure
  });

  it("stops immediately when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const events: string[] = [];
    await scoreCases(
      targets,
      callbacks({
        signal: ac.signal,
        onCaseStart: (id) => events.push(`start:${id}`),
        claim: () => {
          events.push("claim");
          return true;
        },
      }),
    );
    expect(events).toEqual([]); // never even claimed
    expect(getCase).not.toHaveBeenCalled();
  });

  it("an AbortError mid-case stops the batch without recording a failure", async () => {
    evaluateCaseConfidence.mockImplementation(async (c: { id?: number }) => {
      if (c?.id === 2) throw abortError();
      return { predictedOutcome: "Pass" };
    });
    const done: number[] = [];
    const failed: number[] = [];
    const released: number[] = [];
    await scoreCases(
      targets,
      callbacks({
        onCaseDone: (id) => done.push(id),
        onCaseFailure: (id) => failed.push(id),
        release: (id) => released.push(id),
      }),
    );
    expect(done).toEqual([1]); // stopped at the abort; 3 never ran
    expect(failed).toEqual([]); // abort is not a failure
    expect(released).toEqual([1, 2]); // both claimed cases released
  });

  it("treats any error after cancel as an abort, not a failure", async () => {
    // Some providers surface a generic error (not a named AbortError) when the
    // request is aborted — the signal check must still classify it as a cancel.
    const ac = new AbortController();
    evaluateCaseConfidence.mockImplementation(async (c: { id?: number }) => {
      if (c?.id === 1) {
        ac.abort();
        throw new Error("network blip");
      }
      return { predictedOutcome: "Pass" };
    });
    const done: number[] = [];
    const failed: number[] = [];
    await scoreCases(
      targets,
      callbacks({
        signal: ac.signal,
        onCaseDone: (id) => done.push(id),
        onCaseFailure: (id) => failed.push(id),
      }),
    );
    expect(failed).toEqual([]); // generic error during cancel is not a failure
    expect(done).toEqual([]); // and the batch stops
  });

  it("does not save or complete a case cancelled while it was scoring", async () => {
    const ac = new AbortController();
    evaluateCaseConfidence.mockImplementation(async (c: { id?: number }) => {
      if (c?.id === 1) {
        ac.abort(); // cancelled mid-evaluation, but the call still resolves
        return { predictedOutcome: "Pass" };
      }
      return { predictedOutcome: "Pass" };
    });
    const done: number[] = [];
    const released: number[] = [];
    await scoreCases(
      targets,
      callbacks({
        signal: ac.signal,
        onCaseDone: (id) => done.push(id),
        release: (id) => released.push(id),
      }),
    );
    expect(saveConfidence).not.toHaveBeenCalled(); // post-evaluate abort guard
    expect(done).toEqual([]);
    expect(released).toEqual([1]); // the in-flight case is still released
  });
});

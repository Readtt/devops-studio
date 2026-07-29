import { describe, it, expect } from "vitest";
import {
  canOfferResume,
  classifyForResume,
  isResumableKind,
  matchErrorKind,
  STALL_MESSAGE,
  type ResumeErrorKind,
} from "./errorClass";

describe("matchErrorKind", () => {
  const cases: Array<[ResumeErrorKind, string[]]> = [
    ["rate-limit", ["429", "Rate limit reached", "too many requests"]],
    ["overloaded", ["529", "Overloaded", "503 service unavailable"]],
    [
      "no-credits",
      [
        "402",
        "insufficient credits",
        "Your credit balance is too low to access the API",
        "payment required",
      ],
    ],
    ["network", ["fetch failed", "ENOTFOUND api.openai.com", "connection reset"]],
    [
      "auth",
      [
        "401",
        "invalid api key",
        "invalid x-api-key",
        "Unauthorized",
        "No API key configured for anthropic",
      ],
    ],
    [
      "context-overflow",
      [
        "context length exceeded",
        "maximum context",
        "too many tokens",
        "prompt is too long",
      ],
    ],
  ];

  for (const [kind, messages] of cases) {
    for (const message of messages) {
      it(`"${message}" → ${kind}`, () => {
        expect(matchErrorKind(message)).toBe(kind);
      });
    }
  }

  it("matches the stall literal the Rust proxy emits, and any suffixed form", () => {
    expect(matchErrorKind(STALL_MESSAGE)).toBe("stall");
    expect(matchErrorKind(`${STALL_MESSAGE} (step 4 of 12)`)).toBe("stall");
  });

  it("falls back to unknown for anything unrecognised", () => {
    expect(matchErrorKind("the model said something odd")).toBe("unknown");
    expect(matchErrorKind("")).toBe("unknown");
  });

  // The point of the shared classifier: the strings GeneratorPane's classifyError
  // and testKey already match must land in the right bucket here too.
  it("buckets real provider messages the app already pattern-matches elsewhere", () => {
    expect(
      matchErrorKind(
        "rate_limit_error: This request would exceed your organization's rate limit of 400,000 input tokens per minute",
      ),
    ).toBe("rate-limit");
    expect(matchErrorKind("overloaded_error: upstream is overloaded")).toBe(
      "overloaded",
    );
    expect(matchErrorKind("You exceeded your current quota (insufficient_quota)")).toBe(
      "no-credits",
    );
    expect(
      matchErrorKind(
        "This model's maximum context length is 128000 tokens, however you requested 190000",
      ),
    ).toBe("context-overflow");
  });

  // Precedence pins: a rate-limit body routinely quotes token counts, and 402 is
  // a 4xx like any other. Getting either wrong mislabels a resumable failure —
  // and for the overflow case would hide Resume entirely.
  it("prefers the specific kind when a message could match two", () => {
    expect(
      matchErrorKind("429 too many requests: token limit, reduce the length"),
    ).toBe("rate-limit");
    expect(matchErrorKind("402 payment required: rate limit tier")).toBe(
      "no-credits",
    );
    expect(matchErrorKind(`${STALL_MESSAGE} — network timeout`)).toBe("stall");
  });
});

describe("isResumableKind", () => {
  it("is false only for context-overflow", () => {
    expect(isResumableKind("context-overflow")).toBe(false);
    for (const kind of ["rate-limit", "no-credits", "stall", "abort", "unknown"] as ResumeErrorKind[]) {
      expect(isResumableKind(kind)).toBe(true);
    }
  });

  it("agrees with classifyForResume's resumable flag — one shared table, not two", () => {
    for (const message of ["429", "402", STALL_MESSAGE, "maximum context length", "unrecognised"]) {
      const { kind, resumable } = classifyForResume(new Error(message));
      expect(resumable).toBe(isResumableKind(kind));
    }
  });
});

describe("classifyForResume", () => {
  it("identifies an abort by name, before any pattern matching", () => {
    expect(classifyForResume(new DOMException("Request aborted", "AbortError")))
      .toEqual({ kind: "abort", resumable: true });
    // A plain object carrying the name is enough — surfaces rethrow all sorts.
    expect(classifyForResume({ name: "AbortError", message: "429" })).toEqual({
      kind: "abort",
      resumable: true,
    });
  });

  it("reads the message off an Error", () => {
    expect(classifyForResume(new Error("429 rate limit")).kind).toBe("rate-limit");
  });

  it("reads a nested cause when the SDK wraps the transport failure", () => {
    // Object.assign rather than the ErrorOptions ctor — that overload needs the
    // ES2022 lib and this project targets ES2020.
    const wrapped = Object.assign(new Error("Failed after 6 retries"), {
      cause: new Error("ENOTFOUND api.anthropic.com"),
    });
    expect(classifyForResume(wrapped).kind).toBe("network");
  });

  it("survives non-Error throwables", () => {
    expect(classifyForResume("402 payment required").kind).toBe("no-credits");
    expect(classifyForResume(null).kind).toBe("unknown");
    expect(classifyForResume(undefined).kind).toBe("unknown");
    expect(classifyForResume({}).kind).toBe("unknown");
  });

  // A resumed request replays the transcript on top of the same prompt, so it is
  // a strict superset of the one that already didn't fit — guaranteed to fail
  // again. Every other kind clears once the user waits / tops up / fixes the key.
  it("marks only context-overflow as non-resumable", () => {
    expect(classifyForResume(new Error("maximum context length")).resumable).toBe(
      false,
    );
    for (const message of [
      "429",
      "529 overloaded",
      "402 insufficient credits",
      "fetch failed",
      STALL_MESSAGE,
      "401 invalid api key",
      "something we've never seen",
    ]) {
      expect(classifyForResume(new Error(message)).resumable).toBe(true);
    }
  });
});

// The UI gate GeneratorPane and CommitReviewPane both call before offering a
// Resume button — one table so the two surfaces can't drift.
describe("canOfferResume", () => {
  it("is resumable when there's no outcome at all — an unflushed crash", () => {
    expect(canOfferResume(null)).toBe(true);
    expect(canOfferResume(undefined)).toBe(true);
  });

  it("is true for step_cap and cancelled — both left a continuable checkpoint", () => {
    expect(canOfferResume({ kind: "step_cap" })).toBe(true);
    expect(canOfferResume({ kind: "cancelled" })).toBe(true);
  });

  it("is false for empty and schema_violation — the model answered with nothing worth continuing", () => {
    expect(canOfferResume({ kind: "empty" })).toBe(false);
    expect(canOfferResume({ kind: "schema_violation" })).toBe(false);
  });

  it("for kind 'error', prefers the recorded errorKind over reclassifying", () => {
    expect(canOfferResume({ kind: "error", errorKind: "context-overflow" })).toBe(
      false,
    );
    expect(canOfferResume({ kind: "error", errorKind: "rate-limit" })).toBe(true);
  });

  it("falls back to matchErrorKind(errorMessage) when errorKind wasn't recorded", () => {
    expect(
      canOfferResume({ kind: "error" }, "maximum context length exceeded"),
    ).toBe(false);
    expect(canOfferResume({ kind: "error" }, "429 rate limit")).toBe(true);
  });

  it("is false for any other/unrecognised kind", () => {
    expect(canOfferResume({ kind: "something-new" })).toBe(false);
  });
});

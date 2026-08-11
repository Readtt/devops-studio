import { describe, it, expect } from "vitest";
import {
  canOfferResume,
  canRaiseOutputCap,
  classifyForResume,
  emptyAnswerCause,
  isResumableKind,
  matchErrorKind,
  resumeUnavailableReason,
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
  // context-overflow used to be the one hard no, because resume replayed the
  // transcript verbatim and a replay of a request that didn't fit cannot fit.
  // resumeBudget / resumeArgs now compact before replaying — at a tightened
  // budget precisely when the previous attempt overflowed — so the resumed
  // request is a subset, and the carve-out that cost users their whole
  // transcript is gone.
  it("is true for every kind, overflow included", () => {
    for (const kind of [
      "rate-limit",
      "overloaded",
      "no-credits",
      "network",
      "stall",
      "auth",
      "context-overflow",
      "abort",
      "unknown",
    ] as ResumeErrorKind[]) {
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

  it("marks every classified failure resumable, overflow included", () => {
    for (const message of [
      "maximum context length",
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

  it("is false for empty and schema_violation with no progress recorded — an un-updated caller fails closed", () => {
    expect(canOfferResume({ kind: "empty" })).toBe(false);
    expect(canOfferResume({ kind: "schema_violation" })).toBe(false);
  });

  // The second data loss, as a test. The observed failure: 22 steps, ~1.7M
  // tokens of the codebase read into the transcript, an empty final message,
  // and a card offering only Discard. The research is the expensive part and
  // it is right there in the transcript.
  it("offers a resume for an empty answer that came AFTER real work", () => {
    expect(
      canOfferResume({ kind: "empty" }, null, {
        stepsUsed: 22,
        hasTranscript: true,
      }),
    ).toBe(true);
    expect(
      canOfferResume({ kind: "schema_violation" }, null, {
        stepsUsed: 22,
        hasTranscript: true,
      }),
    ).toBe(true);
  });

  it("refuses a genuinely empty run — nothing read, nothing transcribed", () => {
    expect(
      canOfferResume({ kind: "empty" }, null, {
        stepsUsed: 0,
        hasTranscript: false,
      }),
    ).toBe(false);
  });

  // The two halves are separate questions and both are load-bearing.
  // capPayloadSize degrades an oversized payload to `transcript: null`, so a
  // 22-step run can bank nothing — replaying that would send the finish-now
  // nudge to a model that has read nothing at all.
  it("needs BOTH steps and a surviving transcript", () => {
    expect(
      canOfferResume({ kind: "empty" }, null, {
        stepsUsed: 22,
        hasTranscript: false,
      }),
    ).toBe(false);
    expect(
      canOfferResume({ kind: "empty" }, null, {
        stepsUsed: 0,
        hasTranscript: true,
      }),
    ).toBe(false);
  });

  it("leaves the other outcomes untouched by progress", () => {
    const none = { stepsUsed: 0, hasTranscript: false };
    expect(canOfferResume({ kind: "step_cap" }, null, none)).toBe(true);
    expect(canOfferResume({ kind: "cancelled" }, null, none)).toBe(true);
    expect(canOfferResume({ kind: "something-new" }, null, {
      stepsUsed: 22,
      hasTranscript: true,
    })).toBe(false);
  });

  it("for kind 'error', prefers the recorded errorKind over reclassifying", () => {
    expect(canOfferResume({ kind: "error", errorKind: "rate-limit" })).toBe(true);
  });

  // The reported data loss, as a test: 24 steps of paid work, a run that
  // overflowed, and a Resume button that never rendered.
  it("offers a resume after a context overflow — the resumed request is compacted, not replayed verbatim", () => {
    const work = { stepsUsed: 24, hasTranscript: true };
    expect(
      canOfferResume({ kind: "error", errorKind: "context-overflow" }, null, work),
    ).toBe(true);
    expect(
      canOfferResume({ kind: "error" }, "maximum context length exceeded", work),
    ).toBe(true);
  });

  // The other half of the same rule. Compaction is what makes an overflow
  // resume a SUBSET of the request that failed — with nothing banked there is
  // nothing to compact, so Resume rebuilds the identical prompt and 400s again
  // on the spot. Every other error kind stays resumable without progress,
  // because their transcripts were never the problem.
  it("refuses an overflow with nothing banked — that resume is the same request again", () => {
    expect(
      canOfferResume({ kind: "error", errorKind: "context-overflow" }),
    ).toBe(false);
    expect(
      canOfferResume({ kind: "error", errorKind: "context-overflow" }, null, {
        stepsUsed: 0,
        hasTranscript: false,
      }),
    ).toBe(false);
    expect(canOfferResume({ kind: "error", errorKind: "rate-limit" })).toBe(true);
  });

  it("falls back to matchErrorKind(errorMessage) when errorKind wasn't recorded", () => {
    expect(canOfferResume({ kind: "error" }, "429 rate limit")).toBe(true);
    // Still gated on the OUTCOME kind, which the message can't override.
    expect(canOfferResume({ kind: "empty" }, "429 rate limit")).toBe(false);
  });

  it("is false for any other/unrecognised kind", () => {
    expect(canOfferResume({ kind: "something-new" })).toBe(false);
  });
});

// The sentence a failed run leads with. It used to be one sentence for every
// empty result — "turn on JSON mode" — which is true of a connector that can't
// do structured output and false of the failure that prompted this: 22 steps of
// codebase reading, then nothing.
describe("emptyAnswerCause", () => {
  it("names the output ceiling on a length finish, not JSON mode", () => {
    const s = emptyAnswerCause("empty", "length");
    expect(s).toMatch(/output-token ceiling/);
    expect(s).not.toMatch(/JSON mode/);
    // The reasoning-model trap: thinking spends the output budget, so the
    // reply can be empty with nothing wrong at the connector at all.
    expect(s).toMatch(/thinking/);
  });

  it("says the model wrote nothing on a stop finish, not that it can't format", () => {
    const s = emptyAnswerCause("empty", "stop");
    expect(s).toMatch(/without writing an answer/);
    expect(s).not.toMatch(/JSON mode/);
  });

  it("keeps the connector wording where it was earned — no finish reason at all", () => {
    expect(emptyAnswerCause("empty", undefined)).toMatch(/JSON mode/);
    expect(emptyAnswerCause("empty", "tool-calls")).toMatch(/JSON mode/);
  });

  it("distinguishes an unreadable answer from a missing one at the same finish", () => {
    expect(emptyAnswerCause("schema_violation", "length")).toMatch(
      /cut off mid-structure/,
    );
    expect(emptyAnswerCause("empty", "length")).not.toMatch(
      /cut off mid-structure/,
    );
  });
});

// The copy the discard-only card shows. It is only ever reached when
// canOfferResume already said no, so each branch has to be true of the case
// that actually got it there.
describe("resumeUnavailableReason", () => {
  it("blames the model when the model really did return nothing", () => {
    const reason = resumeUnavailableReason({ kind: "empty" }, {
      stepsUsed: 0,
      hasTranscript: false,
    });
    expect(reason).toContain("returned nothing");
  });

  it("blames the transcript, not the model, when work was done but nothing survived", () => {
    const reason = resumeUnavailableReason({ kind: "empty" }, {
      stepsUsed: 22,
      hasTranscript: false,
    });
    expect(reason).toContain("too large to save");
    // The 22-step run DID return plenty; saying otherwise sends the user
    // hunting for a model problem that isn't there.
    expect(reason).not.toContain("returned nothing");
  });

  it("says the same for schema_violation", () => {
    expect(
      resumeUnavailableReason({ kind: "schema_violation" }, {
        stepsUsed: 22,
        hasTranscript: false,
      }),
    ).toContain("too large to save");
  });
});

// `finish: length` is its own resume case: the answer overran the output cap,
// so a replay at the SAME cap deterministically meets the same ceiling — the
// button re-fails and bills the user twice. It is offered only when the retry
// genuinely differs (a known ceiling above the cap the attempt ran at), and
// refused with copy that names the real problem otherwise.
describe("canOfferResume / canRaiseOutputCap — truncated (length) answers", () => {
  const work = { stepsUsed: 22, hasTranscript: true };

  it.each(["empty", "schema_violation"] as const)(
    "refuses a length-cut %s even with banked work when no raise exists",
    (kind) => {
      expect(
        canOfferResume({ kind, finishReason: "length" }, null, {
          ...work,
          outputCapRaisable: false,
        }),
      ).toBe(false);
      // Absent flag fails closed, like the other progress fields.
      expect(canOfferResume({ kind, finishReason: "length" }, null, work)).toBe(
        false,
      );
    },
  );

  it("offers a length-cut answer when the output cap can be raised", () => {
    expect(
      canOfferResume({ kind: "empty", finishReason: "length" }, null, {
        ...work,
        outputCapRaisable: true,
      }),
    ).toBe(true);
  });

  it("a raisable cap does not rescue a run with nothing banked", () => {
    expect(
      canOfferResume({ kind: "empty", finishReason: "length" }, null, {
        stepsUsed: 0,
        hasTranscript: false,
        outputCapRaisable: true,
      }),
    ).toBe(false);
  });

  it("non-length answered-badly outcomes keep the plain banked-work gate", () => {
    expect(canOfferResume({ kind: "empty", finishReason: "stop" }, null, work)).toBe(
      true,
    );
    expect(canOfferResume({ kind: "schema_violation" }, null, work)).toBe(true);
  });

  it("canRaiseOutputCap: known ceiling above the recorded cap, and only that", () => {
    // Catalogued model, ran at the standing cap → the ceiling is headroom.
    expect(canRaiseOutputCap("claude-sonnet-5", { outputCap: 64_000 })).toBe(true);
    // Already ran at the ceiling (a resumed attempt) → nothing left to offer.
    expect(canRaiseOutputCap("claude-sonnet-5", { outputCap: 128_000 })).toBe(
      false,
    );
    // No recorded cap: the attempt ran at the provider/SDK default, which for
    // catalogued models WAS the ceiling (the pre-cap bug) — fail closed.
    expect(canRaiseOutputCap("claude-sonnet-5", {})).toBe(false);
    expect(canRaiseOutputCap("claude-sonnet-5", null)).toBe(false);
    // Uncatalogued model: no known ceiling to raise to.
    expect(canRaiseOutputCap("some-local-model", { outputCap: 4_096 })).toBe(
      false,
    );
  });

  it("resumeUnavailableReason names the ceiling for a refused length outcome", () => {
    const reason = resumeUnavailableReason(
      { kind: "schema_violation", finishReason: "length" },
      { stepsUsed: 22, hasTranscript: true },
    );
    expect(reason).toMatch(/output-token limit/);
    expect(reason).not.toMatch(/returned nothing/);
    // Without banked work the transcript-loss / generic copy still wins.
    expect(
      resumeUnavailableReason(
        { kind: "empty", finishReason: "length" },
        { stepsUsed: 0, hasTranscript: false },
      ),
    ).toMatch(/returned nothing/);
  });
});

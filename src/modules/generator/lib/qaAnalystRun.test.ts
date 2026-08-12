import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the shared runner so we assert how the analyst engine drives it,
// without any model call.
const runTask = vi.fn();
const streamTask = vi.fn();
vi.mock("@/modules/ai/lib/taskRunner", () => ({
  runTask: (...a: unknown[]) => runTask(...a),
  streamTask: (...a: unknown[]) => streamTask(...a),
}));

// buildSuiteChatTools returns a sentinel tool set when (and only when) it is
// given at least one repo.
const TOOLS = { read_file: {}, list_files: {}, grep: {} };
vi.mock("@/modules/test-plans/lib/suiteChatTools", () => ({
  buildSuiteChatTools: (repos: unknown[]) => (repos.length > 0 ? TOOLS : undefined),
}));
const REPOS = [{ id: "r1", name: "repo-one", root: "C:/repo", ado: null }];

import {
  RESUME_TOPUP_TOKENS,
  SURFACE_STEP_CAPS,
  SURFACE_TOKEN_BUDGETS,
} from "@/modules/ai/config";
import { FINISH_NOW_NUDGE } from "@/modules/ai/lib/checkpointApi";
import {
  executeQaAnalystRun,
  prepareQaAnalystRun,
  renderTargetContext,
  runQaAnalyst,
  type RunInput,
  type TargetContext,
} from "./qaAnalystRun";

const base: RunInput = {
  requirements: "Feature spec",
  attachments: [],
  existingCaseTitles: [],
  coverage: "full",
  suggestBugs: false,
  keys: {} as never,
  modelId: "gpt-5.4-mini" as never,
};

/** Exercises every prompt-assembly branch at once — target context, existing
 *  cases with steps, related cases, changesets, attachments, context blocks
 *  (text + image) — so the byte pin below catches any drift in assembly. */
const rich: RunInput = {
  ...base,
  requirements: "  Users can reset a forgotten password.  ",
  changesets: "abc1234 — add reset token expiry",
  attachments: [
    { path: "src/auth/reset.ts", content: "export const ttl = 900;", kind: "text" },
    {
      path: "flow.png",
      content: "data:image/png;base64,AAAA",
      kind: "image",
      mime: "image/png",
      sizeBytes: 4,
    },
  ],
  existingCaseTitles: [{ id: 7, title: "Login with valid credentials" }],
  existingCases: [
    {
      id: 7,
      title: "Login with valid credentials",
      steps: [{ action: "Open /login", expected: "Form renders" }],
    },
  ],
  relatedCases: [
    { id: 12, title: "Sign out clears session", suiteName: "Auth", suiteId: 3 },
  ],
  targetContext: {
    planId: 1,
    planName: "Web",
    suiteId: 2,
    suiteName: "Password reset",
    suitePath: ["Auth"],
    areaPath: "Web\\Auth",
    iterationPath: "Web\\Sprint 4",
  },
  suggestBugs: true,
  customInstructions: "Prefer short titles.",
  contextBlocks: [
    {
      heading: "TEAM STANDARDS",
      body: "Titles start with the feature in brackets.",
      images: [
        {
          id: "bp-1",
          path: "standards.png",
          content: "data:image/png;base64,BBBB",
          kind: "image",
          mime: "image/png",
        },
      ],
    },
  ],
};

const OK_RESULT = {
  ok: true,
  object: { cases: [], bugs: [] },
  text: "{}",
  durationMs: 1,
};

beforeEach(() => {
  runTask.mockReset();
  streamTask.mockReset();
  runTask.mockResolvedValue(OK_RESULT);
  streamTask.mockResolvedValue(OK_RESULT);
});

/** The single runner call this test made, whichever entry point took it. */
function runnerArg(): Record<string, unknown> {
  const calls = [...runTask.mock.calls, ...streamTask.mock.calls];
  expect(calls).toHaveLength(1);
  return calls[0][0] as Record<string, unknown>;
}

describe("runQaAnalyst tool wiring", () => {
  it("passes read-only tools to the runner when a source root is set", async () => {
    await runQaAnalyst({ ...base, repos: REPOS });
    const arg = runnerArg();
    expect(arg.tools).toBe(TOOLS);
    expect(arg.schema).toBeDefined();
    expect(arg.temperature).toBe(0);
  });

  it("runs tool-less (tools: null) when no source root", async () => {
    await runQaAnalyst({ ...base, repos: [] });
    expect(runnerArg().tools).toBeNull();
  });

  it("returns the validated batch from the runner", async () => {
    streamTask.mockResolvedValue({
      ok: true,
      object: {
        cases: [
          {
            title: "A valid generated case title",
            description: "",
            steps: [{ action: "a", expected: "b" }],
            tags: [],
            rationale: "",
            sourceLinks: [],
          },
        ],
        bugs: [],
      },
      text: "{}",
      durationMs: 1,
    });
    const out = await runQaAnalyst({ ...base, repos: REPOS });
    expect(out.batch.cases).toHaveLength(1);
  });

  // The runner knows why the provider ended the last step; every layer above
  // it used to drop that on the floor, which is what made "22 steps in and
  // nothing came back" a guess instead of a readout. `length` (output ceiling)
  // and `stop` (the model wrote nothing) want different sentences.
  it("carries the runner's finish reason out with a failed run", async () => {
    streamTask.mockResolvedValue({
      ok: false,
      reason: "empty",
      text: "",
      durationMs: 1,
      finishReason: "length",
    });
    const out = await runQaAnalyst({ ...base, repos: REPOS });
    expect(out.finishReason).toBe("length");
  });

  it("salvages a partial batch when the runner reports schema_violation", async () => {
    runTask.mockResolvedValue({
      ok: false,
      reason: "schema_violation",
      text: JSON.stringify({
        cases: [
          {
            title: "A salvageable valid title",
            steps: [{ action: "a", expected: "b" }],
          },
          { title: "x", steps: [] }, // invalid → dropped
        ],
        bugs: [],
      }),
      durationMs: 1,
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const out = await runQaAnalyst({ ...base, repos: [] });
    expect(out.batch.cases).toHaveLength(1);
    err.mockRestore();
  });

  // Salvage reads the FINAL step's text, never `text` — on the runner's `empty`
  // arm that is every step's narration concatenated. An analyst that sketches a
  // provisional batch at step 6, keeps reading, and then writes nothing would
  // otherwise have the sketch salvaged and presented in the review pane as the
  // run's output, ready to publish to ADO.
  it("does not salvage a batch out of mid-run narration", async () => {
    streamTask.mockResolvedValue({
      ok: false,
      reason: "empty",
      text:
        'Here is what I have so far: {"cases":[{"title":"A provisional case I abandoned","steps":[{"action":"a","expected":"b"}]}],"bugs":[]}\nStill reading…',
      finalText: "",
      durationMs: 1,
    });
    const out = await runQaAnalyst({ ...base, repos: REPOS });
    expect(out.batch.cases).toEqual([]);
  });

  // The reported failure: a run reads the codebase for twenty-odd steps, its
  // last step writes nothing (on a reasoning model the thinking itself spends
  // the output cap), and the whole spend lands as an error. Everything needed
  // to write the batch is already in the transcript, so it is replayed with
  // "stop reading, answer now" automatically — the user gets cases instead of
  // paying for the reading and then being asked to pay a little more for the
  // answer.
  it("finishes an empty run from what it read instead of failing", async () => {
    const banked = [
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "t1", toolName: "read_file", input: {} },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "t1",
            toolName: "read_file",
            output: { type: "text", value: "source" },
          },
        ],
      },
    ];
    let call = 0;
    streamTask.mockImplementation(
      async (args: { onCheckpoint?: (c: unknown) => void }) => {
        call += 1;
        if (call === 1) {
          args.onCheckpoint?.({ messages: banked, stepsUsed: 22, usage: {} });
          return { ok: false, reason: "empty", text: "narration", finalText: "", durationMs: 1 };
        }
        return {
          ok: true,
          object: {
            cases: [
              {
                title: "The case it could write all along",
                description: "",
                steps: [{ action: "a", expected: "b" }],
                tags: [],
                rationale: "",
                sourceLinks: [],
              },
            ],
            bugs: [],
          },
          text: "{}",
          durationMs: 1,
        };
      },
    );

    const out = await runQaAnalyst({ ...base, repos: REPOS });

    expect(streamTask).toHaveBeenCalledTimes(2);
    const finish = streamTask.mock.calls[1][0];
    expect(finish.tokenBudget).toBe(RESUME_TOPUP_TOKENS);
    expect(finish.resumeMessages).toEqual([
      ...banked,
      { role: "user", content: FINISH_NOW_NUDGE },
    ]);
    expect(out.ok).toBe(true);
    expect(out.batch.cases.map((c) => c.title)).toEqual([
      "The case it could write all along",
    ]);
  });

  // A budget stop is not a fumbled ending — that run wanted MORE reading, and
  // topping it up unasked is the "it burned through the credits" complaint in a
  // new costume. It keeps its Resume card.
  it("does not auto-finish a run that hit its budget", async () => {
    streamTask.mockResolvedValue({
      ok: false,
      reason: "step_cap",
      text: "narration",
      finalText: "",
      durationMs: 1,
      stepsUsed: 40,
    });
    const out = await runQaAnalyst({ ...base, repos: REPOS });
    expect(streamTask).toHaveBeenCalledTimes(1);
    expect(out.reason).toBe("step_cap");
  });

  it("does not auto-finish a run that read nothing", async () => {
    streamTask.mockResolvedValue({
      ok: false,
      reason: "empty",
      text: "",
      finalText: "",
      durationMs: 1,
    });
    const out = await runQaAnalyst({ ...base, repos: REPOS });
    expect(streamTask).toHaveBeenCalledTimes(1);
    expect(out.ok).toBe(false);
  });

  // …while the truncation case still salvages, because a cut answer leaves its
  // partial JSON on the LAST step.
  it("still salvages a final answer the output cap cut in half", async () => {
    streamTask.mockResolvedValue({
      ok: false,
      reason: "schema_violation",
      text: "ignored narration",
      finalText:
        '{"cases":[{"title":"The case that landed before the cut","steps":[{"action":"a","expected":"b"}]},{"title":"cut he',
      finishReason: "length",
      durationMs: 1,
    });
    const out = await runQaAnalyst({ ...base, repos: REPOS });
    expect(out.batch.cases.map((c) => c.title)).toEqual([
      "The case that landed before the cut",
    ]);
  });
});

describe("engine dispatch", () => {
  it("streams the tool-bearing path (never runTask)", async () => {
    await runQaAnalyst({ ...base, repos: REPOS });
    expect(streamTask).toHaveBeenCalledTimes(1);
    expect(runTask).not.toHaveBeenCalled();
    // streamTask requires an onText sink even when the caller doesn't want one.
    expect(typeof streamTask.mock.calls[0][0].onText).toBe("function");
  });

  it("keeps the tool-less path on runTask so generateObject still applies", async () => {
    await runQaAnalyst({ ...base, repos: [] });
    expect(runTask).toHaveBeenCalledTimes(1);
    expect(streamTask).not.toHaveBeenCalled();
  });

  it("forwards onText deltas from the streaming path", async () => {
    streamTask.mockImplementation(async (input: { onText: (d: string) => void }) => {
      input.onText("par");
      input.onText("tial");
      return OK_RESULT;
    });
    const seen: string[] = [];
    await executeQaAnalystRun(prepareQaAnalystRun({ ...base, repos: REPOS }), {
      keys: {} as never,
      onText: (d) => seen.push(d),
    });
    expect(seen.join("")).toBe("partial");
  });
});

describe("prepareQaAnalystRun / runQaAnalyst prompt assembly", () => {
  it("hands the runner exactly what prepare assembled", async () => {
    const prepared = prepareQaAnalystRun(rich);
    await runQaAnalyst(rich);
    const arg = runnerArg();
    expect(arg.prompt).toBe(prepared.userPrompt);
    expect(arg.attachments).toEqual(prepared.attachments);
    expect(arg.customInstructions).toBe("Prefer short titles.");
    expect(arg.temperature).toBe(0);
    expect(arg.maxSteps).toBe(SURFACE_STEP_CAPS.generator);
    expect(arg.tokenBudget).toBe(SURFACE_TOKEN_BUDGETS.generator);
    expect(arg.schema).toBeDefined();
    expect(arg.systemPrompt).toEqual(expect.stringContaining("QA"));
  });

  it("merges context-block images into the vision attachments", () => {
    const prepared = prepareQaAnalystRun(rich);
    expect(prepared.attachments.map((a) => a.path)).toEqual([
      "src/auth/reset.ts",
      "flow.png",
      "standards.png",
    ]);
  });

  it("pins the assembled prompt bytes", () => {
    expect(prepareQaAnalystRun(rich).userPrompt).toMatchInlineSnapshot(`
      "Coverage: full — happy paths, edge cases, and negative / error paths.
      Bug suggestions: ON — also flag concrete defect risks where the spec or readable code reveals a real bug (with codeRefs).

      TARGET CONTEXT — these are the test plan and suite the cases will be
      published into. Cases inherit the default area / iteration unless your
      draft overrides them explicitly.
      - Plan: Web (#1)
      - Suite: Auth › Password reset (#2)
      - Default area path: Web\\Auth
      - Default iteration path: Web\\Sprint 4

      Feature requirements:
      Users can reset a forgotten password.

      EXISTING CASES already in this suite — do NOT duplicate these. Read their
      steps to see what's covered, match their style and granularity, and
      generate cases that COMPLEMENT (not repeat) this coverage:

      #7: Login with valid credentials
        1. Open /login → Form renders

      RELATED TEST CASES — read for pattern awareness only.
      These come from neighboring suites in the same plan. They may be
      outdated or wrong, and they do NOT override the feature spec below.
      Use them to: stay consistent with existing naming, avoid silent
      coverage gaps, and notice when the spec extends an existing surface.
      If the spec contradicts a related case, follow the spec.

        [Auth]
          #12: Sign out clears session

      CHANGESETS / SCOPE NOTES — the developer pasted these as a hint about
      what actually changed. Use them to scope coverage per the SCOPING rule.
      Treat them as POSSIBLY INCOMPLETE.

      abc1234 — add reset token expiry


      Source code attached for grounding:

      --- src/auth/reset.ts ---
      export const ttl = 900;

      --- flow.png ---
      [user-attached image: image/png, 4 bytes]

      Return ONLY the DraftBatch JSON. Schema:
      {
        "cases": [
          {
            "title": "[Sign in] When the user enters a correct email and password then the Dashboard opens",
            "description": "Checks a normal sign-in. Needs the test account qa.tester@example.com (step 1 signs in with it).",
            "steps": [
              {
                "action": "Open /login, type 'qa.tester@example.com' in the 'Email' field and 'Test@123' in 'Password', then click 'Sign in'",
                "expected": "The Dashboard page loads and shows 'Welcome back'"
              }
            ],
            "tags": [
              "sign-in",
              "happy-path"
            ],
            "rationale": "Why this case exists in one sentence — shown to reviewers."
          }
        ],
        "bugs": [
          {
            "title": "[Sign in] More than three code text messages can be requested in one minute",
            "reproSteps": "SUMMARY:\\nSix sign-in codes can be requested in one minute; the limit should be three.\\n\\nPRECONDITIONS:\\n1. Sign in as qa.tester@example.com / Test@123 until the 'Verify it's you' screen appears.\\n\\nSTEPS TO REPRODUCE:\\n1. Click 'Send code again' six times within one minute.\\n\\nEXPECTED RESULT:\\nAfter the third request, a message states that no more codes can be sent for a short period.\\n\\nACTUAL RESULT:\\nAll six codes arrive.\\n\\nTECHNICAL NOTES:\\nsendCode never checks the rate-limit counter (src/auth/sms.ts:42-58).\\n\\nENVIRONMENT:\\nn/a",
            "severity": "2 - High",
            "linkedDraftCaseIndex": 0,
            "codeRefs": [
              {
                "file": "src/auth/sms.ts",
                "startLine": 42,
                "endLine": 58,
                "symbol": "sendCode"
              }
            ]
          }
        ]
      }

      --- TEAM STANDARDS ---
      Titles start with the feature in brackets."
    `);
  });

  it("passes userPromptOverride (the refine path) through byte-for-byte", () => {
    const override = "Follow-up against the current draft.";
    const prepared = prepareQaAnalystRun({ ...rich, userPromptOverride: override });
    expect(prepared.userPrompt).toBe(
      `${override}\n\n--- TEAM STANDARDS ---\nTitles start with the feature in brackets.`,
    );
  });

  it("leaves the prompt untouched when there are no context blocks", () => {
    const prepared = prepareQaAnalystRun({
      ...rich,
      contextBlocks: [],
      userPromptOverride: "Just this.",
    });
    expect(prepared.userPrompt).toBe("Just this.");
  });
});

describe("executeQaAnalystRun passthroughs", () => {
  it("surfaces reason / stepsUsed / usage from a step-capped run", async () => {
    streamTask.mockResolvedValue({
      ok: false,
      reason: "step_cap",
      text: "",
      durationMs: 5,
      stepsUsed: 24,
      usage: { inputTokens: 100, totalTokens: 140 },
    });
    const out = await runQaAnalyst({ ...base, repos: REPOS });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("step_cap");
    expect(out.stepsUsed).toBe(24);
    expect(out.usage).toEqual({ inputTokens: 100, totalTokens: 140 });
    expect(out.batch).toEqual({ cases: [], bugs: [] });
  });

  it("forwards maxSteps, resumeMessages and onCheckpoint to the runner", async () => {
    const onCheckpoint = vi.fn();
    const resumeMessages = [{ role: "user" as const, content: "keep going" }];
    await executeQaAnalystRun(prepareQaAnalystRun({ ...base, repos: REPOS }), {
      keys: {} as never,
      maxSteps: 8,
      resumeMessages,
      onCheckpoint,
    });
    const arg = runnerArg();
    expect(arg.maxSteps).toBe(8);
    expect(arg.resumeMessages).toBe(resumeMessages);
    // Reaches the caller, rather than IS the caller's function: the run wraps
    // this sink to keep its own copy of the transcript (what the auto-finish
    // pass replays). Asserting identity would pin the wrapper's absence, not
    // the forwarding this test is named for.
    const cp = { messages: [], stepsUsed: 1, usage: {} };
    (arg.onCheckpoint as (c: unknown) => void)(cp);
    expect(onCheckpoint).toHaveBeenCalledWith(cp);
  });

  it("defaults both budgets to the generator surface entries", async () => {
    await executeQaAnalystRun(prepareQaAnalystRun({ ...base, repos: [] }), {
      keys: {} as never,
    });
    expect(runnerArg().maxSteps).toBe(SURFACE_STEP_CAPS.generator);
    expect(runnerArg().tokenBudget).toBe(SURFACE_TOKEN_BUDGETS.generator);
  });

  it("forwards a resume's token top-up as the call's budget", async () => {
    await executeQaAnalystRun(prepareQaAnalystRun({ ...base, repos: [] }), {
      keys: {} as never,
      tokenBudget: 500_000,
    });
    expect(runnerArg().tokenBudget).toBe(500_000);
  });
});

describe("renderTargetContext — suite type awareness", () => {
  const ctx: TargetContext = {
    planId: 1,
    planName: "Web",
    suiteId: 2,
    suiteName: "4821 : Bulk archive",
    suitePath: ["Sprint 12"],
    areaPath: null,
    iterationPath: null,
  };

  it("stays byte-identical for a static suite", () => {
    // The whole feature must be inert for the suites this app already handled.
    const before = renderTargetContext(ctx);
    const after = renderTargetContext({ ...ctx, suiteType: "staticTestSuite" });
    expect(after).toBe(before);
    expect(after).not.toContain("REQUIREMENT");
    // Asserted against `after` directly, not via the equality above: `ctx` has
    // no suiteType, so both operands take the same branch and an inverted
    // `isQuerySuite` would leak this note onto EVERY static suite while
    // keeping the two strings equal.
    expect(after).not.toContain("query-based");
  });

  it("embeds the requirement block for a requirement-based suite", () => {
    const out = renderTargetContext({
      ...ctx,
      suiteType: "requirementTestSuite",
      requirement: {
        id: 4821,
        workItemType: "User Story",
        title: "Bulk-archive contacts",
        state: "Active",
        description: "Users need to archive many contacts at once.",
        acceptanceCriteria: "- Select all works",
      },
    });
    expect(out).toContain("REQUIREMENT");
    expect(out).toContain('User Story #4821 — "Bulk-archive contacts"');
    expect(out).toContain("Acceptance criteria:");
    expect(out).toContain("- Select all works");
    // The TARGET CONTEXT header must survive alongside it.
    expect(out).toContain("- Suite: Sprint 12 › 4821 : Bulk archive (#2)");
  });

  it("warns the model that a query-based suite won't take cases", () => {
    const out = renderTargetContext({ ...ctx, suiteType: "dynamicTestSuite" });
    expect(out).toContain("query-based suite");
    expect(out).toContain("will not accept new cases");
    expect(out).not.toContain("REQUIREMENT");
  });

  it("omits the requirement block when the work item couldn't be fetched", () => {
    // buildTargetContext swallows a failed requirement fetch, so suiteType can
    // be requirement-based with a null requirement. That must not render a
    // half-empty block.
    const out = renderTargetContext({
      ...ctx,
      suiteType: "requirementTestSuite",
      requirement: null,
    });
    expect(out).not.toContain("REQUIREMENT");
  });
});

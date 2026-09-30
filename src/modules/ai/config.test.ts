// Invariants on the model catalogue — the release guard for "a new model
// shipped and every AI surface started 400ing".
//
// Every failure this file pins has actually happened, and each one arrived the
// same way: a model was added to MODELS, the request-shaping decision beside it
// was left to a provider SDK, and that SDK's capability table was a release
// behind the model launch. `temperature` on Claude Sonnet 5 (a 400 on the
// DEFAULT model, every surface, first run) is the canonical one; the OpenRouter
// twin of an OpenAI model disagreeing with its native entry is the same bug
// caught before it shipped.
//
// So these are asserted about the CATALOGUE, not about a run: they fail in CI
// the moment an entry is added without its decisions, which is months before a
// tester finds out by being unable to generate a test case.

import { describe, it, expect } from "vitest";
import {
  MODELS,
  MODEL_CONTEXT_LIMITS,
  MODEL_OUTPUT_LIMITS,
  MODEL_PRICING,
  PROVIDERS,
  RETIRED_MODEL_REPLACEMENTS,
  getModelOutputCap,
  getModelOutputCeiling,
  isKnownModelId,
  preservesThinking,
  supportsTemperature,
  DEFAULT_MODEL_ID,
  type ModelId,
} from "./config";

const ids = new Set<string>(MODELS.map((m) => m.id));

/** The upstream model a route points at. `anthropic/claude-opus-5` on
 *  OpenRouter and `claude-opus-5` on the native provider are one model reached
 *  two ways, and the request we build for them must not differ. Versions are
 *  compared with dots folded to hyphens, because OpenRouter spells
 *  `claude-opus-5.5` what Anthropic calls `claude-opus-5-5` — without the fold
 *  every new route would silently opt out of this check. */
function upstream(id: string): string {
  const bare = id.includes("/") ? id.split("/").slice(1).join("/") : id;
  return bare.replace(/\./g, "-");
}

describe("model catalogue: structure", () => {
  it("every model id is unique", () => {
    expect(ids.size).toBe(MODELS.length);
  });

  it("every model belongs to a registered provider", () => {
    const providers = new Set(PROVIDERS.map((p) => p.id));
    for (const m of MODELS) expect(providers.has(m.provider)).toBe(true);
  });

  it("the default model is one of them", () => {
    expect(isKnownModelId(DEFAULT_MODEL_ID)).toBe(true);
  });

  // A missing entry isn't an error, it's a silent 128k assumption — which on a
  // 1M-context model makes the context meter read "full" a fifth of the way in,
  // and on a 32k local model hides the overflow until the provider 400s.
  it("every model has a context limit (no silent 128k fallback)", () => {
    const missing = MODELS.filter((m) => !(m.id in MODEL_CONTEXT_LIMITS));
    expect(missing.map((m) => m.id)).toEqual([]);
  });

  // A retired id that is still catalogued would never be migrated, and a
  // successor that isn't catalogued would migrate a saved default into an id
  // the next check throws away.
  it("every retired id is gone, and its successor is live", () => {
    const broken: string[] = [];
    for (const [retired, successor] of Object.entries(
      RETIRED_MODEL_REPLACEMENTS,
    )) {
      if (ids.has(retired)) broken.push(`${retired} is still catalogued`);
      if (!ids.has(successor)) broken.push(`${retired} → ${successor} (unknown)`);
    }
    expect(broken).toEqual([]);
  });

  // The map exists so a Groq-only user whose model was retired lands on a Groq
  // model they have a key for. A successor on another provider defeats that
  // silently. Retired ids are gone from MODELS, so their providers are
  // recorded here — add one when you retire a model.
  it("every retired id's successor is on the same provider", () => {
    const retiredProvider: Record<string, string> = {
      "grok-4-fast-reasoning": "xai",
      "deepseek-v4-flash": "deepseek",
      "deepseek-reasoner": "deepseek",
      "llama3.3-70b": "cerebras",
      "qwen-3-32b": "cerebras",
      "llama-3.3-70b-versatile": "groq",
      "deepseek-r1-distill-llama-70b": "groq",
      "x-ai/grok-4.20-reasoning": "openrouter",
      "deepseek/deepseek-reasoner": "openrouter",
      "meta-llama/llama-4-scout-17b-16e-instruct": "openrouter",
      "qwen/qwen3-max": "openrouter",
      "mistralai/mistral-large-latest": "openrouter",
    };
    expect(Object.keys(retiredProvider).sort()).toEqual(
      Object.keys(RETIRED_MODEL_REPLACEMENTS).sort(),
    );
    const crossed = Object.entries(RETIRED_MODEL_REPLACEMENTS).filter(
      ([retired, successor]) =>
        MODELS.find((m) => m.id === successor)?.provider !== retiredProvider[retired],
    );
    expect(crossed).toEqual([]);
  });

  // A stale key is a decision that stopped applying to anything: the model was
  // renamed or retired and its cap/price/limit silently stopped being used.
  it("no side table names a model that doesn't exist", () => {
    const orphans: string[] = [];
    for (const [table, map] of [
      ["MODEL_CONTEXT_LIMITS", MODEL_CONTEXT_LIMITS],
      ["MODEL_OUTPUT_LIMITS", MODEL_OUTPUT_LIMITS],
      ["MODEL_PRICING", MODEL_PRICING],
    ] as const) {
      for (const k of Object.keys(map)) {
        if (!ids.has(k)) orphans.push(`${table}.${k}`);
      }
    }
    expect(orphans).toEqual([]);
  });
});

describe("model catalogue: request-shaping decisions", () => {
  // The rule the whole file exists for. A frontier tier is exactly where the
  // provider drops sampling params, and exactly where the SDK's table is
  // stalest — so the catalogue has to hold an explicit answer rather than
  // inheriting one.
  const FRONTIER =
    /^(anthropic\/)?claude-(opus|sonnet|fable)-[5-9]|^(openai\/)?gpt-[5-9]/;

  it("every frontier-tier model states whether it takes sampling params", () => {
    const undecided = MODELS.filter(
      (m) =>
        FRONTIER.test(m.id) &&
        !(m as { rejectsSamplingParams?: boolean }).rejectsSamplingParams,
    );
    expect(undecided.map((m) => m.id)).toEqual([]);
  });

  // The one that would have caught gpt-5.4-mini: flagged on its OpenRouter
  // route, unflagged on its native one. Native SDKs strip what gateways forward
  // verbatim, so a disagreement means one of the two routes is sending a
  // parameter the model refuses — and only the gateway route finds out.
  it("native and gateway routes to one model agree on every decision", () => {
    const byUpstream = new Map<string, ModelId[]>();
    for (const m of MODELS) {
      const key = upstream(m.id);
      byUpstream.set(key, [...(byUpstream.get(key) ?? []), m.id as ModelId]);
    }
    const disagreements: string[] = [];
    for (const [key, group] of byUpstream) {
      if (group.length < 2) continue;
      const decisions = group.map((id) =>
        JSON.stringify({
          temperature: supportsTemperature(id),
          outputCap: getModelOutputCap(id) ?? null,
          outputCeiling: getModelOutputCeiling(id) ?? null,
          context: MODEL_CONTEXT_LIMITS[id] ?? null,
          preservesThinking: preservesThinking(id),
        }),
      );
      if (new Set(decisions).size > 1) {
        disagreements.push(
          `${key}: ${group.map((id, i) => `${id}=${decisions[i]}`).join(" vs ")}`,
        );
      }
    }
    expect(disagreements).toEqual([]);
  });

  // `cap` is what every request asks for; `ceiling` is the headroom the
  // truncation-resume retries into. Equal values mean Resume deterministically
  // re-runs into the same wall, which `canOfferResume` reads as "raisable" from
  // the ceiling alone.
  it("every output cap leaves resume headroom below the ceiling", () => {
    for (const [id, { cap, ceiling }] of Object.entries(MODEL_OUTPUT_LIMITS)) {
      expect(cap, `${id} cap`).toBeGreaterThan(0);
      expect(cap, `${id} cap must sit below its ceiling`).toBeLessThan(ceiling);
    }
  });

  // Anthropic is the one provider whose SDK fills in an output cap of its own
  // when we send none (3.0.104: the full 128k ceiling for Claude 5, 4096 for
  // ids it doesn't recognise). Either number is chosen by the SDK's release
  // date rather than by us, and 4096 truncates a DraftBatch mid-answer.
  it("every Anthropic-family route carries an explicit output cap", () => {
    const uncapped = MODELS.filter(
      (m) => /claude/.test(m.id) && getModelOutputCap(m.id) === undefined,
    );
    expect(uncapped.map((m) => m.id)).toEqual([]);
  });

  // Google: leave Gemini 3's temperature at its 1.0 default — "setting it below
  // 1.0 may lead to … looping or degraded performance". We were sending 0 to 3
  // Flash for as long as it wasn't tagged as the thinking model it is.
  it("no Gemini 3.x route is sent a temperature", () => {
    const sent = MODELS.filter(
      (m) => /gemini-[3-9]/.test(m.id) && supportsTemperature(m.id),
    );
    expect(sent.map((m) => m.id)).toEqual([]);
  });

  // Claude after 5.0 checks every replayed thinking block against the
  // conversation it was produced in, and this app edits that conversation
  // mid-run on purpose (eviction, summary install, resume). The runner's
  // `drop_block` is all that stands between a NEW Anthropic account — the ones
  // enforced by default — and a run that dies on its first step after an
  // eviction. So a Claude entry past 5.0 that doesn't say so fails here, the
  // same way an undecided frontier temperature does above.
  it("every Claude route past 5.0 states preserved thinking", () => {
    const PAST_5_0 = /claude-(opus|sonnet|haiku|fable|mythos)-(5[.-][1-9]|[6-9])/;
    const undecided = MODELS.filter(
      (m) => PAST_5_0.test(m.id) && !preservesThinking(m.id),
    );
    expect(undecided.map((m) => m.id)).toEqual([]);
  });

  it("only Anthropic-family models claim preserved thinking", () => {
    const wrong = MODELS.filter(
      (m) => preservesThinking(m.id) && !/claude/.test(m.id),
    );
    expect(wrong.map((m) => m.id)).toEqual([]);
  });

  // Unknown ids are the custom-endpoint and local-server case: overwhelmingly
  // plain chat models that want a temperature, with the runner's one-shot
  // retry as the net for the rare one that doesn't.
  it("an uncatalogued model id still gets a usable default", () => {
    expect(supportsTemperature("some-model-we-have-never-heard-of")).toBe(true);
    expect(getModelOutputCap("some-model-we-have-never-heard-of")).toBeUndefined();
  });
});

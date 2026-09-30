// One-shot "does this key actually work?" probe for the Settings key cards.
// A format check can't catch the real failures — a revoked key, a wrong-
// provider key that shares a prefix (OpenAI vs DeepSeek both `sk-`), an admin
// key that can't call models, or a no-credits key. This fires one minimal
// generation through the SAME buildConfiguredLanguageModel + Rust-proxy fetch
// as a real run (so there's no CORS issue) and maps the outcome to a verdict.

import { generateText } from "ai";
import {
  isReasoningModel,
  MODEL_PRICING,
  MODELS,
  type ModelId,
  type ProviderId,
} from "../config";
import { EMPTY_PROVIDER_KEYS } from "./keyring";
import { buildConfiguredLanguageModel, type LocalProviderConfig } from "./agent";

export type KeyTestResult = {
  /** True when the key is confirmed usable (incl. valid-but-rate-limited). */
  ok: boolean;
  kind: "valid" | "rejected" | "no-credits" | "rate-limited" | "inconclusive";
  message: string;
};

/** Pick the cheapest non-reasoning model for this provider, so a tiny token
 *  cap doesn't starve a reasoning budget — or the cheapest model outright when
 *  every one reasons (Google, DeepSeek). Cheapest rather than first-listed: the
 *  catalogue leads with each provider's newest flagship, and a key test
 *  shouldn't depend on a model that shipped yesterday. */
export function probeModelId(provider: ProviderId): ModelId | null {
  const forProvider = MODELS.filter((m) => m.provider === provider);
  const plain = forProvider.filter((m) => !isReasoningModel(m.id));
  const pool = plain.length > 0 ? plain : forProvider;
  // By published input price where there is one — the 1–5 cost score ties
  // too often to break toward the cheaper model — else by that score.
  const price = (id: string) => MODEL_PRICING[id]?.input ?? Infinity;
  // Previews last: they're the first a provider shuts down, and a probe model
  // that 404s makes every key test for that provider "inconclusive".
  const preview = (id: string) => (/preview/.test(id) ? 1 : 0);
  const pick = [...pool].sort(
    (a, b) =>
      preview(a.id) - preview(b.id) ||
      price(a.id) - price(b.id) ||
      b.capabilities.cost - a.capabilities.cost,
  )[0];
  return (pick?.id as ModelId) ?? null;
}

export async function testProviderKey(
  provider: ProviderId,
  key: string,
  local: LocalProviderConfig = {},
): Promise<KeyTestResult> {
  const modelId = probeModelId(provider);
  if (!modelId) {
    return {
      ok: false,
      kind: "inconclusive",
      message: "No model is configured for this provider to test against.",
    };
  }
  try {
    const built = await buildConfiguredLanguageModel(
      modelId,
      { ...EMPTY_PROVIDER_KEYS, [provider]: key },
      local,
    );
    // A tiny cap: auth is validated before any generation, so this confirms
    // the key without paying for one. 16, not 1 — OpenAI's Responses API
    // rejects anything below 16 ("Expected a value >= 16"), which made every
    // OpenAI key test "inconclusive".
    await generateText({ model: built, prompt: "ping", maxOutputTokens: 16 });
    return { ok: true, kind: "valid", message: "Key works." };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const lower = msg.toLowerCase();
    if (
      /401|unauthorized|invalid.*api.?key|invalid x-api-key|forbidden|permission|authentication/.test(
        lower,
      )
    ) {
      return {
        ok: false,
        kind: "rejected",
        message: "Rejected — the key is wrong, revoked, or for another provider.",
      };
    }
    if (/402|insufficient.*(credit|quota)|payment required|out of credit/.test(lower)) {
      return {
        ok: false,
        kind: "no-credits",
        message: "The key is valid, but the account is out of credits / quota.",
      };
    }
    if (/429|rate.?limit|too many requests/.test(lower)) {
      return {
        ok: true,
        kind: "rate-limited",
        message: "Rate-limited right now — but the key itself is valid.",
      };
    }
    // The request reached the provider but failed for a non-auth reason (e.g. a
    // reasoning model rejecting the tiny token cap). Don't call the key bad.
    return {
      ok: false,
      kind: "inconclusive",
      message: `Couldn't fully verify — the request errored: ${msg}`,
    };
  }
}

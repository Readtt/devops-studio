// One-shot "does this key actually work?" probe for the Settings key cards.
// A format check can't catch the real failures — a revoked key, a wrong-
// provider key that shares a prefix (OpenAI vs DeepSeek both `sk-`), an admin
// key that can't call models, or a no-credits key. This fires one minimal
// generation through the SAME buildConfiguredLanguageModel + Rust-proxy fetch
// as a real run (so there's no CORS issue) and maps the outcome to a verdict.

import { generateText } from "ai";
import { isReasoningModel, MODELS, type ModelId, type ProviderId } from "../config";
import { EMPTY_PROVIDER_KEYS } from "./keyring";
import { buildConfiguredLanguageModel, type LocalProviderConfig } from "./agent";

export type KeyTestResult = {
  /** True when the key is confirmed usable (incl. valid-but-rate-limited). */
  ok: boolean;
  kind: "valid" | "rejected" | "no-credits" | "rate-limited" | "inconclusive";
  message: string;
};

/** Pick a cheap, non-reasoning model for this provider so a tiny token cap
 *  doesn't starve a reasoning budget. Falls back to any model. */
function probeModelId(provider: ProviderId): ModelId | null {
  const forProvider = MODELS.filter((m) => m.provider === provider);
  const pick =
    forProvider.find((m) => !isReasoningModel(m.id)) ?? forProvider[0];
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
    // maxOutputTokens: 1 — auth is validated before token-limit processing, so
    // this is enough to confirm the key without paying for a real generation.
    await generateText({ model: built, prompt: "ping", maxOutputTokens: 1 });
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

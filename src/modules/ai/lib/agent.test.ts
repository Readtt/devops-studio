// What each provider's transport actually puts on the wire for a schema run.
// The model tables can be right and a run still 400 on the request SHAPE —
// DeepSeek did, on every structured run, because we told the SDK it took
// `json_schema`.

import { describe, expect, it, vi } from "vitest";

const bodies: Array<Record<string, unknown>> = [];

// Capture the request body instead of crossing the Tauri IPC boundary, and
// answer like an OpenAI-compatible chat endpoint would.
vi.mock("./proxyFetch", () => {
  const fake = async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(
      JSON.stringify({
        id: "x",
        object: "chat.completion",
        created: 0,
        model: "m",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: '{"a":1}' },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  return { proxyFetch: fake, createProxyFetch: () => fake };
});

import { generateObject } from "ai";
import { z } from "zod";
import { buildLanguageModel } from "./agent";
import { EMPTY_PROVIDER_KEYS } from "./keyring";
import type { ProviderId } from "../config";

async function schemaRunBody(
  provider: ProviderId,
  modelId: string,
): Promise<Record<string, unknown>> {
  const model = await buildLanguageModel(
    provider,
    { ...EMPTY_PROVIDER_KEYS, [provider]: "k" },
    modelId,
  );
  await generateObject({
    model,
    schema: z.object({ a: z.number() }),
    prompt: "Return the JSON.",
  });
  return bodies[bodies.length - 1];
}

describe("structured output: what goes on the wire", () => {
  // DeepSeek's API takes `text` or `json_object` only; `json_schema` is
  // "400 This response_format type is unavailable now".
  it("DeepSeek gets json_object", async () => {
    const body = await schemaRunBody("deepseek", "deepseek-flash");
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("Mistral keeps strict json_schema", async () => {
    const body = await schemaRunBody("mistral", "mistral-medium-latest");
    expect((body.response_format as { type: string }).type).toBe("json_schema");
  });

  it("OpenRouter keeps strict json_schema", async () => {
    const body = await schemaRunBody("openrouter", "moonshotai/kimi-k2.5");
    expect((body.response_format as { type: string }).type).toBe("json_schema");
  });
});

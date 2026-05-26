import type { ModelMessage } from "ai";

/** Minimal attachment shape the vision helper needs — structurally satisfied
 *  by the shared Attachment and the runners' RunAttachment. */
type ImageLike = { kind?: string; content: string; mime?: string };

/** Build the user-turn payload for an `ai` SDK call (generateText/streamText).
 *
 *  When there are image attachments, return a `messages` array whose single
 *  user message carries a text part plus one image part per image — so the
 *  model actually sees them (real vision). With no images, return a plain
 *  `prompt` string: the common, cheaper path that leaves text-only runs byte
 *  for byte unchanged. Text attachments are assumed already embedded in
 *  `text` by the caller, so only images are lifted into parts here.
 *
 *  Spread the result into the SDK call: `generateText({ model, system,
 *  ...buildUserTurn(prompt, attachments) })`. */
export function buildUserTurn(
  text: string,
  attachments: ImageLike[] | undefined,
): { prompt: string } | { messages: ModelMessage[] } {
  const images = (attachments ?? []).filter(
    (a) => a.kind === "image" && a.content.startsWith("data:"),
  );
  if (images.length === 0) return { prompt: text };
  return {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text },
          ...images.map((a) => ({
            type: "image" as const,
            image: a.content,
            ...(a.mime ? { mediaType: a.mime } : {}),
          })),
        ],
      },
    ],
  };
}

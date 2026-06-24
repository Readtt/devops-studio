import type { ModelMessage } from "ai";

/** Minimal attachment shape the vision helper needs — structurally satisfied
 *  by the shared Attachment and the runners' RunAttachment. */
type ImageLike = { kind?: string; content: string; mime?: string };

/** Decode a `data:<mime>;base64,<payload>` URL into raw bytes + media type.
 *
 *  We must NOT hand the SDK the `data:` URL string directly: the AI SDK treats
 *  any string that parses as a URL (and `data:` URLs do) as a *remote* asset
 *  and tries to `fetch()` it. In the Tauri webview that fetch is blocked by the
 *  CSP `connect-src` allowlist, which surfaces as the user-facing "fetch
 *  failed" error when an image is pasted. Passing a `Uint8Array` makes the SDK
 *  inline the bytes verbatim — no network round-trip, no CSP dependency, and
 *  identical to what every provider expects for an inline image. */
function dataUrlToImagePart(
  dataUrl: string,
  mimeHint?: string,
): { bytes: Uint8Array; mediaType: string } | null {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
  if (!match) return null;
  const mediaType = mimeHint ?? match[1] ?? "image/png";
  try {
    const binary = atob(match[2]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { bytes, mediaType };
  } catch {
    return null;
  }
}

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
          ...images.map((a) => {
            const decoded = dataUrlToImagePart(a.content, a.mime);
            // Decoded bytes are inlined by the SDK (no fetch). If decoding ever
            // fails we fall back to the raw data URL so we degrade to the old
            // behavior rather than dropping the image entirely.
            return decoded
              ? {
                  type: "image" as const,
                  image: decoded.bytes,
                  mediaType: decoded.mediaType,
                }
              : {
                  type: "image" as const,
                  image: a.content,
                  ...(a.mime ? { mediaType: a.mime } : {}),
                };
          }),
        ],
      },
    ],
  };
}

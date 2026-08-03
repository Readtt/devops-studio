// Shared mechanism for folding arbitrary "context blocks" (best-practices
// files, attached ADO bugs, …) into the prompt-string + multimodal-image
// surface every runner already speaks. There is no central AI entry point —
// each runner builds its own prompt — so this is a small composable helper the
// prompt builders call, NOT a new pipeline.
//
// Design contract: when there are no blocks, formatContextBlocks returns "" and
// collectContextImages returns []. Callers append the formatted string only
// when non-empty, which keeps text-only runs byte-for-byte unchanged (and the
// provider prompt cache warm).

import type { Attachment } from "@/components/chat/attachments";

/** One labelled chunk of context. `body` is plain text already rendered by the
 *  caller (e.g. a bug's repro + code links, or a standards file's contents).
 *  `images` are lifted into real vision parts via collectContextImages — the
 *  body should reference them by name, not inline their bytes. */
export type ContextBlock = {
  heading: string;
  body: string;
  images?: Attachment[];
};

/** Render blocks as `--- HEADING ---\n<body>` chunks joined by blank lines —
 *  the same delimiter style as formatAttachmentBlock / renderCasesBlock so the
 *  model sees a consistent shape. Empty/whitespace-only blocks are dropped;
 *  an empty input yields "" so callers can skip appending entirely. */
export function formatContextBlocks(blocks: ContextBlock[]): string {
  return blocks
    .filter((b) => b.body.trim().length > 0)
    .map((b) => `--- ${b.heading} ---\n${b.body.trim()}`)
    .join("\n\n");
}

/** Flatten the images across all blocks so a caller can merge them into the
 *  `attachments` array it already threads through buildUserTurn (which lifts
 *  kind:"image" data-URLs into image parts). Returns [] when there are none. */
export function collectContextImages(blocks: ContextBlock[]): Attachment[] {
  return blocks.flatMap((b) => b.images ?? []);
}

/** Take the first `cap` characters without splitting a surrogate pair — a lone
 *  surrogate reaches the provider as invalid UTF-8. Shared by the two places
 *  that back-stop user-supplied prompt content (best-practices files and
 *  attachments); neither ever truncates silently, so see their callers for the
 *  marker that tells the model what was cut. */
export function clipPromptText(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const c = text.charCodeAt(cap);
  return text.slice(0, c >= 0xdc00 && c <= 0xdfff ? cap - 1 : cap);
}

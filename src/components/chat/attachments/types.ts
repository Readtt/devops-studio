// Shared attachment shape for every chat surface (generator, suite chat,
// code review). Images are held as base64 data URLs so they survive a reload
// when persisted inside the surrounding message/draft JSON.

export type AttachmentKind = "text" | "image" | "binary";

export type Attachment = {
  /** Stable id assigned at ingest time. Used for dedup and remove
   *  operations so two attachments with identical `path` (e.g. two
   *  Windows screenshots both named "Screenshot 2026-05-23 12.34.56.png")
   *  can coexist without one silently replacing the other. */
  id: string;
  /** Display name. For dropped files this is the original filename; for
   *  clipboard images we synthesize "pasted-<timestamp>.<ext>". */
  path: string;
  /** Text content for kind="text"; base64 data URL for kind="image"; empty
   *  string for kind="binary" (we don't ship binary blobs through the LLM,
   *  only the filename is surfaced). */
  content: string;
  kind: AttachmentKind;
  mime?: string;
  sizeBytes?: number;
};

/** Mint a fresh attachment id. crypto.randomUUID is available in every
 *  modern browser context Tauri exposes; falls back to a timestamp-based
 *  id for the very rare path where the Web Crypto API isn't present. */
export function newAttachmentId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

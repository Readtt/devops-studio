// Loads the user's registered best-practices / coding-standards files at
// AI-run time and turns them into a single context block (plus any image
// attachments). Files are PATH REFERENCES read live here — a shared network
// .md stays the single source of truth (see settings/store BestPracticeFile).
//
// Never throws: an unreadable / offline / oversized file is skipped and
// recorded in `warnings`, so a missing network share can't break a generation.

import { invoke } from "@tauri-apps/api/core";
import type { ContextBlock } from "./contextBlocks";
import { newAttachmentId, type Attachment } from "@/components/chat/attachments";
import type { BestPracticeFile } from "@/modules/settings/store";

/** Mirror of the Rust `fs_read_file` ReadResult (tag = "kind"). */
type ReadResult =
  | { kind: "text"; content: string; size: number }
  | { kind: "binary"; size: number }
  | { kind: "toolarge"; size: number; limit: number };

/** Mirror of the Rust `fs_read_file_b64` FileBase64. */
type FileBase64 = { mediaType: string; dataBase64: string; size: number };

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]);

function extOf(path: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(path.trim());
  return m ? m[1].toLowerCase() : "";
}

function baseName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path;
}

export type BestPracticeLoadResult = {
  /** Zero or one combined block. Empty when nothing readable was registered. */
  blocks: ContextBlock[];
  /** Human-readable notes about files that were skipped. */
  warnings: string[];
};

/** Read the enabled best-practices files live and fold them into one context
 *  block. Images are lifted into multimodal attachments only when the active
 *  model is `visionCapable`; otherwise they degrade to a text reference. */
export async function loadBestPracticeBlocks(
  files: BestPracticeFile[],
  opts?: { visionCapable?: boolean },
): Promise<BestPracticeLoadResult> {
  const visionCapable = opts?.visionCapable ?? false;
  const enabled = files.filter((f) => f.enabled && f.path.trim().length > 0);
  if (enabled.length === 0) return { blocks: [], warnings: [] };

  const sections: string[] = [];
  const images: Attachment[] = [];
  const warnings: string[] = [];

  for (const f of enabled) {
    const label = f.label.trim() || baseName(f.path);
    const ext = extOf(f.path);
    try {
      if (IMAGE_EXTS.has(ext)) {
        if (!visionCapable) {
          sections.push(
            `## ${label}\n[image standards file "${baseName(f.path)}" — not shown; the active model has no vision support]`,
          );
          continue;
        }
        const b64 = await invoke<FileBase64>("fs_read_file_b64", {
          path: f.path,
        });
        images.push({
          id: newAttachmentId(),
          path: baseName(f.path),
          content: `data:${b64.mediaType};base64,${b64.dataBase64}`,
          kind: "image",
          mime: b64.mediaType,
          sizeBytes: b64.size,
        });
        sections.push(
          `## ${label}\n[image standards file "${baseName(f.path)}" — attached for reference]`,
        );
      } else {
        const res = await invoke<ReadResult>("fs_read_file", { path: f.path });
        if (res.kind === "text") {
          if (res.content.trim().length === 0) {
            warnings.push(`${label}: file is empty — skipped.`);
            continue;
          }
          sections.push(`## ${label}\n${res.content.trim()}`);
        } else if (res.kind === "toolarge") {
          warnings.push(
            `${label}: file too large (${res.size} bytes) — skipped.`,
          );
        } else {
          warnings.push(`${label}: not a text/markdown file — skipped.`);
        }
      }
    } catch {
      warnings.push(
        `${label}: could not read "${f.path}" — skipped (offline network path?).`,
      );
    }
  }

  if (sections.length === 0) {
    return { blocks: [], warnings };
  }

  const block: ContextBlock = {
    heading:
      "BEST PRACTICES / CODING STANDARDS — apply these to your analysis and any code or tests you produce",
    body: sections.join("\n\n"),
    images: images.length > 0 ? images : undefined,
  };
  return { blocks: [block], warnings };
}

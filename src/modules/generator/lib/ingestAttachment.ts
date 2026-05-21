// Browser-side helpers that turn `File` / `Blob` / DataTransferItem objects
// into the session's Attachment shape. Used by the requirements drag-drop
// zone and the textarea paste handler.

import type { Attachment } from "../store/useGenerationSession";

const TEXT_BYTE_CAP = 200 * 1024; // 200 KB
const IMAGE_BYTE_CAP = 2 * 1024 * 1024; // 2 MB

const TEXT_MIMES = new Set<string>([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/typescript",
  "application/x-sh",
  "application/x-httpd-php",
]);

const TEXT_EXTS = new Set<string>([
  "txt",
  "md",
  "mdx",
  "rst",
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "json",
  "yaml",
  "yml",
  "toml",
  "ini",
  "env",
  "csv",
  "tsv",
  "py",
  "rb",
  "rs",
  "go",
  "java",
  "kt",
  "swift",
  "c",
  "h",
  "cc",
  "cpp",
  "hpp",
  "cs",
  "php",
  "lua",
  "sql",
  "html",
  "htm",
  "css",
  "scss",
  "sass",
  "less",
  "sh",
  "bash",
  "zsh",
  "fish",
  "ps1",
  "bat",
  "log",
  "diff",
  "patch",
  "gitignore",
  "dockerfile",
]);

export type IngestError = {
  reason: "too-large" | "unsupported" | "read-failed";
  message: string;
};

/** Ingest a single File into an Attachment. Returns a discriminated result so
 *  callers can decide whether to show an inline error chip or surface a toast. */
export async function ingestFile(
  file: File,
): Promise<{ ok: true; attachment: Attachment } | { ok: false; error: IngestError }> {
  const mime = file.type || "application/octet-stream";

  if (mime.startsWith("image/")) {
    if (file.size > IMAGE_BYTE_CAP) {
      return {
        ok: false,
        error: {
          reason: "too-large",
          message: `${file.name}: image is ${formatBytes(file.size)} (cap ${formatBytes(IMAGE_BYTE_CAP)})`,
        },
      };
    }
    const dataUrl = await readAsDataUrl(file);
    return {
      ok: true,
      attachment: {
        path: file.name,
        content: dataUrl,
        kind: "image",
        mime,
        sizeBytes: file.size,
      },
    };
  }

  if (isProbablyText(file, mime)) {
    if (file.size > TEXT_BYTE_CAP) {
      return {
        ok: false,
        error: {
          reason: "too-large",
          message: `${file.name}: ${formatBytes(file.size)} (cap ${formatBytes(TEXT_BYTE_CAP)})`,
        },
      };
    }
    const text = await readAsText(file);
    return {
      ok: true,
      attachment: {
        path: file.name,
        content: text,
        kind: "text",
        mime,
        sizeBytes: file.size,
      },
    };
  }

  return {
    ok: false,
    error: {
      reason: "unsupported",
      message: `${file.name}: unsupported file type (${mime || "unknown"})`,
    },
  };
}

/** Synthesize a filename for a clipboard image that arrived without one. */
export function synthesizeClipboardImageName(mime: string): string {
  const ext = mime.split("/")[1] || "png";
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .slice(0, 19);
  return `pasted-${stamp}.${ext}`;
}

function isProbablyText(file: File, mime: string): boolean {
  if (mime.startsWith("text/")) return true;
  if (TEXT_MIMES.has(mime)) return true;
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return TEXT_EXTS.has(ext);
}

function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsText(file);
  });
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

import { useCallback, useState } from "react";
import { ingestFile, synthesizeClipboardImageName } from "./ingestAttachment";
import { newAttachmentId, type Attachment } from "./types";

/** Local pending-attachment state for a chat composer. Each composer owns its
 *  own list (unlike the generator's session-global store), so attachments
 *  clear when the message is sent. Handles drag-drop, clipboard paste, and a
 *  file picker; ingestion errors surface as dismissible chips.
 *
 *  Dedup mirrors the generator: text files dedup by path (re-dropping a file
 *  replaces it); images/binaries always append (two pasted screenshots get
 *  distinct synthesized names + ids and should both survive). */
export function useAttachments() {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [errors, setErrors] = useState<{ id: string; message: string }[]>([]);

  const ingest = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    for (const f of files) {
      const result = await ingestFile(f);
      if (result.ok) {
        const att = result.attachment;
        setAttachments((prev) => {
          if (att.kind === "text") {
            return [...prev.filter((a) => a.path !== att.path), att];
          }
          return [...prev, att];
        });
      } else {
        setErrors((prev) => [
          ...prev,
          { id: newAttachmentId(), message: result.error.message },
        ]);
      }
    }
  }, []);

  const onFilePicker = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      void ingest(files);
      // Reset so picking the same file twice still fires onChange.
      e.target.value = "";
    },
    [ingest],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const files = Array.from(e.dataTransfer?.files ?? []);
      void ingest(files);
    },
    [ingest],
  );

  const onPaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = Array.from(e.clipboardData?.files ?? []) as File[];
      if (items.length === 0) return;
      // Files take precedence over any text payload — suppress the default
      // insert so the user gets a chip, not a base64 dump in the textarea.
      e.preventDefault();
      const named = items.map((f) => {
        if (f.name) return f;
        const synthetic = synthesizeClipboardImageName(f.type || "image/png");
        return new File([f], synthetic, { type: f.type });
      });
      void ingest(named);
    },
    [ingest],
  );

  const remove = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const clear = useCallback(() => {
    setAttachments([]);
    setErrors([]);
  }, []);

  const dismissError = useCallback((id: string) => {
    setErrors((prev) => prev.filter((e) => e.id !== id));
  }, []);

  return {
    attachments,
    errors,
    onFilePicker,
    onDrop,
    onPaste,
    remove,
    clear,
    dismissError,
  };
}

export type UseAttachments = ReturnType<typeof useAttachments>;

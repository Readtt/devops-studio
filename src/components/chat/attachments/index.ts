export type { Attachment, AttachmentKind } from "./types";
export { newAttachmentId } from "./types";
export {
  ingestFile,
  synthesizeClipboardImageName,
  imageAttachmentToBase64,
  type IngestError,
} from "./ingestAttachment";
export { AttachmentList } from "./AttachmentList";
export { useAttachments, type UseAttachments } from "./useAttachments";
export { AttachmentDropZone, AttachButton } from "./AttachmentDropZone";

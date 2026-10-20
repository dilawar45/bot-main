import { createHash } from "node:crypto";
import type { MediaUploadRequest } from "@huzaifa/contracts";

const extensions: Record<MediaUploadRequest["mimeType"], string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export function createInboundMediaPath(request: MediaUploadRequest): string {
  const chatHash = sha256(request.chatId).slice(0, 24);
  const messageHash = sha256(request.messageId).slice(0, 32);
  return `messages/${chatHash}/${messageHash}.${extensions[request.mimeType]}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
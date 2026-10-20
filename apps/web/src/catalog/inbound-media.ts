import type { SupabaseClient } from "@supabase/supabase-js";
import type { InboundImage } from "@/agent/agent";

// Must match createInboundMediaPath: messages/<24 hex>/<32 hex>.<ext>
const INBOUND_PATH = /^messages\/[a-f0-9]{24}\/[a-f0-9]{32}\.(jpg|png|webp)$/;
const MIME_BY_EXTENSION: Record<string, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };
const MAX_BYTES = 10 * 1024 * 1024;

export function isInboundMediaPath(path: string): boolean {
  return INBOUND_PATH.test(path);
}

export function createInboundImageLoader(client: SupabaseClient) {
  return async (objectPath: string): Promise<InboundImage | null> => {
    if (!isInboundMediaPath(objectPath)) return null;
    const { data, error } = await client.storage.from("inbound-media").download(objectPath);
    if (error || !data || data.size === 0 || data.size > MAX_BYTES) return null;
    const extension = objectPath.slice(objectPath.lastIndexOf(".") + 1);
    return { base64: Buffer.from(await data.arrayBuffer()).toString("base64"), mimeType: MIME_BY_EXTENSION[extension] ?? "image/jpeg" };
  };
}

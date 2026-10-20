import type { SupabaseClient } from "@supabase/supabase-js";
import type { InboundImage } from "../agent/agent";
import { embedImage } from "../ai/gemini";
import { isMissingSchema } from "./repository";
import { embeddingSourceHash } from "./semantic";

// Keeps product_images.image_embedding in step with the shop's photos, so a customer's photo finds the product it
// shows (public.match_product_images). Only the first few photos of each active product are embedded: those are
// what customers screenshot, and it caps the cost. A photo already embedded with the same model is skipped (files
// are never replaced in place: a new upload gets a new path), so this runs after every product edit.

export const PHOTOS_PER_PRODUCT = 3;
const BUCKET = "product-images";
const MIME_BY_EXTENSION: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };
// Shop photos shown to the reply model: bigger originals (straight from a phone camera) cost seconds per model call.
const REFERENCE_MAX_BYTES = 1_500_000;

export type PhotoIndexResult = {
  // False until the photo search migration is applied.
  available: boolean;
  updated: number;
  unchanged: number;
  failed: number;
  // Photos not reached before the time budget ran out (press the button again).
  remaining: number;
};

type ImageRow = { id: string; storage_path: string; sort_order: number; image_embedding_hash: string | null };
type ProductRow = { id: string; product_images: ImageRow[] };

export function imageMimeType(storagePath: string): string | null {
  return MIME_BY_EXTENSION[storagePath.slice(storagePath.lastIndexOf(".") + 1).toLowerCase()] ?? null;
}

// The photos of one product that get embedded: the first few, in the order the shop shows them.
export function photosToIndex<T extends { storage_path: string; sort_order: number }>(images: readonly T[]): T[] {
  return [...images].sort((a, b) => a.sort_order - b.sort_order || a.storage_path.localeCompare(b.storage_path)).slice(0, PHOTOS_PER_PRODUCT);
}

export function photoEmbeddingHash(storagePath: string, model: string): string {
  return embeddingSourceHash(storagePath, model);
}

async function downloadPhoto(client: SupabaseClient, storagePath: string): Promise<InboundImage> {
  const mimeType = imageMimeType(storagePath);
  if (!mimeType) throw new Error(`Not a JPEG, PNG or WebP photo: ${storagePath}`);
  const { data, error } = await client.storage.from(BUCKET).download(storagePath, undefined, { signal: AbortSignal.timeout(10_000) });
  if (error || !data || data.size === 0) throw error ?? new Error("The photo file is empty");
  return { base64: Buffer.from(await data.arrayBuffer()).toString("base64"), mimeType };
}

export async function refreshProductImageEmbeddings(
  client: SupabaseClient,
  options: { apiKey: string | readonly string[]; model: string; productIds?: readonly string[]; budgetMs?: number; fetchImpl?: typeof fetch },
): Promise<PhotoIndexResult> {
  const result: PhotoIndexResult = { available: true, updated: 0, unchanged: 0, failed: 0, remaining: 0 };
  let query = client.from("products").select("id, product_images(id, storage_path, sort_order, image_embedding_hash)").eq("status", "active").limit(2_000);
  if (options.productIds) query = query.in("id", [...options.productIds]);
  const { data, error } = await query.returns<ProductRow[]>();
  if (error) {
    if (isMissingSchema(error)) return { ...result, available: false };
    throw error;
  }

  const stale: { image: ImageRow; hash: string }[] = [];
  const otherModel: string[] = [];
  for (const product of data ?? []) {
    const wanted = new Set(photosToIndex(product.product_images).map((image) => image.id));
    for (const image of product.product_images) {
      const hash = photoEmbeddingHash(image.storage_path, options.model);
      if (image.image_embedding_hash === hash) {
        if (wanted.has(image.id)) result.unchanged += 1;
        continue;
      }
      // Made by another model: not comparable with today's queries, so it goes even if it isn't redone.
      if (image.image_embedding_hash !== null) otherModel.push(image.id);
      if (wanted.has(image.id)) stale.push({ image, hash });
    }
  }
  // In chunks: the ids travel in the URL.
  for (let index = 0; index < otherModel.length; index += 100) {
    const { error: clearError } = await client
      .from("product_images")
      .update({ image_embedding: null, image_embedding_hash: null })
      .in("id", otherModel.slice(index, index + 100));
    if (clearError) throw clearError;
  }

  const deadline = Date.now() + (options.budgetMs ?? 30_000);
  // A few at a time: photos are big requests, and per-minute quotas are shared with the replies.
  for (let index = 0; index < stale.length; index += 3) {
    if (Date.now() > deadline) {
      result.remaining = stale.length - index;
      break;
    }
    await Promise.all(
      stale.slice(index, index + 3).map(async ({ image, hash }) => {
        try {
          const photo = await downloadPhoto(client, image.storage_path);
          const vector = await embedImage({ apiKey: options.apiKey, model: options.model, image: photo, fetchImpl: options.fetchImpl });
          const { error: updateError } = await client
            .from("product_images")
            // pgvector reads its text form "[0.1,0.2,…]".
            .update({ image_embedding: JSON.stringify(vector), image_embedding_hash: hash })
            .eq("id", image.id);
          if (updateError) throw updateError;
          result.updated += 1;
        } catch (embedError) {
          result.failed += 1;
          console.error("Embedding a product photo failed", { imageId: image.id, error: embedError instanceof Error ? embedError.message : embedError });
        }
      }),
    );
  }
  return result;
}

// How many of the photos customers' pictures are compared with are embedded with the current model.
export async function photoIndexStatus(client: SupabaseClient, model: string): Promise<{ available: boolean; indexed: number; total: number }> {
  const { data, error } = await client
    .from("products")
    .select("id, product_images(storage_path, sort_order, image_embedding_hash)")
    .eq("status", "active")
    .limit(2_000)
    .returns<{ id: string; product_images: Omit<ImageRow, "id">[] }[]>();
  if (error) {
    if (isMissingSchema(error)) return { available: false, indexed: 0, total: 0 };
    throw error;
  }
  const photos = (data ?? []).flatMap((product) => photosToIndex(product.product_images));
  const indexed = photos.filter((photo) => photo.image_embedding_hash === photoEmbeddingHash(photo.storage_path, model)).length;
  return { available: true, indexed, total: photos.length };
}

// Shop photos shown to the reply model next to the customer's photo, so it can compare them by eye. Read from the
// public URL (CDN-cached); a big original or a slow download is skipped, never waited for.
export function createProductPhotoLoader(
  publicUrl: (storagePath: string) => string,
  options: { maxBytes?: number; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): (storagePath: string) => Promise<InboundImage | null> {
  const maxBytes = options.maxBytes ?? REFERENCE_MAX_BYTES;
  return async (storagePath) => {
    const mimeType = imageMimeType(storagePath);
    if (!mimeType) return null;
    try {
      const response = await (options.fetchImpl ?? fetch)(publicUrl(storagePath), { signal: AbortSignal.timeout(options.timeoutMs ?? 2_500) });
      if (!response.ok || Number(response.headers.get("content-length") ?? 0) > maxBytes) {
        await response.body?.cancel().catch(() => undefined);
        return null;
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      return bytes.length > 0 && bytes.length <= maxBytes ? { base64: bytes.toString("base64"), mimeType } : null;
    } catch {
      return null;
    }
  };
}

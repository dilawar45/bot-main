"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { PostgrestError } from "@supabase/supabase-js";
import { requireAdmin } from "@/auth/admin";
import {
  PRODUCT_IMAGE_MAX_BYTES,
  PRODUCT_IMAGE_MIME_TYPES,
  getPublishBlockers,
  isProductImagePathFor,
  parseProductForm,
  parseVariantRows,
  productImageExtension,
  type ProductImageMimeType,
} from "@/catalog/admin/validation";
import { refreshSearchIndexLater } from "@/catalog/admin/search-index";
import { refreshProductEmbeddings } from "@/catalog/embeddings";
import { refreshProductImageEmbeddings } from "@/catalog/image-embeddings";
import { getVisionEnvironment } from "@/config/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceClient } from "@/lib/supabase/service";

export type ActionState = { error?: string; message?: string };

// Products page button: embed every active product whose text changed (or that was never embedded), and every
// product photo not yet embedded with the current photo model.
export async function rebuildSearchIndex(): Promise<ActionState> {
  await requireAdmin();
  const { geminiKeys, embeddingModel, imageEmbeddingModel } = getVisionEnvironment();
  if (!geminiKeys.length) return { error: "Meaning search needs GEMINI_API_KEY in the server environment." };
  try {
    const client = createSupabaseServiceClient();
    // Side by side (different models, separate quotas); a photo failure still reports the text index.
    const [result, photos] = await Promise.all([
      refreshProductEmbeddings(client, { apiKey: geminiKeys, model: embeddingModel, budgetMs: 45_000 }),
      // Shorter: a batch of photos started just before the deadline can still take ~25 s.
      refreshProductImageEmbeddings(client, { apiKey: geminiKeys, model: imageEmbeddingModel, budgetMs: 30_000 }).catch((error: unknown) => {
        console.error("Photo index rebuild failed", error);
        return null;
      }),
    ]);
    if (!result.available) return { error: "The database doesn't have meaning search yet. Apply migration 202609290004_product_embeddings.sql first." };
    revalidatePath("/admin/products");
    const parts = [`${result.updated} updated`, `${result.unchanged} already up to date`];
    if (result.failed) parts.push(`${result.failed} failed (try again)`);
    if (result.remaining) parts.push(`${result.remaining} left — press again to continue`);
    const photoParts = !photos
      ? ["could not be updated (try again)"]
      : !photos.available
        ? ["off until migration 202610060002_product_image_embeddings.sql is applied"]
        : [
            `${photos.updated} added`,
            `${photos.unchanged} already up to date`,
            ...(photos.failed ? [`${photos.failed} failed (try again)`] : []),
            ...(photos.remaining ? [`${photos.remaining} left — press again to continue`] : []),
          ];
    const summary = `Search index: ${parts.join(", ")}. Photos: ${photoParts.join(", ")}.`;
    return result.failed || !photos || photos.failed ? { error: summary } : { message: summary };
  } catch (error) {
    console.error("Search index rebuild failed", error);
    return { error: "Could not update the search index. Try again." };
  }
}

const PRODUCT_IMAGES_BUCKET = "product-images";

function describeDatabaseError(error: PostgrestError, fallback: string): string {
  if (error.code === "23505") {
    if (error.message.includes("variant_sku")) return "That variant SKU is already used by another size.";
    if (error.message.includes("sku")) return "Another product already uses this SKU.";
    return "That value is already in use.";
  }
  console.error(fallback, { code: error.code, message: error.message });
  return fallback;
}

function refreshProduct(productId: string) {
  revalidatePath("/admin/products");
  revalidatePath(`/admin/products/${productId}`);
  // Meaning search follows name/description/tag/photo edits (skipped when nothing it uses changed).
  refreshSearchIndexLater(productId);
}

async function loadCounts(productId: string) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("products")
    .select("sku, name, category, price_pkr, status, product_images(count), product_variants(count)")
    .eq("id", productId)
    .maybeSingle<{
      sku: string;
      name: string;
      category: string;
      price_pkr: number;
      status: "draft" | "active" | "archived";
      product_images: { count: number }[];
      product_variants: { count: number }[];
    }>();
  if (error || !data) return null;
  return {
    status: data.status,
    candidate: {
      sku: data.sku,
      name: data.name,
      category: data.category,
      pricePkr: data.price_pkr,
      imageCount: data.product_images[0]?.count ?? 0,
      variantCount: data.product_variants[0]?.count ?? 0,
    },
  };
}

export async function createProduct(_previous: ActionState, formData: FormData): Promise<ActionState> {
  await requireAdmin();
  const parsed = parseProductForm(formData);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form." };

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("products")
    .insert({
      sku: parsed.data.sku,
      name: parsed.data.name,
      description: parsed.data.description,
      category: parsed.data.category,
      color: parsed.data.color,
      material: parsed.data.material,
      style_tags: parsed.data.styleTags,
      aliases: parsed.data.aliases,
      price_pkr: parsed.data.pricePkr,
      status: "draft",
    })
    .select("id")
    .single<{ id: string }>();
  if (error) return { error: describeDatabaseError(error, "Could not create the product.") };

  revalidatePath("/admin/products");
  redirect(`/admin/products/${data.id}`);
}

export async function updateProduct(productId: string, _previous: ActionState, formData: FormData): Promise<ActionState> {
  await requireAdmin();
  const parsed = parseProductForm(formData);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form." };

  const current = await loadCounts(productId);
  if (!current) return { error: "Product not found." };
  if (current.status === "active") {
    const blockers = getPublishBlockers({ ...current.candidate, ...parsed.data });
    if (blockers.length) return { error: `A live product needs: ${blockers.join(" ")}` };
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("products")
    .update({
      sku: parsed.data.sku,
      name: parsed.data.name,
      description: parsed.data.description,
      category: parsed.data.category,
      color: parsed.data.color,
      material: parsed.data.material,
      style_tags: parsed.data.styleTags,
      aliases: parsed.data.aliases,
      price_pkr: parsed.data.pricePkr,
    })
    .eq("id", productId);
  if (error) return { error: describeDatabaseError(error, "Could not save the product.") };

  refreshProduct(productId);
  return { message: "Details saved." };
}

export async function saveVariants(productId: string, _previous: ActionState, formData: FormData): Promise<ActionState> {
  await requireAdmin();
  const parsed = parseVariantRows(formData);
  if (!parsed.ok) return { error: parsed.error };

  const current = await loadCounts(productId);
  if (!current) return { error: "Product not found." };
  if (current.status === "active" && parsed.variants.length === 0) {
    return { error: "A live product needs at least one size. Move it back to draft first." };
  }

  const supabase = await createSupabaseServerClient();
  if (parsed.variants.length > 0) {
    // Stock is saved as the owner's change on top of the current stock: orders confirmed or cancelled while
    // this page was open (which take or give back stock) are kept, not overwritten with the old numbers.
    const { data: currentRows } = await supabase.from("product_variants").select("normalized_size, stock_qty").eq("product_id", productId);
    const current = new Map((currentRows ?? []).map((row) => [row.normalized_size as string, row.stock_qty as number]));
    const { error } = await supabase.from("product_variants").upsert(
      parsed.variants.map((variant) => {
        const now = current.get(variant.normalizedSize);
        const stock = variant.stockLoaded != null && now !== undefined ? Math.max(0, now + (variant.stockQty - variant.stockLoaded)) : variant.stockQty;
        return {
          product_id: productId,
          size_label: variant.sizeLabel,
          normalized_size: variant.normalizedSize,
          stock_qty: stock,
          variant_sku: variant.variantSku,
        };
      }),
      { onConflict: "product_id,normalized_size" },
    );
    if (error) return { error: describeDatabaseError(error, "Could not save sizes.") };
  }

  let removal = supabase.from("product_variants").delete().eq("product_id", productId);
  if (parsed.variants.length > 0) {
    removal = removal.not("normalized_size", "in", `(${parsed.variants.map((variant) => `"${variant.normalizedSize}"`).join(",")})`);
  }
  const { error: removalError } = await removal;
  if (removalError) return { error: describeDatabaseError(removalError, "Could not remove old sizes.") };

  refreshProduct(productId);
  return { message: "Sizes and stock saved." };
}

export async function setProductStatus(
  productId: string,
  status: "draft" | "active" | "archived",
): Promise<ActionState> {
  await requireAdmin();
  const current = await loadCounts(productId);
  if (!current) return { error: "Product not found." };

  if (status === "active") {
    const blockers = getPublishBlockers(current.candidate);
    if (blockers.length) return { error: `Before publishing: ${blockers.join(" ")}` };
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("products").update({ status }).eq("id", productId);
  if (error) return { error: describeDatabaseError(error, "Could not change status.") };

  refreshProduct(productId);
  const labels = { active: "Published. The bot can now offer this product.", draft: "Moved to draft. Hidden from the bot.", archived: "Archived. Hidden from the bot." };
  return { message: labels[status] };
}

export type ImageUploadGrant = { ok: true; objectPath: string; signedUrl: string } | { ok: false; error: string };

export async function createProductImageUpload(productId: string, mimeType: string, sizeBytes: number): Promise<ImageUploadGrant> {
  await requireAdmin();
  if (!PRODUCT_IMAGE_MIME_TYPES.includes(mimeType as ProductImageMimeType)) return { ok: false, error: "Use a JPEG, PNG or WebP image." };
  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > PRODUCT_IMAGE_MAX_BYTES) return { ok: false, error: "Images must be 10 MB or smaller." };
  if (!(await loadCounts(productId))) return { ok: false, error: "Product not found." };

  const objectPath = `products/${productId}/${randomUUID()}.${productImageExtension(mimeType as ProductImageMimeType)}`;
  const { data, error } = await createSupabaseServiceClient().storage.from(PRODUCT_IMAGES_BUCKET).createSignedUploadUrl(objectPath);
  if (error) {
    console.error("Product image upload grant failed", { productId, message: error.message });
    return { ok: false, error: "Could not start the upload." };
  }
  return { ok: true, objectPath, signedUrl: data.signedUrl };
}

export async function attachProductImage(productId: string, objectPath: string): Promise<ActionState & { imageId?: string }> {
  await requireAdmin();
  if (!isProductImagePathFor(productId, objectPath)) return { error: "Invalid image path." };

  const folder = objectPath.slice(0, objectPath.lastIndexOf("/"));
  const fileName = objectPath.slice(objectPath.lastIndexOf("/") + 1);
  const { data: objects, error: listError } = await createSupabaseServiceClient().storage.from(PRODUCT_IMAGES_BUCKET).list(folder, { search: fileName, limit: 1 });
  if (listError || !objects?.some((object) => object.name === fileName)) return { error: "Upload did not reach storage. Try again." };

  const supabase = await createSupabaseServerClient();
  const { data: last } = await supabase
    .from("product_images")
    .select("sort_order")
    .eq("product_id", productId)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle<{ sort_order: number }>();

  const { data: inserted, error } = await supabase
    .from("product_images")
    .insert({ product_id: productId, storage_path: objectPath, sort_order: (last?.sort_order ?? -1) + 1 })
    .select("id")
    .single<{ id: string }>();
  if (error) return { error: describeDatabaseError(error, "Could not save the image.") };

  refreshProduct(productId);
  return { message: "Image added.", imageId: inserted.id };
}

export async function deleteProductImage(productId: string, imageId: string): Promise<ActionState> {
  await requireAdmin();
  const current = await loadCounts(productId);
  if (!current) return { error: "Product not found." };
  if (current.status === "active" && current.candidate.imageCount <= 1) {
    return { error: "A live product needs at least one image. Upload another first." };
  }

  const supabase = await createSupabaseServerClient();
  const { data: image, error } = await supabase
    .from("product_images")
    .delete()
    .eq("id", imageId)
    .eq("product_id", productId)
    .select("storage_path")
    .maybeSingle<{ storage_path: string }>();
  if (error) return { error: describeDatabaseError(error, "Could not remove the image.") };
  if (!image) return { error: "Image not found." };

  const { error: storageError } = await createSupabaseServiceClient().storage.from(PRODUCT_IMAGES_BUCKET).remove([image.storage_path]);
  if (storageError) console.error("Product image file removal failed", { productId, message: storageError.message });

  refreshProduct(productId);
  return { message: "Image removed." };
}

export async function moveProductImage(
  productId: string,
  imageId: string,
  direction: "up" | "down",
): Promise<ActionState> {
  await requireAdmin();
  const supabase = await createSupabaseServerClient();
  const { data: images, error } = await supabase
    .from("product_images")
    .select("id, sort_order")
    .eq("product_id", productId)
    .order("sort_order")
    .order("id")
    .returns<{ id: string; sort_order: number }[]>();
  if (error) return { error: describeDatabaseError(error, "Could not reorder images.") };

  const index = images.findIndex((image) => image.id === imageId);
  const target = direction === "up" ? index - 1 : index + 1;
  if (index === -1 || target < 0 || target >= images.length) return {};

  const reordered = [...images];
  [reordered[index], reordered[target]] = [reordered[target]!, reordered[index]!];
  // Rewrite dense positions so ties from older data can't make a swap a no-op.
  for (const [position, image] of reordered.entries()) {
    if (image.sort_order === position) continue;
    const { error: updateError } = await supabase.from("product_images").update({ sort_order: position }).eq("id", image.id);
    if (updateError) return { error: describeDatabaseError(updateError, "Could not reorder images.") };
  }

  refreshProduct(productId);
  return {};
}

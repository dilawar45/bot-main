"use server";

import { revalidatePath } from "next/cache";
import { GeminiError } from "@/ai/gemini";
import { requireAdmin } from "@/auth/admin";
import { refreshSearchIndexLater } from "@/catalog/admin/search-index";
import { fillEmptyFields, readStoredSuggestion, suggestFromProductImage, toStoredSuggestion } from "@/catalog/image-suggestions";
import { getVisionEnvironment } from "@/config/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import type { ActionState } from "./actions";

function refresh(productId: string) {
  revalidatePath(`/admin/products/${productId}`);
  // New AI photo descriptions and filled-in fields change what meaning search knows about the product.
  refreshSearchIndexLater(productId);
}

function describeGeminiFailure(error: unknown): string {
  if (error instanceof GeminiError) {
    if (error.kind === "http" && (error.status === 401 || error.status === 403)) return "Gemini rejected every API key. Check GEMINI_API_KEY.";
    if (error.kind === "http" && error.status === 404) return "Gemini model not found. Check GEMINI_MODEL_PRO.";
    if (error.kind === "http" && error.status === 429) return "All Gemini keys are rate-limited right now. Try again in a minute.";
    if (error.kind === "timeout") return "Gemini took too long. Try again.";
    if (error.kind === "blocked") return "Gemini declined to analyse this image.";
  }
  return "Image analysis failed. Try again.";
}

export async function analyzeProductImage(productId: string, imageId: string): Promise<ActionState> {
  await requireAdmin();
  const { geminiKeys, proModel, fastModel, fallbackModels } = getVisionEnvironment();
  if (!geminiKeys.length) return { error: "AI suggestions are off. Set GEMINI_API_KEY in the server environment." };

  const supabase = await createSupabaseServerClient();
  const { data: image, error } = await supabase
    .from("product_images")
    .select("id, storage_path")
    .eq("id", imageId)
    .eq("product_id", productId)
    .maybeSingle<{ id: string; storage_path: string }>();
  if (error || !image) return { error: "Image not found." };

  const { data: file, error: downloadError } = await createSupabaseServiceClient().storage.from("product-images").download(image.storage_path);
  if (downloadError || !file) return { error: "Could not read the image from storage." };

  try {
    const bytes = Buffer.from(await file.arrayBuffer());
    const mimeType = file.type || (image.storage_path.endsWith(".png") ? "image/png" : image.storage_path.endsWith(".webp") ? "image/webp" : "image/jpeg");
    const { suggestion, model: usedModel } = await suggestFromProductImage({ apiKey: geminiKeys, model: proModel, fallbackModels: [...fallbackModels, fastModel], imageBase64: bytes.toString("base64"), mimeType });

    const { error: updateError } = await supabase
      .from("product_images")
      .update({
        extraction_status: "complete",
        ai_description: suggestion.isProduct ? suggestion.description : null,
        ai_attributes: toStoredSuggestion(suggestion, usedModel),
      })
      .eq("id", imageId);
    if (updateError) return { error: "Could not save the suggestion." };

    refresh(productId);
    return { message: suggestion.isProduct ? "Suggestions ready." : "This photo doesn't look like a product." };
  } catch (failure) {
    console.error("Product image analysis failed", { productId, imageId, message: failure instanceof Error ? failure.message : String(failure) });
    await supabase
      .from("product_images")
      .update({ extraction_status: "failed", ai_attributes: { error: failure instanceof GeminiError ? failure.kind : "unknown", failedAt: new Date().toISOString() } })
      .eq("id", imageId);
    refresh(productId);
    return { error: describeGeminiFailure(failure) };
  }
}

export async function applyImageSuggestion(productId: string, imageId: string): Promise<ActionState> {
  await requireAdmin();
  const supabase = await createSupabaseServerClient();
  const [{ data: product }, { data: image }] = await Promise.all([
    supabase.from("products").select("color, material, description, style_tags").eq("id", productId).maybeSingle<{ color: string | null; material: string | null; description: string; style_tags: string[] }>(),
    supabase.from("product_images").select("ai_attributes").eq("id", imageId).eq("product_id", productId).maybeSingle<{ ai_attributes: unknown }>(),
  ]);
  if (!product || !image) return { error: "Product or image not found." };

  const suggestion = readStoredSuggestion(image.ai_attributes);
  if (!suggestion) return { error: "No suggestion for this image yet." };

  const patch = fillEmptyFields({ color: product.color, material: product.material, description: product.description, styleTags: product.style_tags }, suggestion);
  const fields = Object.keys(patch);
  if (!fields.length) return { message: "Nothing to fill. Your own values are kept." };

  const { error } = await supabase
    .from("products")
    .update({
      ...(patch.color !== undefined && { color: patch.color }),
      ...(patch.material !== undefined && { material: patch.material }),
      ...(patch.description !== undefined && { description: patch.description }),
      ...(patch.styleTags !== undefined && { style_tags: patch.styleTags }),
    })
    .eq("id", productId);
  if (error) return { error: "Could not apply the suggestion." };

  refresh(productId);
  revalidatePath("/admin/products");
  const labels: Record<string, string> = { color: "colour", material: "material", description: "description", styleTags: "tags" };
  return { message: `Filled ${fields.map((field) => labels[field]).join(", ")}. Review them in Details.` };
}

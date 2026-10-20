import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { productImagePublicUrl } from "@/lib/supabase/service";
import { readStoredSuggestion, type StoredSuggestion } from "../image-suggestions";
import { compareSizes } from "./validation";

export type ProductStatus = "draft" | "active" | "archived";
export const PRODUCT_STATUSES: ProductStatus[] = ["draft", "active", "archived"];

export type AdminProductImage = {
  id: string;
  storagePath: string;
  url: string;
  sortOrder: number;
  aiStatus: "pending" | "complete" | "failed";
  suggestion: StoredSuggestion | null;
};
export type AdminProductVariant = { id: string; sizeLabel: string; normalizedSize: string; stockQty: number; variantSku: string | null };

export type AdminProductSummary = {
  id: string;
  sku: string;
  name: string;
  category: string;
  pricePkr: number;
  status: ProductStatus;
  updatedAt: string;
  thumbnailUrl: string | null;
  sizeCount: number;
  sizesInStock: number;
};

export type AdminProduct = {
  id: string;
  sku: string;
  name: string;
  description: string;
  category: string;
  color: string | null;
  material: string | null;
  styleTags: string[];
  aliases: string[];
  pricePkr: number;
  status: ProductStatus;
  updatedAt: string;
  images: AdminProductImage[];
  variants: AdminProductVariant[];
};

type ProductRow = {
  id: string;
  sku: string;
  name: string;
  description: string;
  category: string;
  color: string | null;
  material: string | null;
  style_tags: string[];
  aliases: string[];
  price_pkr: number;
  status: ProductStatus;
  updated_at: string;
  product_images: { id: string; storage_path: string; sort_order: number; extraction_status: AdminProductImage["aiStatus"]; ai_attributes: unknown }[];
  product_variants: { id: string; size_label: string; normalized_size: string; stock_qty: number; variant_sku: string | null }[];
};

const productSelect =
  "id, sku, name, description, category, color, material, style_tags, aliases, price_pkr, status, updated_at, product_images(id, storage_path, sort_order, extraction_status, ai_attributes), product_variants(id, size_label, normalized_size, stock_qty, variant_sku)";

function sortImages(images: ProductRow["product_images"]): AdminProductImage[] {
  return [...images]
    .sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id))
    .map((image) => ({
      id: image.id,
      storagePath: image.storage_path,
      url: productImagePublicUrl(image.storage_path),
      sortOrder: image.sort_order,
      aiStatus: image.extraction_status,
      suggestion: image.extraction_status === "complete" ? readStoredSuggestion(image.ai_attributes) : null,
    }));
}

// PostgREST `or` filters are comma/paren delimited; strip those so user text can't alter the filter.
function searchTerm(query: string): string {
  return query.replace(/[,()*%\\]/g, " ").trim().slice(0, 80);
}

export async function listAdminProducts(filters: { query?: string; status?: ProductStatus }): Promise<AdminProductSummary[]> {
  const supabase = await createSupabaseServerClient();
  let request = supabase.from("products").select(productSelect).order("updated_at", { ascending: false }).limit(200);
  if (filters.status) request = request.eq("status", filters.status);
  const term = searchTerm(filters.query ?? "");
  if (term) request = request.or(`name.ilike.*${term}*,sku.ilike.*${term}*,category.ilike.*${term}*`);

  const { data, error } = await request.returns<ProductRow[]>();
  if (error) throw new Error(`Could not load products: ${error.message}`);

  return data.map((row) => ({
    id: row.id,
    sku: row.sku,
    name: row.name,
    category: row.category,
    pricePkr: row.price_pkr,
    status: row.status,
    updatedAt: row.updated_at,
    thumbnailUrl: sortImages(row.product_images)[0]?.url ?? null,
    sizeCount: row.product_variants.length,
    sizesInStock: row.product_variants.filter((variant) => variant.stock_qty > 0).length,
  }));
}

export async function getAdminProduct(productId: string): Promise<AdminProduct | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.from("products").select(productSelect).eq("id", productId).maybeSingle<ProductRow>();
  if (error) {
    if (error.code === "22P02") return null; // not a UUID
    throw new Error(`Could not load product: ${error.message}`);
  }
  if (!data) return null;

  return {
    id: data.id,
    sku: data.sku,
    name: data.name,
    description: data.description,
    category: data.category,
    color: data.color,
    material: data.material,
    styleTags: data.style_tags,
    aliases: data.aliases,
    pricePkr: data.price_pkr,
    status: data.status,
    updatedAt: data.updated_at,
    images: sortImages(data.product_images),
    variants: [...data.product_variants]
      .sort((a, b) => compareSizes(a.normalized_size, b.normalized_size))
      .map((variant) => ({
        id: variant.id,
        sizeLabel: variant.size_label,
        normalizedSize: variant.normalized_size,
        stockQty: variant.stock_qty,
        variantSku: variant.variant_sku,
      })),
  };
}

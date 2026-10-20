import type { SupabaseClient } from "@supabase/supabase-js";
import { embedText } from "../ai/gemini";
import { isMissingSchema } from "./repository";
import { embeddingSourceHash, productEmbeddingText } from "./semantic";

// Keeps products.embedding in step with what a product is called and looks like. Unchanged products (same
// text, same model) are skipped, so running it after every save or from the admin button is cheap.

export type IndexResult = {
  // False until the embeddings migration is applied.
  available: boolean;
  updated: number;
  unchanged: number;
  failed: number;
  // Active products not reached before the time budget ran out (press the button again).
  remaining: number;
};

type ProductRow = {
  id: string;
  name: string;
  category: string;
  color: string | null;
  material: string | null;
  style_tags: string[];
  aliases: string[];
  description: string;
  embedding_source_hash: string | null;
  product_images: { ai_description: string | null; sort_order: number }[];
};

export async function refreshProductEmbeddings(
  client: SupabaseClient,
  options: { apiKey: string | readonly string[]; model: string; productIds?: readonly string[]; budgetMs?: number; fetchImpl?: typeof fetch },
): Promise<IndexResult> {
  const result: IndexResult = { available: true, updated: 0, unchanged: 0, failed: 0, remaining: 0 };
  let query = client
    .from("products")
    .select("id, name, category, color, material, style_tags, aliases, description, embedding_source_hash, product_images(ai_description, sort_order)")
    .eq("status", "active")
    .limit(2_000);
  if (options.productIds) query = query.in("id", [...options.productIds]);
  const { data, error } = await query.returns<ProductRow[]>();
  if (error) {
    if (isMissingSchema(error)) return { ...result, available: false };
    throw error;
  }

  const stale = (data ?? []).flatMap((row) => {
    const text = productEmbeddingText({
      name: row.name,
      category: row.category,
      color: row.color,
      material: row.material,
      styleTags: row.style_tags ?? [],
      aliases: row.aliases ?? [],
      description: row.description,
      aiText: [...row.product_images].sort((a, b) => a.sort_order - b.sort_order).map((image) => image.ai_description ?? "").join(" ").trim(),
    });
    const hash = embeddingSourceHash(text, options.model);
    if (hash === row.embedding_source_hash) {
      result.unchanged += 1;
      return [];
    }
    return [{ row, text, hash }];
  });

  const deadline = Date.now() + (options.budgetMs ?? 50_000);
  // A few at a time: fast enough for a few hundred products, gentle on per-minute quotas.
  for (let index = 0; index < stale.length; index += 3) {
    if (Date.now() > deadline) {
      result.remaining = stale.length - index;
      break;
    }
    await Promise.all(
      stale.slice(index, index + 3).map(async ({ row, text, hash }) => {
        try {
          const vector = await embedText({ apiKey: options.apiKey, model: options.model, text, taskType: "RETRIEVAL_DOCUMENT", title: row.name, fetchImpl: options.fetchImpl });
          const { error: updateError } = await client
            .from("products")
            // pgvector reads its text form "[0.1,0.2,…]".
            .update({ embedding: JSON.stringify(vector), embedding_source_hash: hash })
            .eq("id", row.id);
          if (updateError) throw updateError;
          result.updated += 1;
        } catch (embedError) {
          result.failed += 1;
          console.error("Embedding a product failed", { productId: row.id, error: embedError instanceof Error ? embedError.message : embedError });
        }
      }),
    );
  }
  return result;
}

// How much of the active catalog meaning-search can see.
export async function searchIndexStatus(client: SupabaseClient): Promise<{ available: boolean; indexed: number; total: number }> {
  // A normal select first: count-only requests carry no error body, so a missing column would look like "0 indexed".
  const probe = await client.from("products").select("embedding_source_hash").limit(1);
  const total = await client.from("products").select("id", { count: "exact", head: true }).eq("status", "active");
  if (probe.error) return { available: !isMissingSchema(probe.error), indexed: 0, total: total.count ?? 0 };
  const indexed = await client.from("products").select("id", { count: "exact", head: true }).eq("status", "active").not("embedding_source_hash", "is", null);
  return { available: true, indexed: indexed.count ?? 0, total: total.count ?? 0 };
}

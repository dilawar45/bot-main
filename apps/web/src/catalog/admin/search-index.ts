import "server-only";
import { after } from "next/server";
import { getVisionEnvironment } from "@/config/env";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { refreshProductEmbeddings } from "../embeddings";
import { refreshProductImageEmbeddings } from "../image-embeddings";

// After an admin edit, refresh that product's meaning-search embedding and its photo embeddings once the response
// has been sent. A no-op without a Gemini key; each part waits for its migration (and skips what didn't change).
export function refreshSearchIndexLater(productId: string): void {
  const { geminiKeys, embeddingModel, imageEmbeddingModel } = getVisionEnvironment();
  if (!geminiKeys.length) return;
  after(async () => {
    const client = createSupabaseServiceClient();
    await Promise.all([
      refreshProductEmbeddings(client, { apiKey: geminiKeys, model: embeddingModel, productIds: [productId], budgetMs: 20_000 }).catch((error: unknown) =>
        console.error("Search index refresh failed", { productId, error }),
      ),
      refreshProductImageEmbeddings(client, { apiKey: geminiKeys, model: imageEmbeddingModel, productIds: [productId], budgetMs: 25_000 }).catch((error: unknown) =>
        console.error("Photo index refresh failed", { productId, error }),
      ),
    ]);
  });
}

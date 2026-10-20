import { createHash } from "node:crypto";
import type { CatalogItem, SearchFilters, SearchResult } from "./search";

// Meaning-based search: complements the keyword vocabulary for words it doesn't know ("frock", "maxi",
// "pishwas", misspellings, Urdu product words). Products and queries are embedded with Gemini; the database
// returns the closest active products (public.match_products).

// Calibrated on the eval catalog: gemini-embedding-001 put the right item first for "burqa", "chadar ya stole",
// "3 piece jora", "office formal shirt", "trouser" and "عبایا", while unrelated asks ("watches", "shoes",
// "mobile cover") scored ≤ 0.57 with no clear winner. gemini-embedding-2 ranked well but separated worse.
export const DEFAULT_EMBEDDING_MODEL = "gemini-embedding-001";
// Candidates the model may consider (it judges the fit); anything below isn't plausibly related.
export const MIN_SEMANTIC_SIMILARITY = 0.55;
// Without the model (rules fallback) only a clear winner is trusted.
const CONFIDENT_SIMILARITY = 0.6;
const CONFIDENT_MARGIN = 0.03;

export type SemanticHit = { id: string; similarity: number };

// Photo search: a customer's photo (often a screenshot of the shop's own post) against the shop's product photos,
// both embedded with gemini-embedding-2 (public.match_product_images). Measured on synthetic garment images, as
// there were no real catalog photos yet: screenshots of a post scored 0.69–0.77 against the product shown and
// ranked it first, but so did unrelated pictures (a landscape 0.71, a handbag 0.74); the same image saved again
// as a lower-quality JPEG scored only 0.85, while two different kurtas from one photo setup scored 0.93. So the
// similarity only picks candidates, and the reply model compares the photos before calling anything the same.
// Re-check these numbers once the shop has real photos.
export const DEFAULT_IMAGE_EMBEDDING_MODEL = "gemini-embedding-2";
// Text screenshots (chats, payment receipts) scored 0.55–0.57: not plausibly a product.
export const MIN_PHOTO_SIMILARITY = 0.6;
// The model compares at most this many, all close to the best one.
const PHOTO_CANDIDATES = 3;
const PHOTO_CANDIDATE_BAND = 0.06;
// Without the model (rules fallback) only a near-identical photo that clearly beats every other product counts.
// None of the test screenshots or re-saved photos reached it: conservative on purpose.
const CONFIDENT_PHOTO_SIMILARITY = 0.9;
const CONFIDENT_PHOTO_MARGIN = 0.05;

// One product per hit (its best-matching photo).
export type PhotoHit = SemanticHit & { imagePath: string | null };

function clearWinner<T extends SemanticHit>(hits: readonly T[], minSimilarity: number, margin: number): T | null {
  const [top, second] = [...hits].sort((a, b) => b.similarity - a.similarity);
  if (!top || top.similarity < minSimilarity) return null;
  return !second || top.similarity - second.similarity >= margin ? top : null;
}

// The top hit when it clearly stands out, for replies built without the model.
export function confidentHit(hits: readonly SemanticHit[]): SemanticHit | null {
  return clearWinner(hits, CONFIDENT_SIMILARITY, CONFIDENT_MARGIN);
}

// The product a customer's photo shows, when it's clear enough to offer without the model looking ("this one?").
export function confidentPhotoHit<T extends SemanticHit>(hits: readonly T[]): T | null {
  return clearWinner(hits, CONFIDENT_PHOTO_SIMILARITY, CONFIDENT_PHOTO_MARGIN);
}

// What the model is asked to compare with the customer's photo: the best few, close to the best one.
export function photoCandidates<T extends SemanticHit>(hits: readonly T[]): T[] {
  const sorted = hits.filter((hit) => hit.similarity >= MIN_PHOTO_SIMILARITY).sort((a, b) => b.similarity - a.similarity);
  const best = sorted[0]?.similarity ?? 0;
  return sorted.filter((hit) => hit.similarity >= best - PHOTO_CANDIDATE_BAND).slice(0, PHOTO_CANDIDATES);
}

// What a product is embedded as. Everything a customer might call it, never prices or stock.
export function productEmbeddingText(product: Pick<CatalogItem, "name" | "category" | "color" | "material" | "styleTags" | "aliases" | "description" | "aiText">): string {
  return [
    product.name,
    `Item: ${product.category}`,
    product.color ? `Colour: ${product.color}` : "",
    product.material ? `Fabric: ${product.material}` : "",
    product.styleTags.length ? `Style: ${product.styleTags.join(", ")}` : "",
    product.aliases.length ? `Also called: ${product.aliases.join(", ")}` : "",
    product.description,
    product.aiText ? `Photo: ${product.aiText}` : "",
  ]
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, 6_000);
}

// Stored next to the embedding: when neither the text nor the model changed, the product isn't embedded again.
export function embeddingSourceHash(text: string, model: string): string {
  return createHash("sha256").update(`${model}\n${text}`).digest("hex").slice(0, 40);
}

// The message to search by meaning, or null when the keyword search already understood it (or it isn't
// about products: greetings, phone numbers and addresses, long stories).
export function semanticQueryFor(text: string, filters: SearchFilters, search: SearchResult | null): string | null {
  const unknown = (filters.text ?? "").split(/\s+/).filter((word) => word.length >= 3);
  if (unknown.length === 0) return null;
  if (search && search.matches.length >= 2) return null;
  if (/\d{7,}/.test(text.replace(/[\s-]/g, ""))) return null;
  if (text.split(/\s+/).length > 30) return null;
  return text.trim().slice(0, 300);
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index]! * b[index]!;
    normA += a[index]! * a[index]!;
    normB += b[index]! * b[index]!;
  }
  return normA && normB ? dot / Math.sqrt(normA * normB) : 0;
}

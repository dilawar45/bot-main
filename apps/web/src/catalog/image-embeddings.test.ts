import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModelHealth } from "../ai/gemini";
import { createProductPhotoLoader, imageMimeType, photoEmbeddingHash, photoIndexStatus, photosToIndex, refreshProductImageEmbeddings } from "./image-embeddings";
import { confidentPhotoHit, MIN_PHOTO_SIMILARITY, photoCandidates, type PhotoHit } from "./semantic";

beforeEach(() => resetModelHealth());

type Image = { id: string; storage_path: string; sort_order: number; image_embedding_hash: string | null };

// Just enough of the Supabase client for the photo index: one products query, product_images updates, downloads.
function fakeClient(products: { id: string; product_images: Image[] }[], options: { error?: { code: string; message: string }; missing?: string[] } = {}) {
  const updates: { values: Record<string, unknown>; ids: unknown }[] = [];
  const downloads: string[] = [];
  const query = {
    select: () => query,
    eq: () => query,
    limit: () => query,
    in: () => query,
    returns: async () => (options.error ? { data: null, error: options.error } : { data: products, error: null }),
  };
  const client = {
    from: () => ({
      select: () => query,
      update: (values: Record<string, unknown>) => ({
        in: async (_column: string, ids: unknown) => (updates.push({ values, ids }), { error: null }),
        eq: async (_column: string, id: unknown) => (updates.push({ values, ids: id }), { error: null }),
      }),
    }),
    storage: {
      from: () => ({
        download: async (path: string) => {
          downloads.push(path);
          return options.missing?.includes(path) ? { data: null, error: new Error("Object not found") } : { data: new Blob([new Uint8Array([1, 2, 3])]), error: null };
        },
      }),
    },
  };
  return { client: client as unknown as SupabaseClient, updates, downloads };
}

const vector = Array.from({ length: 768 }, (_, index) => (index % 5) / 10);
const embedFetch = () => vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ embedding: { values: vector } }), { status: 200 }));
const image = (id: string, order: number, hash: string | null = null): Image => ({ id, storage_path: `products/p1/${id}.jpg`, sort_order: order, image_embedding_hash: hash });

describe("photo index", () => {
  it("embeds the first three photos of each live product, skipping ones done with this model", async () => {
    const done = image("front", 0, photoEmbeddingHash("products/p1/front.jpg", "embed-2"));
    const { client, updates, downloads } = fakeClient([
      { id: "p1", product_images: [image("fourth", 3), image("side", 2, "made-by-an-older-model"), done, image("back", 1)] },
    ]);
    const fetchImpl = embedFetch();
    const result = await refreshProductImageEmbeddings(client, { apiKey: "k".repeat(30), model: "embed-2", fetchImpl });
    expect(result).toEqual({ available: true, updated: 2, unchanged: 1, failed: 0, remaining: 0 });
    expect(downloads.sort()).toEqual(["products/p1/back.jpg", "products/p1/side.jpg"]);
    // The older model's vector is dropped first: it isn't comparable with today's queries.
    expect(updates[0]).toEqual({ values: { image_embedding: null, image_embedding_hash: null }, ids: ["side"] });
    const saved = updates.slice(1).find((update) => update.ids === "back");
    expect(saved?.values).toEqual({ image_embedding: JSON.stringify(vector), image_embedding_hash: photoEmbeddingHash("products/p1/back.jpg", "embed-2") });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body)).content.parts[0].inline_data.mime_type).toBe("image/jpeg");
  });

  it("counts a photo that can't be read and carries on", async () => {
    const { client } = fakeClient([{ id: "p1", product_images: [image("front", 0), image("back", 1)] }], { missing: ["products/p1/front.jpg"] });
    const result = await refreshProductImageEmbeddings(client, { apiKey: "k".repeat(30), model: "embed-2", fetchImpl: embedFetch() });
    expect(result).toMatchObject({ updated: 1, failed: 1 });
  });

  it("says it's unavailable until the migration is applied", async () => {
    const error = { code: "42703", message: "column product_images_1.image_embedding_hash does not exist" };
    const { client } = fakeClient([], { error });
    await expect(refreshProductImageEmbeddings(client, { apiKey: "k".repeat(30), model: "embed-2" })).resolves.toMatchObject({ available: false });
    await expect(photoIndexStatus(client, "embed-2")).resolves.toEqual({ available: false, indexed: 0, total: 0 });
  });

  it("counts indexed photos against the current model", async () => {
    const hash = photoEmbeddingHash("products/p1/front.jpg", "embed-2");
    const { client } = fakeClient([
      { id: "p1", product_images: [image("front", 0, hash), image("back", 1, "older-model"), image("a", 2), image("b", 3, "x")] },
      { id: "p2", product_images: [] },
    ]);
    await expect(photoIndexStatus(client, "embed-2")).resolves.toEqual({ available: true, indexed: 1, total: 3 });
  });

  it("picks photos in the shop's order and knows their types", () => {
    expect(photosToIndex([image("c", 2), image("a", 0), image("d", 5), image("b", 1)]).map((photo) => photo.id)).toEqual(["a", "b", "c"]);
    expect(imageMimeType("products/x/1.webp")).toBe("image/webp");
    expect(imageMimeType("products/x/1.PNG")).toBe("image/png");
    expect(imageMimeType("products/x/1.gif")).toBeNull();
  });
});

describe("shop photos for the reply model", () => {
  const publicUrl = (path: string) => `https://project.supabase.co/storage/v1/object/public/product-images/${path}`;

  it("reads a small photo from its public URL", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-length": "3" } }));
    const load = createProductPhotoLoader(publicUrl, { fetchImpl });
    await expect(load("products/p1/front.png")).resolves.toEqual({ base64: "AQID", mimeType: "image/png" });
    expect(String(fetchImpl.mock.calls[0]![0])).toBe(publicUrl("products/p1/front.png"));
  });

  it("skips big originals, failed downloads and unknown file types", async () => {
    const big = createProductPhotoLoader(publicUrl, {
      maxBytes: 2,
      fetchImpl: vi.fn<typeof fetch>(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-length": "3" } })),
    });
    await expect(big("products/p1/front.jpg")).resolves.toBeNull();
    const missing = createProductPhotoLoader(publicUrl, { fetchImpl: vi.fn<typeof fetch>(async () => new Response("", { status: 404 })) });
    await expect(missing("products/p1/front.jpg")).resolves.toBeNull();
    const down = createProductPhotoLoader(publicUrl, { fetchImpl: vi.fn<typeof fetch>(async () => Promise.reject(new TypeError("fetch failed"))) });
    await expect(down("products/p1/front.jpg")).resolves.toBeNull();
    await expect(createProductPhotoLoader(publicUrl)("products/p1/front.gif")).resolves.toBeNull();
  });
});

describe("photo matching", () => {
  const hit = (id: string, similarity: number): PhotoHit => ({ id, similarity, imagePath: null });

  it("asks the model to compare only the best few, close to the best one", () => {
    expect(photoCandidates([hit("b", 0.7), hit("a", 0.74), hit("c", 0.69), hit("d", 0.6)]).map((candidate) => candidate.id)).toEqual(["a", "b", "c"]);
    expect(photoCandidates([hit("a", 0.95), hit("b", 0.8)]).map((candidate) => candidate.id)).toEqual(["a"]);
    expect(photoCandidates([hit("a", MIN_PHOTO_SIMILARITY - 0.01)])).toEqual([]);
  });

  it("trusts a photo match without the model only when it's near-identical and clearly ahead", () => {
    expect(confidentPhotoHit([hit("a", 0.96), hit("b", 0.88)])?.id).toBe("a");
    expect(confidentPhotoHit([hit("a", 0.93)])?.id).toBe("a");
    // A screenshot-like score, or two products almost as close: ask the model instead.
    expect(confidentPhotoHit([hit("a", 0.78)])).toBeNull();
    expect(confidentPhotoHit([hit("a", 0.95), hit("b", 0.92)])).toBeNull();
  });
});

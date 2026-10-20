const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export type FetchedImage = {
  mimeType: string;
  dataBase64: string;
  fileName?: string;
};

export type FetchImageOptions = {
  timeoutMs?: number;
  maxBytes?: number;
  fetchImplementation?: typeof fetch;
};

// Downloads a catalog photo to forward on WhatsApp. Type and size are enforced while reading, so a wrong or
// hostile URL can neither send something that isn't a photo nor pull an unbounded body into memory.
export async function fetchImage(url: string, options: FetchImageOptions = {}): Promise<FetchedImage> {
  // Same 10 MB as the product-images bucket, so every photo the admin can upload can also be sent.
  const { timeoutMs = 10_000, maxBytes = 10 * 1024 * 1024, fetchImplementation = fetch } = options;
  // No redirects: the URL was checked, a redirect target was not.
  const response = await fetchImplementation(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
  if (!response.ok) throw new Error(`Image download failed with status ${response.status}`);

  const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!ALLOWED_IMAGE_TYPES.has(mimeType)) throw new Error(`Image download has unsupported type "${mimeType}"`);
  if (Number(response.headers.get("content-length")) > maxBytes) throw new Error(`Image is larger than ${maxBytes} bytes`);

  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  for (;;) {
    const chunk = await reader?.read();
    if (!chunk || chunk.done) break;
    size += chunk.value.byteLength;
    if (size > maxBytes) {
      await reader?.cancel().catch(() => undefined);
      throw new Error(`Image is larger than ${maxBytes} bytes`);
    }
    chunks.push(chunk.value);
  }
  if (!size) throw new Error("Image download was empty");

  const fileName = new URL(url).pathname.split("/").pop() || undefined;
  return { mimeType, dataBase64: Buffer.concat(chunks).toString("base64"), fileName };
}

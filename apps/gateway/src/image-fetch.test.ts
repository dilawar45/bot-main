import { describe, expect, it } from "vitest";
import { fetchImage } from "./image-fetch.js";

const url = "https://project.supabase.co/storage/v1/object/public/product-images/kurta-green.jpg";
const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const serve = (response: Response) => async () => response;

describe("fetchImage", () => {
  it("returns the photo as base64 with its type and file name", async () => {
    const image = await fetchImage(url, {
      fetchImplementation: serve(new Response(bytes, { headers: { "content-type": "image/jpeg; charset=binary" } })),
    });
    expect(image).toEqual({ mimeType: "image/jpeg", dataBase64: Buffer.from(bytes).toString("base64"), fileName: "kurta-green.jpg" });
  });

  it("rejects failed downloads and anything that is not a JPEG, PNG or WebP photo", async () => {
    await expect(fetchImage(url, { fetchImplementation: serve(new Response("missing", { status: 404 })) })).rejects.toThrow("404");
    await expect(
      fetchImage(url, { fetchImplementation: serve(new Response("<html>", { headers: { "content-type": "text/html" } })) }),
    ).rejects.toThrow("unsupported type");
    await expect(
      fetchImage(url, { fetchImplementation: serve(new Response(bytes, { headers: { "content-type": "image/gif" } })) }),
    ).rejects.toThrow("unsupported type");
  });

  it("stops reading once the photo exceeds the size limit", async () => {
    const declared = new Response(bytes, { headers: { "content-type": "image/png", "content-length": "8" } });
    await expect(fetchImage(url, { maxBytes: 4, fetchImplementation: serve(declared) })).rejects.toThrow("larger than 4 bytes");

    // Without a content-length the limit is enforced while streaming.
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(3));
      },
    });
    const undeclared = new Response(stream, { headers: { "content-type": "image/webp" } });
    await expect(fetchImage(url, { maxBytes: 10, fetchImplementation: serve(undeclared) })).rejects.toThrow("larger than 10 bytes");
  });

  it("allows photos up to the catalog bucket's 10 MB and refuses redirects", async () => {
    let init: RequestInit | undefined;
    const sixMegabytes = new Uint8Array(6 * 1024 * 1024);
    const image = await fetchImage(url, {
      fetchImplementation: async (_input, requestInit) => {
        init = requestInit;
        return new Response(sixMegabytes, { headers: { "content-type": "image/jpeg" } });
      },
    });
    expect(Buffer.from(image.dataBase64, "base64").byteLength).toBe(sixMegabytes.byteLength);
    expect(init?.redirect).toBe("error");

    const huge = new Response(bytes, { headers: { "content-type": "image/png", "content-length": String(11 * 1024 * 1024) } });
    await expect(fetchImage(url, { fetchImplementation: serve(huge) })).rejects.toThrow("larger than");
  });

  it("rejects an empty body", async () => {
    const empty = new Response(new Uint8Array(0), { headers: { "content-type": "image/png" } });
    await expect(fetchImage(url, { fetchImplementation: serve(empty) })).rejects.toThrow("empty");
  });
});

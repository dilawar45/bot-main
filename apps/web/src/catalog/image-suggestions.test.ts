import { describe, expect, it, vi } from "vitest";
import { GeminiError } from "../ai/gemini";
import { fillEmptyFields, suggestFromProductImage, type ImageSuggestion } from "./image-suggestions";

function geminiResponse(payload: unknown, init: { status?: number; finishReason?: string } = {}) {
  return new Response(
    JSON.stringify(
      init.status && init.status >= 400
        ? { error: { message: "quota exceeded" } }
        : {
            candidates: [{ content: { parts: [{ text: typeof payload === "string" ? payload : JSON.stringify(payload) }] }, finishReason: init.finishReason ?? "STOP" }],
            usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 80 },
          },
    ),
    { status: init.status ?? 200, headers: { "content-type": "application/json" } },
  );
}

const rawSuggestion = {
  is_product: true,
  name: " Sky Blue  Printed Lawn Suit ",
  category: " Lawn Suit ",
  color: "Sky  Blue",
  material: "lawn",
  style_tags: ["Printed", "printed", "summer", "  casual wear "],
  description: "Three piece printed lawn suit with embroidered neckline.",
  confidence: 0.82,
};

describe("suggestFromProductImage", () => {
  it("sends the image inline with structured output and normalizes the reply", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(geminiResponse(rawSuggestion));
    const result = await suggestFromProductImage({ apiKey: "k".repeat(30), model: "gemini-test", imageBase64: "AAAA", mimeType: "image/png", fetchImpl });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent");
    expect((init?.headers as Record<string, string>)["x-goog-api-key"]).toBe("k".repeat(30));
    const body = JSON.parse(String(init?.body));
    expect(body.contents[0].parts[0]).toEqual({ inline_data: { mime_type: "image/png", data: "AAAA" } });
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.responseJsonSchema.required).toContain("is_product");

    expect(result.suggestion).toEqual({
      isProduct: true,
      name: "Sky Blue Printed Lawn Suit",
      category: "lawn suit",
      color: "Sky Blue",
      material: "lawn",
      styleTags: ["printed", "summer", "casual wear"],
      description: "Three piece printed lawn suit with embroidered neckline.",
      confidence: 0.82,
    });
    expect(result.inputTokens).toBe(1200);
  });

  it("raises typed errors for HTTP failures and malformed output", async () => {
    const httpFail = vi.fn<typeof fetch>().mockResolvedValue(geminiResponse(null, { status: 429 }));
    await expect(suggestFromProductImage({ apiKey: "k".repeat(30), model: "m", imageBase64: "AA", mimeType: "image/png", fetchImpl: httpFail })).rejects.toMatchObject({ kind: "http", status: 429 });

    const badJson = vi.fn<typeof fetch>().mockResolvedValue(geminiResponse("{not json"));
    await expect(suggestFromProductImage({ apiKey: "k".repeat(30), model: "m", imageBase64: "AA", mimeType: "image/png", fetchImpl: badJson })).rejects.toBeInstanceOf(GeminiError);

    const wrongShape = vi.fn<typeof fetch>().mockResolvedValue(geminiResponse({ is_product: "yes" }));
    await expect(suggestFromProductImage({ apiKey: "k".repeat(30), model: "m", imageBase64: "AA", mimeType: "image/png", fetchImpl: wrongShape })).rejects.toThrow();
  });
});

describe("fillEmptyFields", () => {
  const suggestion: ImageSuggestion = {
    isProduct: true,
    name: "Sky Blue Lawn Suit",
    category: "lawn suit",
    color: "sky blue",
    material: "lawn",
    styleTags: ["printed", "summer"],
    description: "Printed lawn suit.",
    confidence: 0.8,
  };

  it("fills only empty fields and adds tags", () => {
    expect(fillEmptyFields({ color: null, material: "Cotton", description: "", styleTags: ["printed"] }, suggestion)).toEqual({
      color: "sky blue",
      description: "Printed lawn suit.",
      styleTags: ["printed", "summer"],
    });
  });

  it("changes nothing when every field is set or the image is not a product", () => {
    expect(fillEmptyFields({ color: "Red", material: "Silk", description: "Owner text", styleTags: ["printed", "summer"] }, suggestion)).toEqual({});
    expect(fillEmptyFields({ color: null, material: null, description: "", styleTags: [] }, { ...suggestion, isProduct: false })).toEqual({});
  });
});

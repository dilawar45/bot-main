import { describe, expect, it } from "vitest";
import {
  compareSizes,
  getPublishBlockers,
  isProductImagePathFor,
  normalizeSize,
  parseProductForm,
  parseVariantRows,
} from "./validation";

function form(entries: [string, string][]): FormData {
  const data = new FormData();
  for (const [key, value] of entries) data.append(key, value);
  return data;
}

const validProduct: [string, string][] = [
  ["sku", " lawn-001 "],
  ["name", "Lawn Suit"],
  ["description", ""],
  ["category", "Suits"],
  ["color", " "],
  ["material", "Lawn"],
  ["styleTags", "Printed, casual, printed,  summer  wear"],
  ["aliases", ""],
  ["pricePkr", "4,500"],
];

describe("parseProductForm", () => {
  it("normalizes SKU, category, tags and price", () => {
    const result = parseProductForm(form(validProduct));
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      sku: "LAWN-001",
      category: "suits",
      color: null,
      material: "Lawn",
      styleTags: ["printed", "casual", "summer wear"],
      aliases: [],
      pricePkr: 4500,
    });
  });

  it("rejects decimal prices and bad SKUs", () => {
    const decimal = parseProductForm(form(validProduct.map(([k, v]) => [k, k === "pricePkr" ? "4500.50" : v])));
    expect(decimal.success).toBe(false);
    const sku = parseProductForm(form(validProduct.map(([k, v]) => [k, k === "sku" ? "bad sku!" : v])));
    expect(sku.success).toBe(false);
  });
});

describe("normalizeSize", () => {
  it("maps common spellings to one key", () => {
    expect(normalizeSize(" xl ")).toBe("XL");
    expect(normalizeSize("X-Large")).toBe("XL");
    expect(normalizeSize("Extra Large")).toBe("XL");
    expect(normalizeSize("medium")).toBe("M");
    expect(normalizeSize("Free Size")).toBe("FREE");
    expect(normalizeSize("32 W")).toBe("32W");
  });
});

describe("compareSizes", () => {
  it("orders letter sizes by garment order, then numbers numerically", () => {
    expect(["XL", "M", "FREE", "S", "L"].sort(compareSizes)).toEqual(["S", "M", "L", "XL", "FREE"]);
    expect(["40", "8", "32"].sort(compareSizes)).toEqual(["8", "32", "40"]);
  });
});

describe("parseVariantRows", () => {
  it("skips blank rows and normalizes sizes", () => {
    const result = parseVariantRows(
      form([
        ["sizeLabel", "Medium"], ["stockQty", "3"], ["variantSku", "lawn-001-m"],
        ["sizeLabel", ""], ["stockQty", ""], ["variantSku", ""],
        ["sizeLabel", "L"], ["stockQty", "0"], ["variantSku", ""],
      ]),
    );
    expect(result).toEqual({
      ok: true,
      variants: [
        { sizeLabel: "Medium", normalizedSize: "M", stockQty: 3, variantSku: "LAWN-001-M", stockLoaded: null },
        { sizeLabel: "L", normalizedSize: "L", stockQty: 0, variantSku: null, stockLoaded: null },
      ],
    });
  });

  it("remembers the stock each size had when the form was opened, unless the size was renamed", () => {
    const result = parseVariantRows(
      form([
        ["sizeLabel", "M"], ["stockQty", "6"], ["variantSku", ""], ["loadedSize", "Medium"], ["loadedStock", "5"],
        ["sizeLabel", "XL"], ["stockQty", "2"], ["variantSku", ""], ["loadedSize", "L"], ["loadedStock", "4"],
        ["sizeLabel", "S"], ["stockQty", "1"], ["variantSku", ""], ["loadedSize", ""], ["loadedStock", ""],
      ]),
    );
    expect(result.ok && result.variants.map((variant) => [variant.normalizedSize, variant.stockLoaded])).toEqual([
      ["M", 5],
      ["XL", null],
      ["S", null],
    ]);
  });

  it("rejects duplicate sizes and negative stock", () => {
    const duplicate = parseVariantRows(form([["sizeLabel", "M"], ["stockQty", "1"], ["variantSku", ""], ["sizeLabel", "medium"], ["stockQty", "2"], ["variantSku", ""]]));
    expect(duplicate).toEqual({ ok: false, error: "Size M is listed twice." });
    const negative = parseVariantRows(form([["sizeLabel", "M"], ["stockQty", "-1"], ["variantSku", ""]]));
    expect(negative.ok).toBe(false);
  });
});

describe("getPublishBlockers", () => {
  it("lists every missing requirement", () => {
    expect(getPublishBlockers({ sku: "A", name: "B", category: "c", pricePkr: 0, imageCount: 0, variantCount: 0 })).toEqual([
      "Set a price above 0.",
      "Upload at least one image.",
      "Add at least one size.",
    ]);
    expect(getPublishBlockers({ sku: "A", name: "B", category: "c", pricePkr: 10, imageCount: 1, variantCount: 1 })).toEqual([]);
  });
});

describe("isProductImagePathFor", () => {
  const productId = "0b6f1c1e-2c8e-4a53-9a39-0f5d3f0e9a11";
  it("accepts only this product's generated paths", () => {
    expect(isProductImagePathFor(productId, `products/${productId}/5a2b4c1d-0000-4000-8000-000000000000.jpg`)).toBe(true);
    expect(isProductImagePathFor(productId, `products/other/5a2b4c1d-0000-4000-8000-000000000000.jpg`)).toBe(false);
    expect(isProductImagePathFor(productId, `products/${productId}/../x.jpg`)).toBe(false);
    expect(isProductImagePathFor("not-a-uuid", "products/not-a-uuid/x.jpg")).toBe(false);
  });
});

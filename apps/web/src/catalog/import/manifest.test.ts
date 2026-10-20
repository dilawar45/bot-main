import { describe, expect, it } from "vitest";
import { isProductImagePathFor } from "../admin/validation";
import { contentAddressedImageName, parseCsv, parseManifest } from "./manifest";

describe("parseCsv", () => {
  it("handles quotes, escaped quotes, embedded commas/newlines, CRLF and BOM", () => {
    const text = '﻿a,b,c\r\n"x, y","say ""hi""","line1\nline2"\r\n\r\nlast,,\n';
    expect(parseCsv(text)).toEqual([
      ["a", "b", "c"],
      ["x, y", 'say "hi"', "line1\nline2"],
      ["last", "", ""],
    ]);
  });

  it("rejects an unclosed quote", () => {
    expect(() => parseCsv('a,"b\n')).toThrow("unclosed quote");
  });
});

const header = "sku,name,category,price_pkr,description,color,material,style_tags,aliases,sizes,images";

describe("parseManifest", () => {
  it("parses a valid row with sizes, tags and images", () => {
    const { rows } = parseManifest(
      `${header}\nlawn-01,Printed Lawn Suit,Lawn Suit,"4,500",,Blue,Lawn,printed|summer,3 piece,S:2|M:0|L:5:LAWN-01-L,images/a.jpg|images/b.PNG\n`,
    );
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.ok).toBe(true);
    if (!row.ok) return;
    expect(row.row.line).toBe(2);
    expect(row.row.product).toMatchObject({ sku: "LAWN-01", category: "lawn suit", pricePkr: 4500, styleTags: ["printed", "summer"], aliases: ["3 piece"] });
    expect(row.row.variants.map((variant) => [variant.normalizedSize, variant.stockQty, variant.variantSku])).toEqual([
      ["S", 2, null],
      ["M", 0, null],
      ["L", 5, "LAWN-01-L"],
    ]);
    expect(row.row.images).toEqual([
      { path: "images/a.jpg", mimeType: "image/jpeg" },
      { path: "images/b.PNG", mimeType: "image/png" },
    ]);
  });

  it("reports row-level errors with line numbers without stopping other rows", () => {
    const { rows } = parseManifest(
      [
        header,
        "A1,Good,cat,100,,,,,,M:1,",
        "A2,Bad price,cat,12.5,,,,,,,",
        "a1,Duplicate,cat,100,,,,,,,",
        "A3,Bad size,cat,100,,,,,,M:-1,",
        "A4,Bad image,cat,100,,,,,,,photo.gif",
      ].join("\n"),
    );
    expect(rows.map((row) => (row.ok ? "ok" : `${row.line}: ${row.error}`))).toEqual([
      "ok",
      "3: Price must be a whole number of rupees.",
      "4: SKU repeats line 2.",
      "5: sizes: Row 1: Stock must be a whole number, 0 or more.",
      "6: images: photo.gif is not a JPEG, PNG or WebP file.",
    ]);
  });

  it("rejects missing required or unknown columns", () => {
    expect(() => parseManifest("sku,name\nA,B")).toThrow("missing columns: category, price_pkr");
    expect(() => parseManifest("sku,name,category,price_pkr,stock\nA,B,c,1,5")).toThrow("Unknown manifest columns: stock");
  });
});

describe("contentAddressedImageName", () => {
  it("is deterministic and passes the admin path check", () => {
    const productId = "0b6f1c1e-2c8e-4a53-9a39-0f5d3f0e9a11";
    const hash = "ab".repeat(32);
    const name = contentAddressedImageName(productId, hash, "image/webp");
    expect(name).toBe(`products/${productId}/abababab-abab-abab-abab-abababababab.webp`);
    expect(contentAddressedImageName(productId, hash, "image/webp")).toBe(name);
    expect(isProductImagePathFor(productId, name)).toBe(true);
  });
});

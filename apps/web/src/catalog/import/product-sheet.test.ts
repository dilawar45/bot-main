import { describe, expect, it } from "vitest";
import { cleanPrice, fillFromSuggestion, matchPhotos, normalizeCode, parseProductLines, parseProductSheet, parseSizes } from "./product-sheet";

describe("parseProductSheet", () => {
  it("reads a sheet the owner filled in himself: forgiving column names, only code, price and sizes needed", () => {
    const { rows, ignoredColumns } = parseProductSheet(
      ["Sr#,Code,Price (Rs),Sizes & Stock,Colour,Fabric,Notes", '1,K12,"Rs 3,500/-",S2 M3 L1,Maroon,Lawn,3 piece with dupatta', "2,k 13,2200,Free 5,,,"].join("\n"),
    );
    expect(ignoredColumns).toEqual(["Sr#"]);
    expect(rows.map((row) => row.ok)).toEqual([true, true]);
    const [first, second] = rows.map((row) => (row.ok ? row.row : null));
    expect(first).toMatchObject({
      line: 2,
      sku: "K12",
      fields: { name: "", category: "", color: "Maroon", material: "Lawn", description: "3 piece with dupatta", pricePkr: "3500" },
      images: [],
    });
    expect(first!.variants.map((variant) => [variant.sizeLabel, variant.normalizedSize, variant.stockQty])).toEqual([
      ["S", "S", 2],
      ["M", "M", 3],
      ["L", "L", 1],
    ]);
    expect(second).toMatchObject({ sku: "K-13", fields: { pricePkr: "2200" } });
    expect(second!.variants.map((variant) => [variant.sizeLabel, variant.normalizedSize, variant.stockQty])).toEqual([["Free size", "FREE", 5]]);
  });

  it("still reads the full manifest format", () => {
    const { rows, ignoredColumns } = parseProductSheet(
      'sku,name,category,price_pkr,description,color,material,style_tags,aliases,sizes,images\nlawn-01,Printed Lawn Suit,Lawn Suit,"4,500",,Blue,Lawn,printed|summer,3 piece,S:2|M:0|L:5:LAWN-01-L,images/a.jpg|images/b.PNG\n',
    );
    expect(ignoredColumns).toEqual([]);
    const row = rows[0]!;
    if (!row.ok) throw new Error(row.error);
    expect(row.row).toMatchObject({ sku: "LAWN-01", fields: { name: "Printed Lawn Suit", category: "Lawn Suit", styleTags: "printed,summer", aliases: "3 piece", pricePkr: "4500" } });
    expect(row.row.variants.map((variant) => [variant.normalizedSize, variant.stockQty, variant.variantSku])).toEqual([
      ["S", 2, null],
      ["M", 0, null],
      ["L", 5, "LAWN-01-L"],
    ]);
    expect(row.row.images.map((image) => image.mimeType)).toEqual(["image/jpeg", "image/png"]);
  });

  it("explains each bad row by line, without stopping the others", () => {
    const { rows } = parseProductSheet(["code,price,sizes", "A1,100,M1", "A2,12.5,M1", "a1,100,M1", "A3,100,S M L", "A 4!,100,", "A5,,M1"].join("\n"));
    expect(rows.map((row) => (row.ok ? "ok" : `${row.line}: ${row.error}`))).toEqual([
      "ok",
      '3: price "12.5" isn\'t a whole number of rupees',
      "4: code repeats line 2",
      '5: sizes: write each size with how many you have, e.g. "S2 M3 L1" or "Free 5" (got "S M L")',
      '6: code "A 4!" may only use letters, numbers, dash, dot and underscore',
      '7: price "" isn\'t a whole number of rupees',
    ]);
  });

  it("needs at least a code and a price column", () => {
    expect(() => parseProductSheet("name,sizes\nKurta,M1")).toThrow("The sheet needs a code and a price column.");
    expect(() => parseProductSheet("code,sizes\nK1,M1")).toThrow("The sheet needs a price column.");
  });
});

describe("sheet cells", () => {
  it("reads sizes the way people write them", () => {
    const read = (text: string) => {
      const result = parseSizes(text);
      return result.ok ? result.sizes.map((size) => `${size.size}=${size.stock}`).join(" ") : `error`;
    };
    expect(read("S2 M3 L1")).toBe("S=2 M=3 L=1");
    expect(read("S-2, M-3, XL-1")).toBe("S=2 M=3 XL=1");
    expect(read("Small 2 / Medium 10")).toBe("Small=2 Medium=10");
    expect(read("free size 5")).toBe("Free size=5");
    expect(read("32-2 34:1 36 3")).toBe("32=2 34=1 36=3");
    expect(read("")).toBe("");
    expect(read("S M L")).toBe("error");
    expect(read("M2 and a few L")).toBe("error");
  });

  it("cleans codes and prices", () => {
    expect(normalizeCode("#a7")).toBe("A7");
    expect(normalizeCode("K 12")).toBe("K-12");
    expect(normalizeCode("K/12")).toBeNull();
    expect(cleanPrice("Rs. 3,500/-")).toBe("3500");
    expect(cleanPrice("4500.00")).toBe("4500");
    expect(cleanPrice("0")).toBeNull();
    expect(cleanPrice("free")).toBeNull();
  });
});

describe("parseProductLines", () => {
  it("reads products from a pasted WhatsApp chat, skipping everything else", () => {
    const chat = [
      "[2:15 PM, 06/10/2026] Huzaifa: Assalam o alaikum, naye products 👇",
      "[2:16 PM, 06/10/2026] Huzaifa: K12 | Rs 3,500 | S2 M3 L1 | lawn | 3 piece with dupatta",
      "06/10/2026, 2:17 pm - Huzaifa: K13 | 2200 | Free 5",
      "K14 | 1800 | M2",
      "<Media omitted>",
      "K15 | price? | M2",
    ].join("\n");
    const { rows } = parseProductLines(chat);
    expect(rows.map((row) => (row.ok ? `${row.row.sku} ${row.row.fields.pricePkr} ${row.row.variants.length} "${row.row.fields.description}"` : `${row.line}: ${row.error}`))).toEqual([
      'K12 3500 3 "lawn, 3 piece with dupatta"',
      'K13 2200 1 ""',
      'K14 1800 1 ""',
      '6: price "price?" isn\'t a whole number of rupees',
    ]);
  });
});

describe("fillFromSuggestion", () => {
  const fields = { name: "", category: "", description: "", color: "Maroon", material: "", styleTags: "", aliases: "", pricePkr: "3500" };
  const suggestion = { isProduct: true, name: "Red Embroidered Kurta", category: "kurta", color: "red", material: "lawn", description: "Embroidered lawn kurta.", styleTags: ["embroidered", "casual"] };

  it("fills only what the sheet left empty", () => {
    expect(fillFromSuggestion(fields, suggestion)).toEqual({
      fields: { ...fields, name: "Red Embroidered Kurta", category: "kurta", material: "lawn", description: "Embroidered lawn kurta.", styleTags: "embroidered,casual" },
      filled: ["name", "category", "fabric", "description", "tags"],
    });
  });

  it("fills nothing from a photo that isn't a product", () => {
    expect(fillFromSuggestion(fields, { ...suggestion, isProduct: false })).toEqual({ fields, filled: [] });
  });
});

describe("matchPhotos", () => {
  const files = ["K12-1.jpg", "K12-10.jpg", "K12-2.jpeg", "k12 (3).PNG", "K120-1.jpg", "K12.heic", "K13/front.jpg", "K13/back.webp", "photos/K12_back.webp", "notes.txt"];

  it("finds a code's photos by file name or folder, main photo first, never a longer code's", () => {
    expect(matchPhotos("K12", files)).toEqual(["K12-1.jpg", "K12-2.jpeg", "k12 (3).PNG", "K12-10.jpg", "photos/K12_back.webp"]);
    expect(matchPhotos("K13", files)).toEqual(["K13/back.webp", "K13/front.jpg"]);
    expect(matchPhotos("K14", files)).toEqual([]);
  });
});

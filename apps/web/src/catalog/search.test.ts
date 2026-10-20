import { describe, expect, it } from "vitest";
import { browseCatalog, extractFilters, hasProductIntent, searchCatalog, type CatalogItem } from "./search";

let counter = 0;
function item(partial: Partial<CatalogItem> & Pick<CatalogItem, "name" | "category">): CatalogItem {
  counter += 1;
  return {
    id: `p${counter}`,
    sku: `SKU-${counter}`,
    description: "",
    color: null,
    material: null,
    styleTags: [],
    aliases: [],
    pricePkr: 3000,
    createdAt: `2026-09-${String(counter).padStart(2, "0")}T00:00:00Z`,
    variants: [{ size: "M", normalizedSize: "M", stockQty: 2 }],
    imagePaths: [],
    aiText: "",
    ...partial,
  };
}

const blueShirt = item({ name: "Classic Oxford Shirt", category: "shirt", color: "blue", pricePkr: 2800 });
const redKurta = item({ name: "Ruby Kurta", category: "kurta", color: "red", pricePkr: 3200, variants: [{ size: "S", normalizedSize: "S", stockQty: 1 }, { size: "M", normalizedSize: "M", stockQty: 0 }] });
const greenKurta = item({ name: "Emerald Lawn Kurta", category: "kurta", color: "green", material: "lawn", pricePkr: 4500, aliases: ["lawn kurta"] });
const maroonKameez = item({ name: "Maroon Kameez", category: "kameez", color: "maroon", pricePkr: 2450 });
const blackAbaya = item({ name: "Nida Abaya", category: "abaya", color: "black", variants: [{ size: "L", normalizedSize: "L", stockQty: 0 }] });
const catalog = [blueShirt, redKurta, greenKurta, maroonKameez, blackAbaya];

describe("extractFilters", () => {
  it("reads colour, garment, size and budget from Roman Urdu", () => {
    expect(extractFilters("Yr apke paas red shirt available ha?")).toEqual({ color: "red", category: "shirt" });
    expect(extractFilters("laal kameez medium mein 3000 tak")).toEqual({ color: "red", category: "shirt", size: "M", maxPrice: 3000 });
    expect(extractFilters("koi kala kurta hai?")).toEqual({ color: "black", category: "kurta" });
  });

  it("reads Urdu script", () => {
    expect(extractFilters("سرخ قمیض چاہیے")).toMatchObject({ color: "red", category: "shirt" });
  });

  it("does not mistake contractions or greetings for product words", () => {
    expect(extractFilters("I'm looking for something")).not.toHaveProperty("size");
    expect(hasProductIntent(extractFilters("Hii brother"))).toBe(false);
    expect(hasProductIntent(extractFilters("Salam bhai kaise ho"))).toBe(false);
    expect(hasProductIntent(extractFilters("Aap kon ho muje call pe baat krni ha"))).toBe(false);
  });

  it("keeps fabric words as free text", () => {
    expect(extractFilters("lawn wala dikhao")).toEqual({ text: "lawn" });
  });
});

describe("searchCatalog", () => {
  it("never passes a wrong colour off as a match (red shirt vs blue shirt)", () => {
    const result = searchCatalog(catalog, { color: "red", category: "shirt" });
    expect(result.matches).toEqual([]);
    // Closest first: right colour in a related garment, and the right garment in a near colour.
    expect(result.alternatives.slice(0, 2).map((hit) => hit.product.id).sort()).toEqual([redKurta.id, maroonKameez.id].sort());
  });

  it("finds an exact match when there is one", () => {
    expect(searchCatalog(catalog, { color: "blue", category: "shirt" }).matches.map((hit) => hit.product.id)).toEqual([blueShirt.id]);
    // "kameez" is the same garment as "shirt".
    expect(searchCatalog(catalog, { color: "maroon", category: "kameez" }).matches.map((hit) => hit.product.id)).toEqual([maroonKameez.id]);
  });

  it("offers close alternatives when nothing matches exactly", () => {
    const result = searchCatalog(catalog, { color: "black", category: "kurta" });
    expect(result.matches).toEqual([]);
    const alternativeIds = result.alternatives.map((hit) => hit.product.id);
    expect(alternativeIds).toContain(greenKurta.id);
    // Out of stock items are not suggested.
    expect(alternativeIds).not.toContain(blackAbaya.id);
  });

  it("treats maroon as near red, not as red", () => {
    const hit = searchCatalog(catalog, { color: "red" }).alternatives.find((entry) => entry.product.id === maroonKameez.id);
    expect(hit?.color).toBe("near");
  });

  it("flags size availability and budget", () => {
    const result = searchCatalog(catalog, { color: "red", size: "M" });
    expect(result.matches[0]?.product.id).toBe(redKurta.id);
    expect(result.matches[0]?.sizeInStock).toBe(false);
    const cheap = searchCatalog(catalog, { category: "shirt", maxPrice: 2500 });
    expect(cheap.matches.map((hit) => hit.product.id)).toEqual([maroonKameez.id]);
  });

  it("matches free text against names, aliases and fabric", () => {
    expect(searchCatalog(catalog, { text: "lawn" }).matches.map((hit) => hit.product.id)).toEqual([greenKurta.id]);
    expect(searchCatalog(catalog, { text: "banana" }).matches).toEqual([]);
  });
});

describe("browseCatalog", () => {
  it("lists in-stock categories and newest items", () => {
    const overview = browseCatalog(catalog);
    expect(overview.categories.map((entry) => entry.name)).not.toContain("abaya");
    expect(overview.newest[0]?.id).toBe(maroonKameez.id);
    expect(browseCatalog(catalog, "kurta").inCategory.map((entry) => entry.id).sort()).toEqual([greenKurta.id, redKurta.id].sort());
  });
});

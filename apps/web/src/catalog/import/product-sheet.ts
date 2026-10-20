import { parseVariantList, type VariantInput } from "../admin/validation";
import { imageMimeFromPath, parseCsv, type ManifestImage } from "./manifest";

// The sheet a shop owner fills in for a bulk import: one row per product. Only a code, the price and the sizes
// are needed; the name, category, colour, fabric, tags and description can come from the product photo (Gemini).
// Column names are forgiving ("Price (Rs)", "Colour", "Fabric", "Qeemat"…) and unknown columns are ignored, so a
// sheet the owner made himself usually works as it is. Photos are matched to rows by code (see matchPhotos).

export type SheetField = "sku" | "name" | "category" | "price_pkr" | "description" | "color" | "material" | "style_tags" | "aliases" | "sizes" | "images";

// Header text (lowercase, letters and digits only) → field.
const HEADER_ALIASES: Record<SheetField, string[]> = {
  sku: ["sku", "code", "productcode", "itemcode", "article", "articleno", "articlenumber", "design", "designno", "designnumber"],
  name: ["name", "productname", "itemname", "title"],
  category: ["category", "type", "itemtype", "producttype"],
  price_pkr: ["pricepkr", "price", "pricers", "rs", "rate", "qeemat", "keemat", "saleprice"],
  description: ["description", "notes", "note", "details", "detail"],
  color: ["color", "colour", "colors", "colours", "rang"],
  material: ["material", "fabric", "kapra", "kapda", "cloth"],
  style_tags: ["styletags", "tags", "style"],
  aliases: ["aliases", "othernames", "alsocalled", "keywords"],
  sizes: ["sizes", "size", "stock", "sizesstock", "sizestock", "sizesandstock", "quantity", "qty"],
  images: ["images", "image", "photos", "photo", "pictures"],
};

export type SheetRow = {
  line: number;
  // The product code, upper-cased: it is the product's SKU, and photos are matched by it.
  sku: string;
  // Raw text as written; name and category may be empty here and filled from the photo before saving.
  fields: { name: string; category: string; description: string; color: string; material: string; styleTags: string; aliases: string; pricePkr: string };
  variants: VariantInput[];
  // Photos named in an images column (paths relative to the sheet); empty means "find them by code".
  images: ManifestImage[];
};

export type SheetRowResult = { ok: true; row: SheetRow } | { ok: false; line: number; sku: string; error: string };

const headerKey = (header: string) => header.toLowerCase().replace(/[^a-z0-9]/g, "");

export function parseProductSheet(text: string): { rows: SheetRowResult[]; ignoredColumns: string[] } {
  const [headerCells, ...dataRows] = parseCsv(text);
  if (!headerCells) throw new Error("The sheet is empty.");
  const columns = headerCells.map((cell) => {
    const key = headerKey(cell);
    return (Object.keys(HEADER_ALIASES) as SheetField[]).find((field) => HEADER_ALIASES[field].includes(key)) ?? null;
  });
  const missing = (["sku", "price_pkr"] as const).filter((field) => !columns.includes(field));
  if (missing.length) throw new Error(`The sheet needs a ${missing.map((field) => (field === "sku" ? "code" : "price")).join(" and a ")} column.`);
  const ignoredColumns = headerCells.filter((cell, index) => columns[index] === null && cell.trim());

  const seen = new Map<string, number>();
  const rows = dataRows.map((cells, index) =>
    parseRow(
      index + 2,
      // The first matching column wins, so an extra "Price (sale)" can't overwrite "Price".
      (field) => {
        const position = columns.indexOf(field);
        return position === -1 ? "" : (cells[position] ?? "").trim();
      },
      seen,
    ),
  );
  return { rows, ignoredColumns };
}

// What WhatsApp puts in front of a copied or exported message: "[2:15 PM, 06/10/2026] Huzaifa: " (desktop),
// "06/10/2026, 2:15 pm - Huzaifa: " (Android export) or "[06/10/2026, 2:15:30 PM] Huzaifa: " (iPhone export).
const CHAT_PREFIX = /^\s*(?:\[[^\]]{1,40}\]\s*|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4},?\s+\d{1,2}:\d{2}(?:\s?[ap]\.?m\.?)?\s+-\s+)[^:|]{1,40}:\s*/i;

// The invisible direction marks (and BOM) WhatsApp puts around names, times and attachments.
export const stripMarks = (text: string) => text.replace(/[‎‏‪-‮⁦-⁩﻿]/g, "");

// One product the way an owner types it on WhatsApp: "K12 | 3500 | S2 M3 L1 | lawn, 3 piece". After the sizes,
// anything else is a note (fabric, pieces, details) and helps the AI and meaning search. Null for a line without a
// "|" (greetings, photos, "ok"); a chat prefix in front of it is ignored.
export function parseProductLine(text: string, line: number, seen = new Map<string, number>()): SheetRowResult | null {
  // An edited message ends with "<This message was edited>" (in the phone's language).
  const cleaned = stripMarks(text)
    .replace(CHAT_PREFIX, "")
    .replace(/\s*<[^<>|]{1,60}>\s*$/, "")
    .trim();
  if (!cleaned.includes("|")) return null;
  const [code = "", price = "", sizes = "", ...notes] = cleaned.split("|").map((part) => part.trim());
  const cells: Partial<Record<SheetField, string>> = { sku: code, price_pkr: price, sizes, description: notes.filter(Boolean).join(", ") };
  return parseRow(line, (field) => cells[field] ?? "", seen);
}

// A .txt of product lines, one per line; everything else is skipped, so copied chat messages can be pasted in.
export function parseProductLines(text: string): { rows: SheetRowResult[] } {
  const seen = new Map<string, number>();
  return { rows: text.split(/\r?\n/).flatMap((raw, index) => parseProductLine(raw, index + 1, seen) ?? []) };
}

function parseRow(line: number, cell: (field: SheetField) => string, seen: Map<string, number>): SheetRowResult {
  const rawCode = cell("sku");
  const sku = normalizeCode(rawCode);
  if (!sku) return { ok: false, line, sku: rawCode, error: rawCode ? `code "${rawCode}" may only use letters, numbers, dash, dot and underscore` : "code is empty" };
  const previous = seen.get(sku);
  if (previous) return { ok: false, line, sku, error: `code repeats line ${previous}` };
  seen.set(sku, line);

  const pricePkr = cleanPrice(cell("price_pkr"));
  if (!pricePkr) return { ok: false, line, sku, error: `price "${cell("price_pkr")}" isn't a whole number of rupees` };

  const sizes = parseSizes(cell("sizes"));
  if (!sizes.ok) return { ok: false, line, sku, error: `sizes: ${sizes.error}` };
  const variants = parseVariantList(sizes.sizes.map((size) => ({ sizeLabel: size.size, stockQty: String(size.stock), variantSku: size.variantSku ?? "" })));
  if (!variants.ok) return { ok: false, line, sku, error: `sizes: ${variants.error}` };

  const images: ManifestImage[] = [];
  for (const path of cell("images").split(/[|\n]/).map((part) => part.trim()).filter(Boolean)) {
    const mimeType = imageMimeFromPath(path);
    if (!mimeType) return { ok: false, line, sku, error: `images: ${path} is not a JPEG, PNG or WebP file` };
    images.push({ path, mimeType });
  }
  if (images.length > 10) return { ok: false, line, sku, error: "images: at most 10 per product" };

  return {
    ok: true,
    row: {
      line,
      sku,
      fields: {
        name: cell("name"),
        category: cell("category"),
        description: cell("description"),
        color: cell("color"),
        material: cell("material"),
        styleTags: cell("style_tags").replaceAll("|", ","),
        aliases: cell("aliases").replaceAll("|", ","),
        pricePkr,
      },
      variants: variants.variants,
      images,
    },
  };
}

type PhotoSuggestion = { isProduct: boolean; name?: string | null; category: string | null; color: string | null; material: string | null; description: string | null; styleTags: string[] };

// Fills what the sheet left empty from the AI's reading of the main photo; whatever the owner wrote is kept.
// Returns the fields it filled, for the import report.
export function fillFromSuggestion(fields: SheetRow["fields"], suggestion: PhotoSuggestion): { fields: SheetRow["fields"]; filled: string[] } {
  if (!suggestion.isProduct) return { fields, filled: [] };
  const next = { ...fields };
  const filled: string[] = [];
  const fill = (key: "name" | "category" | "color" | "material" | "description", value: string | null | undefined, label: string) => {
    if (next[key].trim() || !value?.trim()) return;
    next[key] = value.trim();
    filled.push(label);
  };
  fill("name", suggestion.name, "name");
  fill("category", suggestion.category, "category");
  fill("color", suggestion.color, "colour");
  fill("material", suggestion.material, "fabric");
  fill("description", suggestion.description, "description");
  if (!next.styleTags.trim() && suggestion.styleTags.length) {
    next.styleTags = suggestion.styleTags.join(",");
    filled.push("tags");
  }
  return { fields: next, filled };
}

// "k 12" → "K-12", "#A7" → "A7"; null when it can't be a SKU.
export function normalizeCode(raw: string): string | null {
  const code = raw.trim().replace(/^#+/, "").replace(/\s+/g, "-").toUpperCase();
  return /^[A-Z0-9][A-Z0-9._-]{0,63}$/.test(code) ? code : null;
}

// "Rs. 3,500/-" → "3500"; null unless it is a whole number of rupees.
export function cleanPrice(raw: string): string | null {
  const cleaned = raw.replace(/rs\.?|pkr|\/-|[,\s]/gi, "").replace(/\.0+$/, "");
  return /^\d{1,9}$/.test(cleaned) && Number(cleaned) > 0 ? cleaned : null;
}

export type SizeStock = { size: string; stock: number; variantSku?: string };

// Letter sizes may be glued to the count ("S2"); number sizes need a separator ("32-2", "34:1", "36 3").
const LETTER_SIZE = String.raw`extra[\s-]*large|xx[\s-]*large|x[\s-]*large|free[\s-]*size|one[\s-]*size|free|small|medium|large|xxxl|xxl|xl|xxs|xs|s|m|l`;
const SIZE_PAIR = new RegExp(String.raw`(?<![a-z0-9])(?:(${LETTER_SIZE})\s*[:=\-–]?\s*(\d{1,6})|(\d{2,3})\s*(?:[:=\-–]\s*|\s+)(\d{1,6}))(?![a-z0-9])`, "gi");

// "S2 M3 L1", "S-2, M-3", "Small 2 Medium 3", "Free 5", "32-2 34-1", or the older "S:3|M:0|L:5:SKU-L".
export function parseSizes(raw: string): { ok: true; sizes: SizeStock[] } | { ok: false; error: string } {
  const text = raw.trim();
  if (!text) return { ok: true, sizes: [] };
  const hint = `write each size with how many you have, e.g. "S2 M3 L1" or "Free 5" (got "${text.slice(0, 60)}")`;
  if (text.includes("|")) {
    const sizes: SizeStock[] = [];
    for (const part of text.split("|").map((piece) => piece.trim()).filter(Boolean)) {
      const match = part.match(/^(.+?)\s*[:=\-–]\s*(\d{1,6})\s*(?::\s*([A-Za-z0-9._-]+))?$/);
      if (!match) return { ok: false, error: hint };
      sizes.push({ size: match[1]!.trim(), stock: Number(match[2]), ...(match[3] ? { variantSku: match[3] } : {}) });
    }
    return { ok: true, sizes };
  }
  const sizes: SizeStock[] = [];
  const leftover = text.replace(SIZE_PAIR, (_match, letter: string | undefined, letterStock: string | undefined, number: string | undefined, numberStock: string | undefined) => {
    sizes.push({ size: letter ? sizeLabel(letter) : number!, stock: Number(letterStock ?? numberStock) });
    return " ";
  });
  // Anything left besides separators means part of the cell wasn't understood: better to stop than guess.
  if (!sizes.length || /[a-z0-9]/i.test(leftover.replace(/\b(?:size|sizes|pcs|pc|pieces)\b/gi, ""))) return { ok: false, error: hint };
  return { ok: true, sizes };
}

// How a size reads on product cards: "s" → "S", "free" → "Free size", "extra-large" → "Extra large".
function sizeLabel(raw: string): string {
  const words = raw.toLowerCase().replace(/[\s-]+/g, " ").trim();
  if (/^(?:xxxl|xxl|xl|xxs|xs|s|m|l)$/.test(words)) return words.toUpperCase();
  if (words === "free" || words === "free size" || words === "one size") return "Free size";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const normalizeName = (value: string) => value.toLowerCase().replace(/^#+/, "").replace(/\s+/g, "-");

// The photos for a code among the files next to the sheet (paths relative to it, any OS separator): files named
// by the code ("K12.jpg", "K12-1.jpg", "K12 (2).png", "k12_back.webp"), or anything in a folder named by it
// ("K12/front.jpg"). Sorted so "-1"/"-2"/"-10" keep their order; the first one is the main photo.
export function matchPhotos(code: string, files: readonly string[]): string[] {
  const wanted = normalizeName(code);
  const matches = files.filter((file) => {
    const parts = file.split(/[\\/]+/);
    const base = parts.at(-1)!.replace(/\.[^.]+$/, "");
    if (!imageMimeFromPath(file)) return false;
    if (parts.slice(0, -1).some((folder) => normalizeName(folder) === wanted)) return true;
    const name = normalizeName(base);
    return name === wanted || (name.startsWith(wanted) && /^[-_.(]/.test(name.slice(wanted.length)));
  });
  // The plain code first ("K12.jpg"), then by the number after it ("-1", " (3)", "-10"), then the rest by name.
  const position = (file: string) => {
    const base = normalizeName(file.split(/[\\/]+/).at(-1)!.replace(/\.[^.]+$/, ""));
    const rest = base.startsWith(wanted) ? base.slice(wanted.length) : base;
    if (!rest) return 0;
    const number = rest.match(/\d+/);
    return number ? Number(number[0]) : Number.MAX_SAFE_INTEGER;
  };
  return matches.sort((a, b) => position(a) - position(b) || a.localeCompare(b, "en", { numeric: true, sensitivity: "base" })).slice(0, 10);
}

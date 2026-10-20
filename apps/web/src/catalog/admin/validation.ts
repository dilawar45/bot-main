import { z } from "zod";

export const PRODUCT_IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const PRODUCT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export type ProductImageMimeType = (typeof PRODUCT_IMAGE_MIME_TYPES)[number];

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value.length > 0 ? value : null));

const tagList = z
  .string()
  .max(1000)
  .transform((value) => {
    const seen = new Set<string>();
    for (const part of value.split(/[,\n]/)) {
      const tag = part.trim().replace(/\s+/g, " ");
      if (tag && tag.length <= 60) seen.add(tag.toLowerCase());
    }
    return [...seen].slice(0, 30);
  });

export const ProductFormSchema = z.object({
  sku: z
    .string()
    .trim()
    .min(1, "SKU is required.")
    .max(64)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "SKU may only use letters, numbers, dot, dash and underscore.")
    .transform((value) => value.toUpperCase()),
  name: z.string().trim().min(1, "Name is required.").max(160),
  description: z.string().trim().max(4000),
  category: z.string().trim().min(1, "Category is required.").max(80).transform((value) => value.toLowerCase()),
  color: optionalText(60),
  material: optionalText(80),
  styleTags: tagList,
  aliases: tagList,
  pricePkr: z
    .string()
    .trim()
    .regex(/^\d{1,9}$/, "Price must be a whole number of rupees.")
    .transform(Number),
});
export type ProductFormValues = z.output<typeof ProductFormSchema>;

export type ProductFieldInput = Record<"sku" | "name" | "description" | "category" | "color" | "material" | "styleTags" | "aliases" | "pricePkr", string | undefined>;

export function parseProductFields(input: ProductFieldInput) {
  const field = (name: keyof ProductFieldInput) => input[name] ?? "";
  return ProductFormSchema.safeParse({
    sku: field("sku"),
    name: field("name"),
    description: field("description"),
    category: field("category"),
    color: field("color"),
    material: field("material"),
    styleTags: field("styleTags"),
    aliases: field("aliases"),
    pricePkr: field("pricePkr").replace(/[,\s]/g, ""),
  });
}

export function parseProductForm(formData: FormData) {
  const field = (name: string) => String(formData.get(name) ?? "");
  return parseProductFields({
    sku: field("sku"),
    name: field("name"),
    description: field("description"),
    category: field("category"),
    color: field("color"),
    material: field("material"),
    styleTags: field("styleTags"),
    aliases: field("aliases"),
    pricePkr: field("pricePkr"),
  });
}

// "xl", " XL ", "x-large" and "Extra Large" all refer to the same row.
const sizeSynonyms: Record<string, string> = {
  "extra small": "XS",
  "x small": "XS",
  small: "S",
  medium: "M",
  large: "L",
  "extra large": "XL",
  "x large": "XL",
  "xx large": "XXL",
  "free size": "FREE",
  freesize: "FREE",
  "one size": "FREE",
};

export function normalizeSize(label: string): string {
  const compact = label.trim().toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ");
  return sizeSynonyms[compact] ?? compact.replace(/\s+/g, "").toUpperCase();
}

const sizeOrder = ["XXS", "XS", "S", "M", "L", "XL", "XXL", "XXXL", "FREE"];

export function compareSizes(a: string, b: string): number {
  const rankA = sizeOrder.indexOf(a);
  const rankB = sizeOrder.indexOf(b);
  if (rankA !== -1 || rankB !== -1) return (rankA === -1 ? sizeOrder.length : rankA) - (rankB === -1 ? sizeOrder.length : rankB);
  return a.localeCompare(b, "en", { numeric: true });
}

const VariantRowSchema = z.object({
  sizeLabel: z.string().trim().min(1, "Size is required.").max(30),
  stockQty: z
    .string()
    .trim()
    .regex(/^\d{1,6}$/, "Stock must be a whole number, 0 or more.")
    .transform(Number),
  variantSku: optionalText(64),
});

// stockLoaded: the stock this size had when the form was opened (null for a new or renamed size); used to
// save the owner's change as a difference, so sales or returns meanwhile aren't overwritten.
export type VariantInput = { sizeLabel: string; normalizedSize: string; stockQty: number; variantSku: string | null; stockLoaded?: number | null };

export type VariantParseResult = { ok: true; variants: VariantInput[] } | { ok: false; error: string };

export type VariantRowInput = { sizeLabel: string; stockQty: string; variantSku: string; loadedSize?: string; loadedStock?: string };

export function parseVariantRows(formData: FormData): VariantParseResult {
  const sizes = formData.getAll("sizeLabel").map(String);
  const stocks = formData.getAll("stockQty").map(String);
  const skus = formData.getAll("variantSku").map(String);
  const loadedSizes = formData.getAll("loadedSize").map(String);
  const loadedStocks = formData.getAll("loadedStock").map(String);
  return parseVariantList(
    sizes.map((sizeLabel, index) => ({ sizeLabel, stockQty: stocks[index] ?? "", variantSku: skus[index] ?? "", loadedSize: loadedSizes[index], loadedStock: loadedStocks[index] })),
  );
}

export function parseVariantList(rows: VariantRowInput[]): VariantParseResult {
  const sizes = rows.map((row) => row.sizeLabel);
  const stocks = rows.map((row) => row.stockQty);
  const skus = rows.map((row) => row.variantSku);
  const variants: VariantInput[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < sizes.length; index += 1) {
    if (!sizes[index]?.trim() && !stocks[index]?.trim() && !skus[index]?.trim()) continue;
    const parsed = VariantRowSchema.safeParse({ sizeLabel: sizes[index] ?? "", stockQty: stocks[index] ?? "", variantSku: skus[index] ?? "" });
    if (!parsed.success) return { ok: false, error: `Row ${index + 1}: ${parsed.error.issues[0]?.message ?? "invalid"}` };

    const normalizedSize = normalizeSize(parsed.data.sizeLabel);
    if (seen.has(normalizedSize)) return { ok: false, error: `Size ${normalizedSize} is listed twice.` };
    seen.add(normalizedSize);
    const loaded = rows[index]?.loadedStock?.trim();
    const sameSize = rows[index]?.loadedSize !== undefined && normalizeSize(rows[index]!.loadedSize!) === normalizedSize;
    const stockLoaded = sameSize && loaded && /^\d{1,6}$/.test(loaded) ? Number(loaded) : null;
    variants.push({ ...parsed.data, normalizedSize, variantSku: parsed.data.variantSku?.toUpperCase() ?? null, stockLoaded });
  }

  if (variants.length > 40) return { ok: false, error: "At most 40 sizes per product." };
  return { ok: true, variants };
}

export type PublishCandidate = {
  sku: string;
  name: string;
  category: string;
  pricePkr: number;
  imageCount: number;
  variantCount: number;
};

export function getPublishBlockers(product: PublishCandidate): string[] {
  const blockers: string[] = [];
  if (!product.sku.trim()) blockers.push("Add a SKU.");
  if (!product.name.trim()) blockers.push("Add a name.");
  if (!product.category.trim()) blockers.push("Add a category.");
  if (!Number.isInteger(product.pricePkr) || product.pricePkr <= 0) blockers.push("Set a price above 0.");
  if (product.imageCount < 1) blockers.push("Upload at least one image.");
  if (product.variantCount < 1) blockers.push("Add at least one size.");
  return blockers;
}

export function productImageExtension(mimeType: ProductImageMimeType): string {
  return { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[mimeType];
}

const productIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isProductImagePathFor(productId: string, path: string): boolean {
  if (!productIdPattern.test(productId)) return false;
  return new RegExp(`^products/${productId}/[0-9a-f-]{36}\\.(jpg|png|webp)$`).test(path);
}

import {
  PRODUCT_IMAGE_MIME_TYPES,
  parseProductFields,
  parseVariantList,
  type ProductFormValues,
  type ProductImageMimeType,
  type VariantInput,
} from "../admin/validation";

// RFC 4180 CSV: quoted fields, doubled quotes, commas/newlines inside quotes, CRLF or LF, optional BOM.
export function parseCsv(text: string): string[][] {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && field.length === 0) quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  if (quoted) throw new Error("CSV has an unclosed quote.");
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim()));
}

export const MANIFEST_COLUMNS = ["sku", "name", "category", "price_pkr", "description", "color", "material", "style_tags", "aliases", "sizes", "images"] as const;
const REQUIRED_COLUMNS = ["sku", "name", "category", "price_pkr"] as const;

export type ManifestImage = { path: string; mimeType: ProductImageMimeType };

export type ManifestRow = {
  line: number;
  product: ProductFormValues;
  variants: VariantInput[];
  images: ManifestImage[];
};

export type ManifestRowResult = { ok: true; row: ManifestRow } | { ok: false; line: number; sku: string; error: string };

const extensionMime: Record<string, ProductImageMimeType> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

export function imageMimeFromPath(path: string): ProductImageMimeType | null {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  const mime = extensionMime[extension];
  return mime && PRODUCT_IMAGE_MIME_TYPES.includes(mime) ? mime : null;
}

// sizes cell: "S:3|M:0|Large:5"; "S:3:SKU-S" adds a variant SKU.
function parseSizesCell(cell: string) {
  return cell
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [sizeLabel = "", stockQty = "", variantSku = ""] = part.split(":").map((piece) => piece.trim());
      return { sizeLabel, stockQty, variantSku };
    });
}

export function parseManifest(text: string): { header: string[]; rows: ManifestRowResult[] } {
  const [headerCells, ...dataRows] = parseCsv(text);
  if (!headerCells) throw new Error("Manifest is empty.");
  const header = headerCells.map((cell) => cell.trim().toLowerCase());
  const missing = REQUIRED_COLUMNS.filter((column) => !header.includes(column));
  if (missing.length) throw new Error(`Manifest is missing columns: ${missing.join(", ")}.`);
  const unknown = header.filter((column) => !(MANIFEST_COLUMNS as readonly string[]).includes(column));
  if (unknown.length) throw new Error(`Unknown manifest columns: ${unknown.join(", ")}. Allowed: ${MANIFEST_COLUMNS.join(", ")}.`);

  const seenSkus = new Map<string, number>();
  const rows = dataRows.map((cells, index): ManifestRowResult => {
    const line = index + 2;
    const cell = (column: string) => {
      const position = header.indexOf(column);
      return position === -1 ? "" : (cells[position] ?? "");
    };
    const sku = cell("sku").trim();

    const product = parseProductFields({
      sku,
      name: cell("name"),
      description: cell("description"),
      category: cell("category"),
      color: cell("color"),
      material: cell("material"),
      styleTags: cell("style_tags").replaceAll("|", ","),
      aliases: cell("aliases").replaceAll("|", ","),
      pricePkr: cell("price_pkr"),
    });
    if (!product.success) return { ok: false, line, sku, error: product.error.issues[0]?.message ?? "Invalid product fields." };

    const previousLine = seenSkus.get(product.data.sku);
    if (previousLine) return { ok: false, line, sku, error: `SKU repeats line ${previousLine}.` };
    seenSkus.set(product.data.sku, line);

    const variants = parseVariantList(parseSizesCell(cell("sizes")));
    if (!variants.ok) return { ok: false, line, sku, error: `sizes: ${variants.error}` };

    const images: ManifestImage[] = [];
    for (const path of cell("images").split("|").map((part) => part.trim()).filter(Boolean)) {
      const mimeType = imageMimeFromPath(path);
      if (!mimeType) return { ok: false, line, sku, error: `images: ${path} is not a JPEG, PNG or WebP file.` };
      images.push({ path, mimeType });
    }
    if (images.length > 10) return { ok: false, line, sku, error: "images: at most 10 per product." };

    return { ok: true, row: { line, product: product.data, variants: variants.variants, images } };
  });

  return { header, rows };
}

// Deterministic object name per product + file content, so re-running an import never duplicates images.
export function contentAddressedImageName(productId: string, contentSha256: string, mimeType: ProductImageMimeType): string {
  const hex = contentSha256.slice(0, 32);
  const uuidLike = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  const extension = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[mimeType];
  return `products/${productId}/${uuidLike}.${extension}`;
}

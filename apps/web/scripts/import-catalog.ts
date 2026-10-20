// Bulk product import: a folder with the products and their photos -> products in Supabase.
//
//   pnpm import:products <folder, sheet, chat or .zip> [--dry-run] [--publish] [--suggest]     (from the repo root)
//
// The folder holds one of:
// - a WhatsApp chat exported with "Export chat → Include media" (the .zip as it is, or unpacked): photos are matched
//   to codes by their captions and the "K12 | 3500 | S2 M3 L1" lines (src/catalog/import/chat-export.ts);
// - a sheet (CSV from Excel or Google Sheets) with code, price and sizes columns, optionally name, category, colour,
//   fabric, notes, tags, other names and photos (src/catalog/import/product-sheet.ts; docs/catalog/products-template.csv);
// - a .txt with one "K12 | 3500 | S2 M3 L1 | lawn" line per product.
// Photos are also found by code: "K12.jpg", "K12-1.jpg", "K12 (2).png", or anything in a folder named "K12".
//
// Gemini reads the main photo and fills whatever the sheet left empty: name, category, colour, fabric, tags and
// description. --publish puts a product live once it has a name, category, price, photo and sizes; otherwise it
// stays a draft and the report says what's missing. --suggest also reads every other new photo.
//
// Safe to re-run. Products match by code ("K 12" is K12), an existing product keeps its name and category when the
// sheet leaves them empty, and a record of each import (src/catalog/import/import-record.ts) means a photo is
// uploaded once, even if it's removed in the admin later. From a chat, a product already in the shop takes only a
// line it hasn't had before, with the stock less what orders took since that line was sent. Every run writes
// import-preview.html (each product with its photos) and a JSON report next to the sheet.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import extractZip from "extract-zip";
import { parseGeminiKeys, parseModelList } from "../src/ai/gemini";
import { getPublishBlockers, parseProductFields, PRODUCT_IMAGE_MAX_BYTES, type ProductFormValues, type VariantInput } from "../src/catalog/admin/validation";
import { refreshProductEmbeddings } from "../src/catalog/embeddings";
import { refreshProductImageEmbeddings } from "../src/catalog/image-embeddings";
import { suggestFromProductImage, toStoredSuggestion, type ImageSuggestion } from "../src/catalog/image-suggestions";
import { codeKey, looksLikeChat, readChatExport, type PhotoMatch } from "../src/catalog/import/chat-export";
import { lineIsNew, readImportRecord, saveImportRecord, stockChangesSince, withStockChanges, type OrderedItem } from "../src/catalog/import/import-record";
import { contentAddressedImageName, imageMimeFromPath, type ManifestImage } from "../src/catalog/import/manifest";
import { fillFromSuggestion, matchPhotos, parseProductLines, parseProductSheet } from "../src/catalog/import/product-sheet";
import { DEFAULT_EMBEDDING_MODEL, DEFAULT_IMAGE_EMBEDDING_MODEL } from "../src/catalog/semantic";

type RowReport = {
  line: number;
  sku: string;
  outcome: "created" | "updated" | "unchanged" | "would_create" | "would_update" | "error";
  name: string;
  category: string;
  price: string;
  sizes: string;
  photos: number;
  photoFiles: { path: string; via: PhotoMatch | null }[];
  imagesAdded: number;
  imagesSkipped: number;
  aiFilled: string[];
  published: boolean;
  message: string;
};

const args = process.argv.slice(2);
const target = args.find((arg) => !arg.startsWith("--"));
const dryRun = args.includes("--dry-run");
const publish = args.includes("--publish");
const suggest = args.includes("--suggest");

if (!target) {
  console.error("Usage: pnpm import:products <folder, sheet.csv, lines.txt or WhatsApp export> [--dry-run] [--publish] [--suggest]");
  process.exit(1);
}

function loadEnv(): Record<string, string | undefined> {
  const file = resolve(import.meta.dirname, "../.env.local");
  const fromFile = existsSync(file)
    ? Object.fromEntries(
        readFileSync(file, "utf8")
          .split(/\r?\n/)
          .filter((line) => /^[A-Z_]+=/.test(line))
          .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
      )
    : {};
  return { ...fromFile, ...process.env };
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

// Every .csv/.txt in the folder and the folders inside it (two levels), with how deep it is. Links are skipped.
function listSheets(dir: string, depth = 0): { path: string; depth: number }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith(".") || entry.name === "node_modules") return [];
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return depth < 2 ? listSheets(full, depth + 1) : [];
    return entry.isFile() && /\.(?:csv|txt)$/i.test(entry.name) ? [{ path: full, depth }] : [];
  });
}

// Unpacks a .zip into a folder of the same name next to it, again when the .zip is replaced (a new export of the
// same chat has the same name). The zip library refuses paths that leave the folder.
async function unpack(zip: string): Promise<string> {
  const folder = zip.replace(/\.zip$/i, "");
  const marker = join(folder, ".unpacked");
  const { size, mtimeMs } = statSync(zip);
  const stamp = `${size}:${mtimeMs}`;
  if (!existsSync(marker) || readFileSync(marker, "utf8") !== stamp) {
    await extractZip(zip, { dir: resolve(folder) });
    writeFileSync(marker, stamp);
    console.log(`Unpacked ${basename(zip)}`);
  }
  return folder;
}

// What to import: a sheet given directly; otherwise the WhatsApp chat in the folder (or in a folder inside it: an
// unpacked export is "catalog/WhatsApp Chat - Shop/_chat.txt"), else the folder's one sheet. Any .zip is unpacked first.
async function findSheet(path: string): Promise<string> {
  if (!existsSync(path)) throw new Error(`Nothing at ${path}: make the folder and put the WhatsApp export (.zip), a CSV or a .txt of product lines in it.`);
  let folder = path;
  if (statSync(path).isDirectory()) {
    for (const zip of readdirSync(path).filter((name) => /\.zip$/i.test(name))) await unpack(join(path, zip));
  } else if (/\.zip$/i.test(path)) {
    folder = await unpack(path);
  } else {
    return path;
  }

  const found = listSheets(folder);
  // A chat wins over a leftover products.txt or sheet, and over .txt/.csv files sent in the chat as documents.
  const chats = found.filter((sheet) => /\.txt$/i.test(sheet.path) && looksLikeChat(readFileSync(sheet.path, "utf8")));
  if (chats.length === 1) {
    const chat = chats[0]!.path;
    const others = found.filter((sheet) => dirname(sheet.path) !== dirname(chat)).map((sheet) => relative(folder, sheet.path));
    if (others.length) console.log(`Using the WhatsApp chat; not using ${others.join(", ")}`);
    return chat;
  }
  if (chats.length > 1) throw new Error(`More than one WhatsApp chat in ${folder}: ${chats.map((sheet) => relative(folder, sheet.path)).join(", ")}. Remove the old ones or pass the one to import.`);

  const nearest = Math.min(...found.map((sheet) => sheet.depth));
  const sheets = found.filter((sheet) => sheet.depth === nearest).map((sheet) => sheet.path);
  if (sheets.length === 1) return sheets[0]!;
  throw new Error(
    sheets.length
      ? `More than one sheet in ${folder}: ${sheets.map((sheet) => relative(folder, sheet)).join(", ")}. Remove the old ones or pass the one to import.`
      : `No sheet in ${folder}: add the WhatsApp chat export (.zip), the sheet as CSV, or a .txt with one "code | price | sizes" line per product.`,
  );
}

// Every photo under the sheet's folder (a few levels deep), as paths relative to it. Links are skipped.
function listPhotos(baseDir: string, dir = baseDir, depth = 0): string[] {
  if (depth > 3) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith(".") || entry.name === "node_modules") return [];
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return listPhotos(baseDir, full, depth + 1);
    return entry.isFile() && imageMimeFromPath(entry.name) ? [relative(baseDir, full)] : [];
  });
}

type LoadedImage = { path: string; mimeType: ManifestImage["mimeType"]; bytes: Buffer; sha256: string };

function loadImages(images: readonly ManifestImage[], baseDir: string): LoadedImage[] {
  return images.map((image) => {
    const absolute = resolve(baseDir, image.path);
    if (!existsSync(absolute)) throw new Error(`photo not found: ${image.path}`);
    const size = statSync(absolute).size;
    if (size === 0 || size > PRODUCT_IMAGE_MAX_BYTES) throw new Error(`photo must be 1 byte to 10 MB: ${image.path}`);
    const bytes = readFileSync(absolute);
    return { path: image.path, mimeType: image.mimeType, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
}

type ExistingProduct = {
  id: string;
  sku: string;
  status: string;
  name: string;
  category: string;
  color: string | null;
  material: string | null;
  description: string;
  style_tags: string[];
  aliases: string[];
  price_pkr: number;
  updated_at: string;
};

const when = (date: Date) => date.toLocaleString("en-GB", { timeZone: "Asia/Karachi", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true });

async function upsertProduct(client: SupabaseClient, product: ProductFormValues, existing: ExistingProduct | null): Promise<string> {
  if (!existing) {
    const { data, error } = await client
      .from("products")
      .insert({
        sku: product.sku,
        name: product.name,
        description: product.description,
        category: product.category,
        color: product.color,
        material: product.material,
        style_tags: product.styleTags,
        aliases: product.aliases,
        price_pkr: product.pricePkr,
        status: "draft",
      })
      .select("id")
      .single<{ id: string }>();
    if (error) throw new Error(`create failed: ${error.message}`);
    return data.id;
  }

  if (existing.status === "active" && product.pricePkr <= 0) throw new Error("live product needs a price above 0");
  const { error } = await client
    .from("products")
    .update({
      name: product.name,
      category: product.category,
      price_pkr: product.pricePkr,
      description: product.description || existing.description,
      color: product.color ?? existing.color,
      material: product.material ?? existing.material,
      style_tags: product.styleTags.length ? product.styleTags : existing.style_tags,
      aliases: product.aliases.length ? product.aliases : existing.aliases,
    })
    .eq("id", existing.id);
  if (error) throw new Error(`update failed: ${error.message}`);
  return existing.id;
}

async function saveSizes(client: SupabaseClient, productId: string, variants: readonly VariantInput[]): Promise<void> {
  if (!variants.length) return;
  const { error } = await client.from("product_variants").upsert(
    variants.map((variant) => ({
      product_id: productId,
      size_label: variant.sizeLabel,
      normalized_size: variant.normalizedSize,
      stock_qty: variant.stockQty,
      variant_sku: variant.variantSku,
    })),
    { onConflict: "product_id,normalized_size" },
  );
  if (error) throw new Error(`sizes failed: ${error.message}`);
}

// What confirmed orders bought of a product, by size, with when they were confirmed or cancelled.
async function orderedItems(client: SupabaseClient, productId: string): Promise<OrderedItem[]> {
  const { data, error } = await client.from("order_items").select("normalized_size, quantity, orders!inner(status, confirmed_at, cancelled_at)").eq("product_id", productId);
  if (error) throw new Error(`reading orders failed: ${error.message}`);
  return (data ?? []).map((item) => {
    const order = (Array.isArray(item.orders) ? item.orders[0] : item.orders) as { status: string; confirmed_at: string | null; cancelled_at: string | null };
    return { normalizedSize: item.normalized_size as string, quantity: item.quantity as number, status: order.status, confirmedAt: order.confirmed_at, cancelledAt: order.cancelled_at };
  });
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
const fileUrl = (path: string) => path.split(/[\\/]+/).map(encodeURIComponent).join("/");
const fileName = (path: string) => path.split(/[\\/]+/).at(-1)!;

// A page to check the import by eye: every product with its photos (the main one first), then the photos nothing used.
function previewHtml(title: string, notes: readonly string[], reports: readonly RowReport[], leftovers: readonly { label: string; files: readonly string[] }[]): string {
  const figure = (path: string, label: string) =>
    `<figure><a href="${escapeHtml(fileUrl(path))}"><img src="${escapeHtml(fileUrl(path))}" loading="lazy" alt=""></a><figcaption>${escapeHtml(label)}</figcaption></figure>`;
  const products = reports.map((report) => {
    const heading = [report.sku, report.name && `${report.name}${report.category ? ` (${report.category})` : ""}`].filter(Boolean).join(" · ");
    const facts = [report.outcome.replace("_", " "), report.price && `Rs ${report.price}`, report.sizes, report.message].filter(Boolean).join(" · ");
    const photos = report.photoFiles.map((photo, index) => figure(photo.path, [index === 0 ? "main" : "", photo.via ?? fileName(photo.path)].filter(Boolean).join(" · "))).join("");
    return `<section class="${report.outcome === "error" ? "error" : report.outcome === "unchanged" ? "quiet" : ""}"><h2>${escapeHtml(heading)}</h2><p>${escapeHtml(facts)}</p><div class="photos">${photos || '<p class="none">No photos</p>'}</div></section>`;
  });
  const rest = leftovers
    .filter((group) => group.files.length)
    .map((group) => `<section class="quiet"><h2>${escapeHtml(group.label)}</h2><div class="photos">${group.files.map((path) => figure(path, fileName(path))).join("")}</div></section>`);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>
body{font:14px/1.45 system-ui,sans-serif;margin:0;padding:16px;background:#f6f6f4;color:#1d1d1b}
h1{font-size:18px;margin:0 0 4px}h2{font-size:15px;margin:0 0 2px}p{margin:0 0 8px;color:#55554f}
ul{margin:8px 0 16px;padding-left:20px;color:#7a4b00}
section{background:#fff;border:1px solid #e2e2dc;border-radius:10px;padding:12px;margin:0 0 12px}
section.error{border-color:#d4483b}section.quiet{opacity:.75}
.photos{display:flex;flex-wrap:wrap;gap:8px}
figure{margin:0;width:132px}img{display:block;width:132px;height:176px;object-fit:cover;border-radius:8px;background:#eee}
figcaption{font-size:11px;color:#77776f;overflow-wrap:anywhere}.none{font-style:italic}
</style></head><body>
<h1>${escapeHtml(title)}</h1>
${notes.length ? `<ul>${notes.map((note) => `<li>${escapeHtml(note)}</li>`).join("")}</ul>` : ""}
${[...products, ...rest].join("\n")}
</body></html>
`;
}

async function main() {
  const env = loadEnv();
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (apps/web/.env.local).");
  const geminiKeys = parseGeminiKeys(env.GEMINI_API_KEY);
  const visionModel = env.GEMINI_MODEL_PRO || env.GEMINI_MODEL || "gemini-flash-latest";
  const visionFallbacks = parseModelList(`${env.GEMINI_MODEL_FALLBACKS ?? ""},${env.GEMINI_MODEL_FAST ?? "gemini-flash-lite-latest"}`);
  if (suggest && !geminiKeys.length) throw new Error("--suggest needs GEMINI_API_KEY.");

  // Reads one photo with Gemini; a rate limit waits and tries again twice (free-tier keys hit it in bursts).
  const readPhoto = async (image: LoadedImage): Promise<{ suggestion: ImageSuggestion; model: string }> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const result = await suggestFromProductImage({ apiKey: geminiKeys, model: visionModel, fallbackModels: visionFallbacks, imageBase64: image.bytes.toString("base64"), mimeType: image.mimeType });
        await sleep(1_500); // stay well under free-tier request rates
        return result;
      } catch (error) {
        const rateLimited = error instanceof Error && "status" in error && (error as { status?: number }).status === 429;
        if (!rateLimited || attempt >= 2) throw error;
        await sleep(20_000 * (attempt + 1));
      }
    }
  };

  const client = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  // pnpm runs this inside apps/web; a relative path means relative to where the command was typed.
  const sheetPath = await findSheet(resolve(process.env.INIT_CWD ?? process.cwd(), target!));
  const baseDir = dirname(sheetPath);
  const sheetText = readFileSync(sheetPath, "utf8");
  const photos = listPhotos(baseDir);
  const isText = /\.txt$/i.test(sheetPath);
  const chat = isText ? readChatExport(sheetText, photos, statSync(sheetPath).mtime) : null;
  const { rows, ignoredColumns } = chat ? { rows: chat.rows, ignoredColumns: [] } : isText ? { ...parseProductLines(sheetText), ignoredColumns: [] } : parseProductSheet(sheetText);
  // Photos found by name or folder ("K12-1.jpg", "K12/…") are the ones the chat doesn't already account for.
  const namedPhotos = chat ? photos.filter((photo) => !chat.photoTimes.has(photo)) : photos;
  const usedPhotos = new Set<string>();
  const reports: RowReport[] = [];
  const touched: string[] = [];

  // The shop's products by code, so "K 12" in a line finds the K12 already there instead of making a second one.
  const skuByKey = new Map<string, string>();
  for (let from = 0; ; from += 1_000) {
    const { data, error } = await client.from("products").select("sku").order("sku").range(from, from + 999);
    if (error) throw new Error(`reading the products failed: ${error.message}`);
    for (const { sku } of (data ?? []) as { sku: string }[]) if (!skuByKey.has(codeKey(sku))) skuByKey.set(codeKey(sku), sku);
    if (!data || data.length < 1_000) break;
  }

  console.log(`${dryRun ? "[dry run] " : ""}${rows.length} products in ${sheetPath}, ${photos.length} photos in the folder`);
  if (ignoredColumns.length) console.log(`Ignored columns: ${ignoredColumns.join(", ")}`);
  if (chat) {
    const span = chat.firstAt && chat.lastAt ? `, ${when(chat.firstAt)} to ${when(chat.lastAt)}` : "";
    const matched = [...chat.photos.values()].reduce((sum, list) => sum + list.length, 0);
    console.log(`WhatsApp chat${chat.shop ? ` from ${chat.shop}` : ""}: ${chat.messages} messages${span}; ${chat.photoTimes.size} photos, ${matched} matched to a code.`);
    for (const note of chat.notes) console.log(`  ! ${note}`);
  }

  for (const result of rows) {
    if (!result.ok) {
      reports.push({ line: result.line, sku: result.sku, outcome: "error", name: "", category: "", price: "", sizes: "", photos: 0, photoFiles: [], imagesAdded: 0, imagesSkipped: 0, aiFilled: [], published: false, message: result.error });
      continue;
    }
    const row = result.row;
    // An existing product keeps the shop's spelling of its code.
    const sku = skuByKey.get(codeKey(row.sku)) ?? row.sku;
    const report: RowReport = {
      line: row.line,
      sku,
      outcome: "error",
      name: row.fields.name,
      category: row.fields.category,
      price: row.fields.pricePkr,
      sizes: row.variants.map((variant) => `${variant.sizeLabel} ${variant.stockQty}`).join(", "),
      photos: 0,
      photoFiles: [],
      imagesAdded: 0,
      imagesSkipped: 0,
      aiFilled: [],
      published: false,
      message: "",
    };
    reports.push(report);
    // What the report says about this row, joined with "; " at the end.
    const said: string[] = [];
    let productId: string | null = null;
    // Set once the line is applied in full, or found to be older than what the shop has: either way it's done.
    let lineDone = false;
    const record = await readImportRecord(client, sku).catch((error: unknown) => {
      said.push(error instanceof Error ? error.message : String(error));
      return null;
    });
    // Photos now in the product, for the import record.
    const inProduct = new Set<string>();

    try {
      // Photos named by the sheet, else found by code, then the ones sent with the code in the chat; at most 10.
      const fromChat = chat?.photos.get(codeKey(row.sku)) ?? [];
      const via = new Map<string, PhotoMatch>(fromChat.map((photo) => [photo.file, photo.via]));
      const named = row.images.length ? row.images.map((image) => image.path) : matchPhotos(row.sku, namedPhotos);
      const paths = [...new Set([...named, ...fromChat.map((photo) => photo.file)])];
      for (const path of paths) usedPhotos.add(resolve(baseDir, path));
      if (paths.length > 10) said.push(`using the first 10 of ${paths.length} photos`);
      const images = loadImages(
        paths.slice(0, 10).map((path) => ({ path, mimeType: imageMimeFromPath(path)! })),
        baseDir,
      );
      report.photos = images.length;
      report.photoFiles = images.map((image) => ({ path: image.path, via: via.get(image.path) ?? null }));

      const { data: existing, error: lookupError } = await client
        .from("products")
        .select("id, sku, status, name, category, color, material, description, style_tags, aliases, price_pkr, updated_at")
        .eq("sku", sku)
        .maybeSingle<ExistingProduct>();
      if (lookupError) throw new Error(`lookup failed: ${lookupError.message}`);

      // Photos the product has, or had from an earlier import (one removed in the admin stays removed).
      const { data: currentImages } = existing ? await client.from("product_images").select("storage_path, sort_order").eq("product_id", existing.id) : { data: [] };
      const knownPaths = new Set((currentImages ?? []).map((image) => image.storage_path as string));
      const imported = new Set(record?.photos ?? []);
      const isNew = (image: LoadedImage) => !imported.has(image.sha256) && !(existing && knownPaths.has(contentAddressedImageName(existing.id, image.sha256, image.mimeType)));
      for (const image of images) if (!isNew(image) && existing && knownPaths.has(contentAddressedImageName(existing.id, image.sha256, image.mimeType))) inProduct.add(image.sha256);
      const newImages = images.filter(isNew);

      // From a chat, a product already in the shop takes the line only if it hasn't had it (or a later one) before.
      const lineAt = chat?.lineTimes.get(row.sku) ?? null;
      const applyLine = !existing || !chat || lineIsNew(lineAt, record, new Date(existing.updated_at));
      if (!applyLine) {
        if (!lineAt) said.push("kept the shop's price and stock (this line's date can't be read)");
        else if (record?.lineAt && lineAt.getTime() <= Date.parse(record.lineAt)) said.push(`line of ${when(lineAt)} imported before`);
        else said.push(`kept the shop's price and stock (edited ${when(new Date(existing!.updated_at))}, after this line of ${when(lineAt)})`);
      }

      // The line's stock, less what orders took since it was sent (the shop counted before those sales).
      let variants = row.variants;
      if (applyLine && existing && chat && lineAt) {
        const adjusted = withStockChanges(row.variants, stockChangesSince(await orderedItems(client, existing.id), lineAt));
        variants = adjusted.variants;
        if (adjusted.changed.length) said.push(`stock less orders since the line: ${adjusted.changed.join(", ")}`);
        report.sizes = variants.map((variant) => `${variant.sizeLabel} ${variant.stockQty}`).join(", ");
      }

      // An existing product keeps its name and category unless the sheet gives new ones.
      let fields = { ...row.fields, name: row.fields.name || existing?.name || "", category: row.fields.category || existing?.category || "" };
      const needsPhotoReading = !fields.name || !fields.category;
      let mainPhoto: { suggestion: ImageSuggestion; model: string } | null = null;
      report.name = fields.name;
      report.category = fields.category;

      if (dryRun) {
        const fresh = newImages.length === images.length ? "" : ` (${newImages.length} new)`;
        const ways = [...new Set(report.photoFiles.map((photo) => photo.via ?? "by name"))].join(", ");
        if (!applyLine) {
          report.outcome = newImages.length ? "would_update" : "unchanged";
          if (newImages.length) said.push(`would add ${newImages.length} new photo${newImages.length === 1 ? "" : "s"}`);
          report.message = said.join("; ");
          continue;
        }
        const missing = [!fields.name && "name", !fields.category && "category"].filter(Boolean);
        const fillable = images.length > 0 && geminiKeys.length > 0;
        // The real run would stop here: nothing to name the product by.
        report.outcome = missing.length && !fillable ? "error" : existing ? "would_update" : "would_create";
        if (!images.length) said.push("no photos found");
        else said.push(chat ? `${images.length} photo${images.length === 1 ? "" : "s"}${fresh} (${ways})` : `photos: ${images.map((image) => image.path).join(", ")}${fresh}`);
        if (missing.length) said.push(fillable ? `AI will fill ${missing.join(" and ")} from the photo` : `add a ${missing.join(" and ")} in the sheet, or a photo for AI to read`);
        report.message = said.join("; ");
        continue;
      }

      let product: ProductFormValues;
      if (!applyLine) {
        // Only new photos; the product as the shop has it decides whether it can go live.
        const current = parseProductFields({
          sku,
          name: existing!.name,
          category: existing!.category,
          description: existing!.description,
          color: existing!.color ?? "",
          material: existing!.material ?? "",
          styleTags: existing!.style_tags.join(","),
          aliases: existing!.aliases.join(","),
          pricePkr: String(existing!.price_pkr),
        });
        productId = existing!.id;
        lineDone = true;
        if (!current.success) throw new Error(`the product in the shop needs fixing in the admin: ${current.error.issues[0]?.message ?? "invalid"}`);
        product = current.data;
        report.outcome = "unchanged";
      } else {
        if (newImages.length && geminiKeys.length && (needsPhotoReading || suggest || !existing)) {
          try {
            mainPhoto = await readPhoto(newImages[0]!);
            const filled = fillFromSuggestion(fields, mainPhoto.suggestion);
            fields = filled.fields;
            report.aiFilled = filled.filled;
            if (!mainPhoto.suggestion.isProduct) said.push("AI says the main photo doesn't show a product");
          } catch (error) {
            said.push(`AI couldn't read the photo (${error instanceof Error ? error.message : String(error)})`);
          }
        }
        report.name = fields.name;
        report.category = fields.category;

        const parsed = parseProductFields({ sku, ...fields });
        if (!parsed.success) {
          const missing = [!fields.name && "name", !fields.category && "category"].filter(Boolean);
          throw new Error(missing.length ? `add a ${missing.join(" and ")} in the sheet${images.length ? "" : " or a photo"}` : (parsed.error.issues[0]?.message ?? "invalid product"));
        }
        product = parsed.data;
        productId = await upsertProduct(client, product, existing);
        report.outcome = existing ? "updated" : "created";
        touched.push(productId);
        await saveSizes(client, productId, variants);
        lineDone = true;
      }

      let nextSort = Math.max(-1, ...(currentImages ?? []).map((image) => image.sort_order as number)) + 1;
      report.imagesSkipped = images.length - newImages.length;
      for (const image of newImages) {
        const storagePath = contentAddressedImageName(productId, image.sha256, image.mimeType);
        if (knownPaths.has(storagePath)) {
          report.imagesSkipped += 1;
          inProduct.add(image.sha256);
          continue;
        }
        const { error: uploadError } = await client.storage
          .from("product-images")
          .upload(storagePath, image.bytes, { contentType: image.mimeType, upsert: true, cacheControl: "31536000" });
        if (uploadError) throw new Error(`upload ${image.path} failed: ${uploadError.message}`);
        const { data: inserted, error: insertError } = await client
          .from("product_images")
          .insert({ product_id: productId, storage_path: storagePath, sort_order: nextSort })
          .select("id")
          .single<{ id: string }>();
        if (insertError) throw new Error(`photo row ${image.path} failed: ${insertError.message}`);
        knownPaths.add(storagePath);
        inProduct.add(image.sha256);
        nextSort += 1;
        report.imagesAdded += 1;
        if (report.outcome === "unchanged") {
          report.outcome = "updated";
          touched.push(productId);
        }

        // The main photo was read already; others only with --suggest (their descriptions help meaning search).
        let reading = image === newImages[0] ? mainPhoto : null;
        if (!reading && suggest) reading = await readPhoto(image).catch(() => null);
        if (reading) {
          await client
            .from("product_images")
            .update({
              extraction_status: "complete",
              ai_description: reading.suggestion.isProduct ? reading.suggestion.description : null,
              ai_attributes: toStoredSuggestion(reading.suggestion, reading.model),
            })
            .eq("id", inserted.id);
        }
      }

      if (publish) {
        const [{ count: imageCount }, { count: variantCount }] = await Promise.all([
          client.from("product_images").select("id", { count: "exact", head: true }).eq("product_id", productId),
          client.from("product_variants").select("id", { count: "exact", head: true }).eq("product_id", productId),
        ]);
        const status = existing?.status ?? "draft";
        const blockers = getPublishBlockers({ ...product, imageCount: imageCount ?? 0, variantCount: variantCount ?? 0 });
        if (status === "archived") said.push("archived: left as it is");
        else if (blockers.length) said.push(`stays a draft: ${blockers.join(" ")}`);
        else if (status === "draft") {
          const { error } = await client.from("products").update({ status: "active" }).eq("id", productId);
          if (error) throw new Error(`publish failed: ${error.message}`);
          report.published = true;
          if (!touched.includes(productId)) touched.push(productId);
        }
      }
      report.message = said.join("; ") || "ok";
    } catch (error) {
      said.push(error instanceof Error ? error.message : String(error));
      report.message = `${report.outcome === "error" ? "" : "partially imported: "}${said.join("; ")}`;
    }

    // Remember what this run did, even if it stopped partway: the line it handled and the photos now in the product.
    if (!dryRun && productId) {
      const lineAt = lineDone ? (chat?.lineTimes.get(row.sku) ?? null) : null;
      const recordAt = [record?.lineAt ? Date.parse(record.lineAt) : null, lineAt?.getTime() ?? null].filter((time): time is number => time !== null);
      await saveImportRecord(client, {
        sku,
        lineAt: recordAt.length ? new Date(Math.max(...recordAt)).toISOString() : null,
        photos: [...new Set([...(record?.photos ?? []), ...inProduct])],
      }).catch((error: unknown) => {
        report.message += `; ${error instanceof Error ? error.message : String(error)}`;
      });
    }
  }

  const reportPath = `${sheetPath}.report.json`;
  writeFileSync(reportPath, JSON.stringify({ sheet: sheetPath, dryRun, publish, suggest, finishedAt: new Date().toISOString(), notes: chat?.notes ?? [], rows: reports }, null, 2));

  for (const report of reports) {
    const ai = report.aiFilled.length ? `, AI: ${report.aiFilled.join(" ")}` : "";
    const live = report.published ? "  LIVE" : "";
    const sizes = report.sizes ? report.sizes.split(", ").length : 0;
    console.log(`line ${String(report.line).padStart(4)}  ${report.sku.padEnd(14)}  ${report.outcome.padEnd(12)}  ${report.photos} photo${report.photos === 1 ? "" : "s"} (+${report.imagesAdded}), ${sizes} size${sizes === 1 ? "" : "s"}${ai}${live}  ${report.message}`);
  }

  // Photos nothing used: sent with a code that has no usable line, matched to no code, or found by no name.
  const rowKeys = new Set(rows.flatMap((result) => (result.ok ? [codeKey(result.row.sku)] : [])));
  const orphanCodes = chat ? [...chat.photos].filter(([key]) => !rowKeys.has(key)) : [];
  const unmatched = chat ? chat.unmatched.filter((photo) => !usedPhotos.has(resolve(baseDir, photo))) : [];
  const accounted = new Set([...orphanCodes.flatMap(([, list]) => list.map((photo) => photo.file)), ...unmatched, ...(chat?.skipped ?? []), ...(chat?.stickers ?? []), ...(chat?.photoTimes.keys() ?? [])]);
  const unused = photos.filter((photo) => !usedPhotos.has(resolve(baseDir, photo)) && !accounted.has(photo));
  if (orphanCodes.length) console.log(`\nPhotos for codes with no usable line (send "code | price | sizes" for them): ${orphanCodes.map(([key, list]) => `${key} (${list.length})`).join(", ")}`);
  if (unmatched.length) console.log(`\n${unmatched.length} photo${unmatched.length === 1 ? "" : "s"} in the chat matched no code: see the preview.`);
  if (unused.length) console.log(`\nPhotos that matched no code (rename them like "<code>-1.jpg"): ${unused.slice(0, 20).join(", ")}${unused.length > 20 ? ` +${unused.length - 20} more` : ""}`);

  const previewPath = join(baseDir, "import-preview.html");
  writeFileSync(
    previewPath,
    previewHtml(`${dryRun ? "Import check" : "Imported"}: ${fileName(sheetPath)} (${when(new Date())})`, chat?.notes ?? [], reports, [
      ...orphanCodes.map(([key, list]) => ({ label: `Sent as ${key}, but there's no usable "${key} | price | sizes" line`, files: list.map((photo) => photo.file) })),
      { label: "Photos in the chat that matched no code", files: unmatched },
      { label: "Skipped: photos from the other side of the chat", files: chat?.skipped ?? [] },
      { label: "Photos that matched no code", files: unused },
    ]),
  );

  // Live products become findable by meaning and by photo straight away (drafts are indexed when published).
  if (!dryRun && touched.length && geminiKeys.length) {
    const text = await refreshProductEmbeddings(client, { apiKey: geminiKeys, model: env.GEMINI_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL, productIds: touched }).catch(() => null);
    const pictures = await refreshProductImageEmbeddings(client, { apiKey: geminiKeys, model: env.GEMINI_IMAGE_EMBEDDING_MODEL || DEFAULT_IMAGE_EMBEDDING_MODEL, productIds: touched }).catch(() => null);
    const line = (label: string, result: { available: boolean; updated: number; failed: number } | null) =>
      !result ? `${label}: failed` : !result.available ? `${label}: off (migration not applied)` : `${label}: ${result.updated} updated${result.failed ? `, ${result.failed} failed` : ""}`;
    console.log(`\nSearch index: ${line("meaning", text)}; ${line("photos", pictures)}`);
  }

  const errors = reports.filter((report) => report.outcome === "error" || report.message.startsWith("partially")).length;
  const published = reports.filter((report) => report.published).length;
  console.log(`\n${reports.length - errors} ok${publish ? ` (${published} live)` : ""}, ${errors} with errors.`);
  console.log(`Photos per product: ${previewPath}`);
  console.log(`Report: ${reportPath}`);
  process.exitCode = errors ? 2 : 0;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

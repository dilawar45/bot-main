import type { SupabaseClient } from "@supabase/supabase-js";
import { CONFIG_BUCKET, ensureConfigBucket, isNotFound } from "../../shop/settings-store";
import type { VariantInput } from "../admin/validation";
import { codeKey } from "./chat-export";

// What the bulk import last did to a product: the time of the chat line it applied and every photo it uploaded
// (by content hash). One small JSON file per code in the private shop-config bucket, so no migration is needed.
// It lets a re-import skip what it already did: the same line isn't applied twice (an order or an edit made since
// stays), and photos removed in the admin don't come back, while a run that stopped halfway can still finish.
export type ImportRecord = { sku: string; lineAt: string | null; photos: string[] };

const recordPath = (sku: string) => `catalog-imports/${codeKey(sku)}.json`;

export async function readImportRecord(client: SupabaseClient, sku: string): Promise<ImportRecord | null> {
  const { data, error } = await client.storage.from(CONFIG_BUCKET).download(recordPath(sku));
  if (error || !data) {
    if (!error || isNotFound(error)) return null;
    throw new Error(`import record for ${sku}: ${error.message}`);
  }
  try {
    const value = JSON.parse(await data.text()) as Partial<ImportRecord>;
    return {
      sku: typeof value.sku === "string" ? value.sku : sku,
      lineAt: typeof value.lineAt === "string" && !Number.isNaN(Date.parse(value.lineAt)) ? value.lineAt : null,
      photos: Array.isArray(value.photos) ? value.photos.filter((photo): photo is string => typeof photo === "string") : [],
    };
  } catch {
    return null;
  }
}

export async function saveImportRecord(client: SupabaseClient, record: ImportRecord): Promise<void> {
  await ensureConfigBucket(client);
  const { error } = await client.storage
    .from(CONFIG_BUCKET)
    .upload(recordPath(record.sku), new Blob([JSON.stringify(record)], { type: "application/json" }), { upsert: true, contentType: "application/json", cacheControl: "0" });
  if (error) throw new Error(`saving the import record for ${record.sku}: ${error.message}`);
}

// Whether a chat line should change a product that's already in the shop. When the import has a record of the line
// it last applied, only a later line does; for a product made in the admin or from a sheet, only a line sent after
// its last edit. Without a readable date, it doesn't.
export function lineIsNew(lineAt: Date | null, record: ImportRecord | null, productUpdatedAt: Date): boolean {
  if (!lineAt) return false;
  return record?.lineAt ? lineAt.getTime() > Date.parse(record.lineAt) : lineAt.getTime() > productUpdatedAt.getTime();
}

export type OrderedItem = { normalizedSize: string; quantity: number; status: string; confirmedAt: string | null; cancelledAt: string | null };

// What orders did to each size's stock after a line was sent: orders confirmed later took stock (unless they were
// cancelled, which gave it back), and orders confirmed earlier but cancelled later gave stock back. The shop's count
// in the line already includes everything before it.
export function stockChangesSince(items: readonly OrderedItem[], since: Date): Map<string, number> {
  const changes = new Map<string, number>();
  for (const item of items) {
    if (!item.confirmedAt) continue;
    const confirmedLater = Date.parse(item.confirmedAt) > since.getTime();
    const cancelledLater = item.cancelledAt !== null && Date.parse(item.cancelledAt) > since.getTime();
    const change = confirmedLater && item.status !== "cancelled" ? -item.quantity : !confirmedLater && cancelledLater ? item.quantity : 0;
    if (change) changes.set(item.normalizedSize, (changes.get(item.normalizedSize) ?? 0) + change);
  }
  return changes;
}

// The line's counts with those changes ("M2" less one sold since → "M1"), never below zero, and what changed.
export function withStockChanges(variants: readonly VariantInput[], changes: ReadonlyMap<string, number>): { variants: VariantInput[]; changed: string[] } {
  const changed: string[] = [];
  const next = variants.map((variant) => {
    const change = changes.get(variant.normalizedSize) ?? 0;
    if (!change) return variant;
    const stockQty = Math.max(0, variant.stockQty + change);
    changed.push(`${variant.sizeLabel} ${variant.stockQty}→${stockQty}`);
    return { ...variant, stockQty };
  });
  return { variants: next, changed };
}

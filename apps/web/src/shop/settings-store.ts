import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_SHOP_SETTINGS, ShopSettingsSchema, parseShopSettings, type ShopSettings } from "./settings";

// Stored as one private JSON file in Supabase Storage, so no database migration is needed.
export const CONFIG_BUCKET = "shop-config";
const BUCKET = CONFIG_BUCKET;
const OBJECT = "settings.json";
const CACHE_MS = 60_000;

let cache: { value: ShopSettings; at: number } | undefined;

export function isNotFound(error: unknown): boolean {
  const details = error as { message?: string; status?: number; statusCode?: string | number } | null;
  // Storage answers a missing file or bucket with HTTP 400, statusCode "404" and "Object/Bucket not found".
  // Any other 400 (bad key, bucket policy) is a real failure and must not look like "nothing saved yet".
  return String(details?.statusCode ?? "") === "404" || Number(details?.status) === 404 || /^(?:object|bucket) not found$/i.test(details?.message?.trim() ?? "");
}

// The private bucket for the shop's JSON files (settings, import records), made on first use.
export async function ensureConfigBucket(client: SupabaseClient): Promise<void> {
  const { data: bucket } = await client.storage.getBucket(BUCKET);
  if (bucket) return;
  const { error } = await client.storage.createBucket(BUCKET, { public: false, fileSizeLimit: 262_144, allowedMimeTypes: ["application/json"] });
  if (error && !/already exists/i.test(error.message)) throw new Error(`Could not create settings storage: ${error.message}`);
}

// Only "nothing saved yet" means defaults. Any other failure throws (the admin page must not show an
// empty form that would overwrite the real settings), falling back to the last good copy if we have one.
export async function loadShopSettings(client: SupabaseClient): Promise<ShopSettings> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const { data, error } = await client.storage.from(BUCKET).download(OBJECT);
  if (error || !data) {
    if (!error || isNotFound(error)) {
      cache = { value: DEFAULT_SHOP_SETTINGS, at: Date.now() };
      return DEFAULT_SHOP_SETTINGS;
    }
    if (cache) return cache.value;
    throw new Error(`Could not load shop settings: ${(error as { message?: string }).message ?? "storage error"}`);
  }
  const value = parseShopSettings(JSON.parse(await data.text()));
  cache = { value, at: Date.now() };
  return value;
}

// Customers' phone numbers pasted in example chats must never reach the model (it could repeat them).
export function scrubExampleChats(text: string): string {
  return text
    .replace(/(?:\+?92|0)?3\d{2}[\s-]?\d{7}\b|\+?\d[\d\s-]{8,}\d/g, "[number]")
    .replace(/https?:\/\/\S+/g, "[link]")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]");
}

export async function saveShopSettings(client: SupabaseClient, settings: ShopSettings): Promise<void> {
  const valid = ShopSettingsSchema.parse({ ...settings, exampleChats: scrubExampleChats(settings.exampleChats) });
  await ensureConfigBucket(client);
  const { error } = await client.storage
    .from(BUCKET)
    .upload(OBJECT, new Blob([JSON.stringify(valid, null, 2)], { type: "application/json" }), { upsert: true, contentType: "application/json", cacheControl: "0" });
  if (error) throw new Error(`Could not save shop settings: ${error.message}`);
  cache = { value: valid, at: Date.now() };
}

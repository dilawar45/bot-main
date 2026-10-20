import "server-only";
import { isMissingSchema } from "@/catalog/repository";
import { searchIndexStatus } from "@/catalog/embeddings";
import { photoIndexStatus } from "@/catalog/image-embeddings";
import { getVisionEnvironment } from "@/config/env";
import { countNeedingHuman } from "@/conversations/admin-queries";
import { getGatewaySession, type GatewaySession } from "@/gateway/admin-client";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { loadShopSettings } from "@/shop/settings-store";
import { karachiDayStart, type ShopSettings } from "@/shop/settings";

// Everything the admin home shows: what needs the owner now, how today went, how the bot is doing, and what is
// still missing before the shop can sell well on WhatsApp. Each part fails on its own (null), never the page.

export type Overview = {
  needsPerson: number | null;
  newOrders: number | null;
  cartsAwaitingConfirm: number | null;
  messagesToday: number | null;
  ordersToday: { count: number; totalPkr: number } | null;
  bot: { replies: number; byAi: number; rules: number; failures: number; medianMs: number | null } | null;
  catalog: { active: number; drafts: number; withoutPhoto: number; soldOut: number } | null;
  shop: ShopSettings | null;
  meaningSearch: { available: boolean; indexed: number; total: number } | null;
  photoSearch: { available: boolean; indexed: number; total: number } | null;
  ordersMigration: boolean | null;
  followUpsMigration: boolean | null;
  whatsapp: GatewaySession | null;
  whatsappProblem: string | null;
};

export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

const optional = <T,>(promise: Promise<T>): Promise<T | null> =>
  promise.catch((error: unknown) => {
    console.error("Overview query failed", error instanceof Error ? error.message : error);
    return null;
  });

export async function loadOverview(now = new Date()): Promise<Overview> {
  const supabase = await createSupabaseServerClient();
  const service = createSupabaseServiceClient();
  const dayStart = karachiDayStart(now).toISOString();
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1_000).toISOString();

  const count = async (query: PromiseLike<{ count: number | null; error: { code?: string; message?: string } | null }>) => {
    const { count: value, error } = await query;
    if (error) throw new Error(error.message ?? "count failed");
    return value ?? 0;
  };

  const [needsPerson, newOrders, cartsAwaitingConfirm, messagesToday, ordersToday, bot, catalog, shop, meaningSearch, photoSearch, ordersMigration, followUpsMigration, session] = await Promise.all([
    optional(countNeedingHuman()),
    optional(count(supabase.from("orders").select("id", { count: "exact", head: true }).eq("status", "placed"))),
    optional(count(supabase.from("orders").select("id", { count: "exact", head: true }).eq("status", "draft").not("summary_fingerprint", "is", null))),
    optional(count(supabase.from("messages").select("id", { count: "exact", head: true }).eq("direction", "inbound").gte("created_at", dayStart))),
    optional(
      (async () => {
        const { data, error } = await supabase
          .from("orders")
          .select("items_total_pkr, delivery_fee_pkr")
          .neq("status", "draft")
          .neq("status", "cancelled")
          .gte("placed_at", dayStart)
          .returns<{ items_total_pkr: number; delivery_fee_pkr: number | null }[]>();
        if (error) throw new Error(error.message);
        return { count: data.length, totalPkr: data.reduce((sum, row) => sum + row.items_total_pkr + (row.delivery_fee_pkr ?? 0), 0) };
      })(),
    ),
    optional(
      (async () => {
        const { data, error } = await supabase
          .from("agent_runs")
          .select("model, outcome, error_code, latency_ms")
          .gte("created_at", dayAgo)
          .limit(2_000)
          .returns<{ model: string; outcome: string; error_code: string | null; latency_ms: number }[]>();
        if (error) throw new Error(error.message);
        const replies = data.filter((run) => run.outcome !== "throttled" && run.outcome !== "owner_took_over");
        return {
          replies: replies.length,
          byAi: replies.filter((run) => run.model !== "rules").length,
          rules: replies.filter((run) => run.model === "rules").length,
          failures: replies.filter((run) => run.error_code !== null).length,
          medianMs: median(replies.map((run) => run.latency_ms)),
        };
      })(),
    ),
    optional(
      (async () => {
        const { data, error } = await supabase
          .from("products")
          .select("status, product_images(id), product_variants(stock_qty)")
          .in("status", ["active", "draft"])
          .limit(5_000)
          .returns<{ status: "active" | "draft"; product_images: { id: string }[]; product_variants: { stock_qty: number }[] }[]>();
        if (error) throw new Error(error.message);
        const active = data.filter((row) => row.status === "active");
        return {
          active: active.length,
          drafts: data.length - active.length,
          withoutPhoto: active.filter((row) => !row.product_images.length).length,
          soldOut: active.filter((row) => !row.product_variants.some((variant) => variant.stock_qty > 0)).length,
        };
      })(),
    ),
    optional(loadShopSettings(service)),
    optional(searchIndexStatus(service)),
    optional((async () => photoIndexStatus(service, getVisionEnvironment().imageEmbeddingModel))()),
    // Applied migrations, checked the way the features themselves check: does the table / column answer?
    optional(
      (async () => {
        const { error } = await supabase.from("orders").select("id").limit(1);
        if (error && !isMissingSchema(error)) throw new Error(error.message);
        return !error;
      })(),
    ),
    optional(
      (async () => {
        const { error } = await supabase.from("orders").select("summary_sent_at").limit(1);
        if (error && !isMissingSchema(error)) throw new Error(error.message);
        return !error;
      })(),
    ),
    getGatewaySession(),
  ]);

  const problems: Record<string, string> = {
    not_configured: "The gateway isn't configured (GATEWAY_BASE_URL, GATEWAY_ADMIN_TOKEN).",
    unreachable: "The WhatsApp gateway isn't reachable. Is it running?",
    unauthorized: "The gateway rejected the admin token.",
    bad_response: "The gateway answered with something unexpected.",
  };

  return {
    needsPerson,
    newOrders,
    cartsAwaitingConfirm,
    messagesToday,
    ordersToday,
    bot,
    catalog,
    shop,
    meaningSearch,
    photoSearch,
    ordersMigration,
    followUpsMigration,
    whatsapp: session.ok ? session.data : null,
    whatsappProblem: session.ok ? null : (problems[session.reason] ?? "The gateway isn't reachable."),
  };
}

import { createHash, timingSafeEqual } from "node:crypto";
import { SupabaseBrainRepository } from "@/catalog/repository";
import { sendGatewayMessage } from "@/gateway/admin-client";
import { createSupabaseServiceClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

// Customer photos are private and kept 30 days. Message rows stay (for history and stats); only the file goes.
const RETENTION_DAYS = 30;
const BATCH = 200;
const PHOTO_REMOVED = "[photo removed after 30 days]";

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) return false;
  const provided = request.headers.get("authorization") ?? "";
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(`Bearer ${secret}`).digest();
  return timingSafeEqual(a, b);
}

// Vercel Cron calls this daily with "Authorization: Bearer $CRON_SECRET".
export async function GET(request: Request): Promise<Response> {
  if (!authorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const client = createSupabaseServiceClient();
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1_000).toISOString();
  let removed = 0;

  for (let round = 0; round < 10; round += 1) {
    const { data: rows, error } = await client
      .from("messages")
      .select("id, media_path, text_content")
      .eq("direction", "inbound")
      .not("media_path", "is", null)
      .lt("occurred_at", cutoff)
      .limit(BATCH)
      .returns<{ id: string; media_path: string; text_content: string | null }[]>();
    if (error) return Response.json({ error: "Query failed", removed }, { status: 500 });
    if (!rows.length) break;

    const { error: storageError } = await client.storage.from("inbound-media").remove(rows.map((row) => row.media_path));
    if (storageError) return Response.json({ error: "Storage removal failed", removed }, { status: 500 });

    // A message must keep text or media, so caption-less photos get a placeholder.
    const withText = rows.filter((row) => row.text_content).map((row) => row.id);
    const withoutText = rows.filter((row) => !row.text_content).map((row) => row.id);
    if (withText.length) await client.from("messages").update({ media_path: null }).in("id", withText);
    if (withoutText.length) await client.from("messages").update({ media_path: null, text_content: PHOTO_REMOVED }).in("id", withoutText);

    removed += rows.length;
    if (rows.length < BATCH) break;
  }

  // Backstop for replies the gateway never picked up (normally swept after incoming messages).
  const stale = await new SupabaseBrainRepository(client).markStaleDeliveriesFailed(15 * 60_000).catch(() => null);
  const supportChatId = process.env.SUPPORT_WA_ID;
  if (stale && supportChatId) {
    for (const alert of stale.ownerAlerts.slice(0, 5)) await sendGatewayMessage(supportChatId, `(sent again) ${alert}`);
  }

  return Response.json({ removed, cutoff, staleMarkedFailed: stale?.failed ?? null });
}

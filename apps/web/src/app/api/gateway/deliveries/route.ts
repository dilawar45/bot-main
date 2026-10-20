import { readLimitedBody } from "@/security/request-body";
import { DeliveryReportSchema } from "@huzaifa/contracts";
import { getStorageEnvironment } from "@/config/env";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { verifyGatewaySignature } from "@/security/gateway-signature";

export const runtime = "nodejs";

// Gateway reports whether each outbound action reached WhatsApp. Updates messages.delivery_state by action ID.
export async function POST(request: Request): Promise<Response> {
  const read = await readLimitedBody(request);
  if (!read.ok) return read.response;
  const body = read.body;
  let environment;
  try {
    environment = getStorageEnvironment();
  } catch {
    return Response.json({ error: "Server configuration is invalid" }, { status: 503 });
  }

  const authenticated = verifyGatewaySignature({
    body,
    timestamp: request.headers.get("x-huzaifa-timestamp"),
    signature: request.headers.get("x-huzaifa-signature"),
    secret: environment.GATEWAY_HMAC_SECRET,
  });
  if (!authenticated) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = DeliveryReportSchema.safeParse(payload);
  if (!parsed.success) return Response.json({ error: "Invalid delivery report", details: parsed.error.flatten() }, { status: 400 });

  const client = createSupabaseServiceClient();
  let updated = 0;
  for (const acknowledgement of parsed.data.acknowledgements) {
    // Only pending rows move, so a replayed or late report can't flip a settled state.
    const { data, error } = await client
      .from("messages")
      .update({
        delivery_state: acknowledgement.status,
        ...(acknowledgement.providerMessageId ? { provider_message_id: acknowledgement.providerMessageId } : {}),
      })
      .eq("reply_action_id", acknowledgement.actionId)
      .eq("delivery_state", "pending")
      .select("id");
    if (error) {
      console.error("Delivery acknowledgement failed", { actionId: acknowledgement.actionId, code: error.code });
      return Response.json({ error: "Could not record delivery" }, { status: 500 });
    }
    updated += data.length;
    if (acknowledgement.status === "failed") {
      console.warn("Outbound action failed to deliver", { actionId: acknowledgement.actionId, errorCode: acknowledgement.errorCode });
      // If this was the support alert for a handoff, flag it; the chat stays paused either way.
      await client
        .from("handoffs")
        .update({ notification_error: acknowledgement.errorCode ?? "delivery_failed" })
        .eq("notification_action_id", acknowledgement.actionId)
        .is("notification_error", null);
    }
  }

  return Response.json({ updated });
}

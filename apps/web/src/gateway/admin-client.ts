import "server-only";
import { z } from "zod";
import { getGatewayAdminEnvironment } from "@/config/env";

const SessionSnapshotSchema = z.object({
  state: z.enum(["starting", "qr_pending", "authenticated", "ready", "disconnected", "error"]),
  qrDataUrl: z.string().startsWith("data:image/png;base64,").max(200_000).optional(),
  detail: z.string().max(500).optional(),
  phoneNumber: z.string().max(20).optional(),
  updatedAt: z.string().optional(),
  reconnectAttempts: z.number().optional(),
  pairingCode: z.string().max(20).optional(),
  // Health of the running session; older gateways don't send these.
  lastInboundAt: z.string().optional(),
  lastHealthCheckAt: z.string().optional(),
  healthy: z.boolean().optional(),
  recoveredMessages: z.number().int().nonnegative().optional(),
  lastAutoRestartAt: z.string().optional(),
  lastAutoRestartReason: z.string().max(200).optional(),
  ignoredSavedContacts: z.number().int().nonnegative().optional(),
  missedMessageCheck: z.boolean().optional(),
});
export type GatewaySession = z.infer<typeof SessionSnapshotSchema>;

export type GatewayResult<T> = { ok: true; data: T } | { ok: false; reason: "not_configured" | "unreachable" | "unauthorized" | "bad_response" };

async function callGateway(path: string, method: "GET" | "POST"): Promise<GatewayResult<unknown>> {
  const { GATEWAY_BASE_URL, GATEWAY_ADMIN_TOKEN } = getGatewayAdminEnvironment();
  if (!GATEWAY_BASE_URL || !GATEWAY_ADMIN_TOKEN) return { ok: false, reason: "not_configured" };
  try {
    const response = await fetch(`${GATEWAY_BASE_URL.replace(/\/$/, "")}${path}`, {
      method,
      headers: { authorization: `Bearer ${GATEWAY_ADMIN_TOKEN}` },
      cache: "no-store",
      signal: AbortSignal.timeout(6_000),
    });
    if (response.status === 401) return { ok: false, reason: "unauthorized" };
    if (!response.ok) return { ok: false, reason: "bad_response" };
    return { ok: true, data: await response.json() };
  } catch {
    return { ok: false, reason: "unreachable" };
  }
}

export async function getGatewaySession(): Promise<GatewayResult<GatewaySession>> {
  const result = await callGateway("/session", "GET");
  if (!result.ok) return result;
  const parsed = SessionSnapshotSchema.safeParse(result.data);
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, reason: "bad_response" };
}

export async function sendGatewayCommand(command: "logout" | "reinitialize"): Promise<GatewayResult<unknown>> {
  return callGateway(`/session/${command}`, "POST");
}

export type SendResult =
  | { ok: true; providerMessageId: string }
  // "unsure": WhatsApp may already have delivered it — never resend automatically.
  | { ok: false; reason: "not_configured" | "not_ready" | "rate_limited" | "unsure" | "rejected"; error: string };

// Sends a WhatsApp text from the shop's number (order updates). The gateway sends it once, never retries.
export async function sendGatewayMessage(chatId: string, text: string): Promise<SendResult> {
  const { GATEWAY_BASE_URL, GATEWAY_ADMIN_TOKEN } = getGatewayAdminEnvironment();
  if (!GATEWAY_BASE_URL || !GATEWAY_ADMIN_TOKEN) return { ok: false, reason: "not_configured", error: "The WhatsApp gateway isn't configured (GATEWAY_BASE_URL, GATEWAY_ADMIN_TOKEN)." };
  let response: Response;
  try {
    response = await fetch(`${GATEWAY_BASE_URL.replace(/\/$/, "")}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${GATEWAY_ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ chatId, text }),
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return { ok: false, reason: "unsure", error: "The gateway didn't answer; the message may or may not have been sent. Check WhatsApp before resending." };
  }
  const body = (await response.json().catch(() => ({}))) as { providerMessageId?: unknown };
  if (response.ok) return { ok: true, providerMessageId: typeof body.providerMessageId === "string" ? body.providerMessageId : "" };
  if (response.status === 503) return { ok: false, reason: "not_ready", error: "WhatsApp isn't connected right now. Nothing was sent." };
  if (response.status === 429) return { ok: false, reason: "rate_limited", error: "Too many messages in the last minute. Nothing was sent; try again shortly." };
  if (response.status === 502) return { ok: false, reason: "unsure", error: "Sending failed and may or may not have reached the customer. Check WhatsApp before resending." };
  return { ok: false, reason: "rejected", error: `The gateway refused the message (HTTP ${response.status}).` };
}

export async function requestGatewayPairingCode(phoneNumber: string): Promise<{ ok: true; code: string } | { ok: false; error: string }> {
  const { GATEWAY_BASE_URL, GATEWAY_ADMIN_TOKEN } = getGatewayAdminEnvironment();
  if (!GATEWAY_BASE_URL || !GATEWAY_ADMIN_TOKEN) return { ok: false, error: "Gateway is not configured." };
  try {
    const response = await fetch(`${GATEWAY_BASE_URL.replace(/\/$/, "")}/session/pairing-code`, {
      method: "POST",
      headers: { authorization: `Bearer ${GATEWAY_ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ phoneNumber }),
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await response.json().catch(() => ({}))) as { pairingCode?: string; error?: string };
    if (!response.ok || !body.pairingCode) return { ok: false, error: body.error ?? "Could not get a pairing code." };
    return { ok: true, code: body.pairingCode };
  } catch {
    return { ok: false, error: "The gateway is not reachable." };
  }
}

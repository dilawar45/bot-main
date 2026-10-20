"use server";

import { requireAdmin } from "@/auth/admin";
import { getGatewaySession, requestGatewayPairingCode, sendGatewayCommand, type GatewayResult, type GatewaySession } from "@/gateway/admin-client";

export async function refreshGatewaySession(): Promise<GatewayResult<GatewaySession>> {
  await requireAdmin();
  return getGatewaySession();
}

export async function runGatewayCommand(command: "logout" | "reinitialize"): Promise<{ ok: boolean; reason?: string }> {
  await requireAdmin();
  if (command !== "logout" && command !== "reinitialize") return { ok: false, reason: "bad_command" };
  const result = await sendGatewayCommand(command);
  return result.ok ? { ok: true } : { ok: false, reason: result.reason };
}

export async function requestPairingCode(phoneNumber: string): Promise<{ ok: true; code: string } | { ok: false; error: string }> {
  await requireAdmin();
  const digits = phoneNumber.replace(/\D/g, "").replace(/^0(?=3\d{9}$)/, "92");
  if (!/^[1-9]\d{7,14}$/.test(digits)) return { ok: false, error: "Enter the bot number with country code, e.g. 923001234567." };
  return requestGatewayPairingCode(digits);
}

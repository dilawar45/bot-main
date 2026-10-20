import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_MAX_AGE_SECONDS = 300;

export function createGatewaySignature(body: string, timestamp: string, secret: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export function verifyGatewaySignature(input: {
  body: string;
  timestamp: string | null;
  signature: string | null;
  secret: string;
  now?: Date;
}): boolean {
  const { body, timestamp, signature, secret, now = new Date() } = input;
  if (!timestamp || !signature || !/^\d+$/.test(timestamp) || !/^[a-f0-9]{64}$/i.test(signature)) {
    return false;
  }

  const ageSeconds = Math.abs(now.getTime() / 1_000 - Number(timestamp));
  if (!Number.isFinite(ageSeconds) || ageSeconds > SIGNATURE_MAX_AGE_SECONDS) {
    return false;
  }

  const expected = Buffer.from(createGatewaySignature(body, timestamp, secret), "hex");
  const supplied = Buffer.from(signature, "hex");
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}
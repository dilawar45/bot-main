import { describe, expect, it } from "vitest";
import { createGatewaySignature, verifyGatewaySignature } from "./gateway-signature";

const secret = "this-is-a-test-secret-with-32-characters";
const now = new Date("2026-09-28T12:00:00.000Z");
const timestamp = String(now.getTime() / 1_000);
const body = '{"messageId":"one"}';

describe("gateway signatures", () => {
  it("accepts a current signature", () => {
    expect(
      verifyGatewaySignature({
        body,
        timestamp,
        signature: createGatewaySignature(body, timestamp, secret),
        secret,
        now,
      }),
    ).toBe(true);
  });

  it("rejects tampered and stale requests", () => {
    const signature = createGatewaySignature(body, timestamp, secret);
    expect(verifyGatewaySignature({ body: `${body}x`, timestamp, signature, secret, now })).toBe(false);
    expect(
      verifyGatewaySignature({ body, timestamp, signature, secret, now: new Date("2026-09-28T12:06:00.000Z") }),
    ).toBe(false);
  });
});
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "./server.js";
import { NotSentError, type MessageHandler, type OwnerMessageHandler, type SessionSnapshot, type WhatsAppTransport } from "./transport.js";

const token = "t".repeat(40);
const transport: WhatsAppTransport = {
  async initialize() {},
  async destroy() {},
  async logout() {},
  async reinitialize() {},
  async requestPairingCode() {
    return "ABCD1234";
  },
  onMessage(_handler: MessageHandler) {},
  onOwnerMessage(_handler: OwnerMessageHandler) {},
  async sendText() {
    return "id";
  },
  async sendImage() {
    return "id";
  },
  async setTyping() {},
  getSessionSnapshot: (): SessionSnapshot => ({ state: "qr_pending", qrDataUrl: "data:image/png;base64,AAAA" }),
};

describe("gateway admin server", () => {
  it("requires the admin token for session details", async () => {
    const server = buildServer(transport, token, { logger: false });
    expect((await server.inject({ method: "GET", url: "/session" })).statusCode).toBe(401);
    expect((await server.inject({ method: "GET", url: "/session", headers: { authorization: "Bearer wrong" } })).statusCode).toBe(401);
    const ok = await server.inject({ method: "GET", url: "/session", headers: { authorization: `Bearer ${token}` } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ state: "qr_pending" });
    expect(ok.headers["cache-control"]).toBe("no-store");
  });

  it("reports readiness without exposing the QR", async () => {
    const server = buildServer(transport, token, { logger: false });
    const ready = await server.inject({ method: "GET", url: "/health/ready" });
    expect(ready.statusCode).toBe(503);
    expect(ready.body).not.toContain("base64");
  });

  it("is ready only while connected and passing its liveness checks; always live", async () => {
    const readiness = async (session: SessionSnapshot) => {
      const server = buildServer({ ...transport, getSessionSnapshot: () => session }, token, { logger: false });
      const [ready, live] = await Promise.all([server.inject({ method: "GET", url: "/health/ready" }), server.inject({ method: "GET", url: "/health/live" })]);
      expect(live.statusCode).toBe(200);
      return { status: ready.statusCode, body: ready.json() };
    };
    // Before the first check (just connected) and after a passing one.
    expect(await readiness({ state: "ready" })).toEqual({ status: 200, body: { status: "ready" } });
    expect(await readiness({ state: "ready", healthy: true })).toEqual({ status: 200, body: { status: "ready", healthy: true } });
    expect(await readiness({ state: "ready", healthy: false })).toEqual({ status: 503, body: { status: "ready", healthy: false } });
    expect(await readiness({ state: "disconnected", detail: "Restarting automatically: messages stopped arriving" })).toEqual({ status: 503, body: { status: "disconnected" } });
  });

  it("includes the session's health in the admin details", async () => {
    const session: SessionSnapshot = { state: "ready", healthy: true, lastHealthCheckAt: "2026-09-29T10:00:00.000Z", lastInboundAt: "2026-09-29T09:58:00.000Z", recoveredMessages: 3 };
    const server = buildServer({ ...transport, getSessionSnapshot: () => session }, token, { logger: false });
    const response = await server.inject({ method: "GET", url: "/session", headers: { authorization: `Bearer ${token}` } });
    expect(response.json()).toEqual(session);
  });
});

describe("pairing code", () => {
  it("validates the number and returns the code", async () => {
    const server = buildServer(transport, token, { logger: false });
    const headers = { authorization: `Bearer ${token}` };
    const bad = await server.inject({ method: "POST", url: "/session/pairing-code", headers, payload: { phoneNumber: "0300 123" } });
    expect(bad.statusCode).toBe(400);
    const ok = await server.inject({ method: "POST", url: "/session/pairing-code", headers, payload: { phoneNumber: "+92 300 1234567" } });
    expect(ok.json()).toEqual({ pairingCode: "ABCD1234" });
    expect((await server.inject({ method: "POST", url: "/session/pairing-code", payload: { phoneNumber: "923001234567" } })).statusCode).toBe(401);
  });
});

describe("admin messages", () => {
  const headers = { authorization: `Bearer ${token}` };
  const message = { chatId: "923001234567@c.us", text: "Your order #1042 has shipped." };

  // A linked session whose sends go through `send`.
  function linked(send: WhatsAppTransport["sendText"] = async () => "true_923001234567@c.us_3EB0") {
    const sendText = vi.fn(send);
    const server = buildServer({ ...transport, sendText, getSessionSnapshot: (): SessionSnapshot => ({ state: "ready" }) }, token, { logger: false });
    const post = (payload: unknown, requestHeaders: Record<string, string> = headers) =>
      server.inject({ method: "POST", url: "/messages", headers: requestHeaders, payload: payload as Record<string, unknown> });
    return { sendText, post };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("requires the admin token", async () => {
    const { sendText, post } = linked();
    expect((await post(message, {})).statusCode).toBe(401);
    expect((await post(message, { authorization: "Bearer wrong" })).statusCode).toBe(401);
    // Checked before the body is read: a stranger's malformed or huge body gets 401, not a format hint.
    expect((await post("{not json", { "content-type": "application/json" })).statusCode).toBe(401);
    expect((await post({ ...message, text: "a".repeat(20_000) }, {})).statusCode).toBe(401);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("rejects a bad chat id, empty text and text over 4000 characters", async () => {
    const { sendText, post } = linked();
    for (const payload of [
      { ...message, chatId: "12345@c.us" },
      { ...message, chatId: "923001234567@g.us" },
      { ...message, chatId: "923001234567" },
      { ...message, text: "   " },
      { ...message, text: "a".repeat(4_001) },
      { ...message, text: "a".repeat(20_000) },
      { chatId: message.chatId },
      "{not json",
    ]) {
      const response = await post(payload, { ...headers, "content-type": "application/json" });
      expect(response.statusCode, JSON.stringify(payload).slice(0, 60)).toBe(400);
      expect(response.json()).toEqual({ error: "invalid_request" });
    }
    expect(sendText).not.toHaveBeenCalled();
  });

  it("answers 503 without sending while WhatsApp is not linked", async () => {
    const sendText = vi.fn(async () => "id");
    const server = buildServer({ ...transport, sendText }, token, { logger: false });
    const response = await server.inject({ method: "POST", url: "/messages", headers, payload: message });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "not_ready" });
    expect(sendText).not.toHaveBeenCalled();
  });

  it("sends the trimmed text once and returns the WhatsApp message id", async () => {
    const { sendText, post } = linked();
    const response = await post({ chatId: "98100000000068@lid", text: "  Order confirmed ✅\nDelivery in 3 days  " });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ providerMessageId: "true_923001234567@c.us_3EB0" });
    expect(sendText).toHaveBeenCalledOnce();
    expect(sendText).toHaveBeenCalledWith("98100000000068@lid", "Order confirmed ✅\nDelivery in 3 days");
    expect((await post({ ...message, text: "a".repeat(4_000) })).statusCode).toBe(200);
  });

  it("answers 503 when WhatsApp refused before accepting the message", async () => {
    const { sendText, post } = linked(async () => {
      throw new NotSentError("WhatsApp not ready (disconnected)");
    });
    const response = await post(message);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "not_ready" });
    expect(sendText).toHaveBeenCalledOnce();
  });

  it("answers 502 for any other failure, without retrying", async () => {
    const { sendText, post } = linked(async () => {
      throw new Error("Evaluation failed: Target closed");
    });
    const response = await post(message);
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: "send_failed" });
    expect(sendText).toHaveBeenCalledOnce();
  });

  it("allows 30 sends per rolling minute", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-29T10:00:00.000Z"));
    const { sendText, post } = linked();
    for (let sent = 0; sent < 30; sent += 1) expect((await post(message)).statusCode).toBe(200);
    vi.setSystemTime(new Date("2026-09-29T10:00:59.000Z"));
    const limited = await post(message);
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ error: "rate_limited" });
    expect(sendText).toHaveBeenCalledTimes(30);

    vi.setSystemTime(new Date("2026-09-29T10:01:00.001Z"));
    expect((await post(message)).statusCode).toBe(200);
  });
});

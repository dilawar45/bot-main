import { createHash, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { redact } from "./processor.js";
import { NotSentError, type WhatsAppTransport } from "./transport.js";

const SendMessageSchema = z.object({
  chatId: z.string().regex(/^[0-9]{6,20}@(c\.us|lid)$/),
  text: z.string().trim().min(1).max(4_000),
});

// WhatsApp bans numbers that send in bursts; a runaway admin loop must not cost the shop its number.
const ADMIN_SENDS_PER_MINUTE = 30;

function sameToken(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  // Hash both sides so lengths match and comparison time doesn't leak the token.
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export function buildServer(transport: WhatsAppTransport, adminToken: string, options: { logger?: boolean } = {}) {
  // Request logging is off: the admin polls /session every few seconds and would flood the logs.
  const server = Fastify({ logger: options.logger ?? true, bodyLimit: 16 * 1024, disableRequestLogging: true });

  server.get("/health/live", async () => ({ status: "ok" }));
  // A session that says "ready" but failed its last liveness check delivers nothing, so it isn't ready either.
  server.get("/health/ready", async (_request, reply) => {
    const session = transport.getSessionSnapshot();
    const ready = session.state === "ready" && session.healthy !== false;
    return reply.code(ready ? 200 : 503).send({ status: session.state, healthy: session.healthy });
  });

  server.get("/session", { preHandler: authenticate }, async (_request, reply) => {
    void reply.header("cache-control", "no-store");
    return transport.getSessionSnapshot();
  });
  server.post("/session/reinitialize", { preHandler: authenticate }, async () => {
    void transport.reinitialize().catch((error: unknown) => server.log.error(error, "Reinitialize failed"));
    return { status: "reinitializing" };
  });
  server.post<{ Body: { phoneNumber?: unknown } }>("/session/pairing-code", { preHandler: authenticate }, async (request, reply) => {
    const phoneNumber = typeof request.body?.phoneNumber === "string" ? request.body.phoneNumber.replace(/\D/g, "") : "";
    if (!/^[1-9]\d{7,14}$/.test(phoneNumber)) return reply.code(400).send({ error: "Use the full number with country code, e.g. 923001234567" });
    try {
      return { pairingCode: await transport.requestPairingCode(phoneNumber) };
    } catch (error) {
      server.log.warn({ error: error instanceof Error ? error.message : String(error) }, "Pairing code request failed");
      return reply.code(409).send({ error: "WhatsApp is not waiting to be linked. Restart the session and try again." });
    }
  });
  server.post("/session/logout", { preHandler: authenticate }, async () => {
    void transport.logout().catch((error: unknown) => server.log.error(error, "Logout failed"));
    return { status: "logging_out" };
  });

  // The admin messages a customer, e.g. when an order is confirmed or shipped. Sent exactly once: retrying
  // after WhatsApp accepted the message would reach the customer twice. sendText also keeps the echo of this
  // message from being taken for the owner typing, which would pause the bot in that chat.
  const recentSends: number[] = [];
  // onRequest: the token is checked before the body is even read, so strangers learn nothing about the format.
  server.post("/messages", { onRequest: authenticate, bodyLimit: 16 * 1024, errorHandler: invalidRequest }, async (request, reply) => {
    const parsed = SendMessageSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const { chatId, text } = parsed.data;
    if (transport.getSessionSnapshot().state !== "ready") return reply.code(503).send({ error: "not_ready" });

    const now = Date.now();
    while (recentSends.length && recentSends[0]! <= now - 60_000) recentSends.shift();
    if (recentSends.length >= ADMIN_SENDS_PER_MINUTE) return reply.code(429).send({ error: "rate_limited" });
    recentSends.push(now);

    try {
      return { providerMessageId: await transport.sendText(chatId, text) };
    } catch (error) {
      const details = { chatId: redact(chatId), error: error instanceof Error ? error.message : String(error) };
      if (error instanceof NotSentError) {
        server.log.warn(details, "Admin message not sent");
        return reply.code(503).send({ error: "not_ready" });
      }
      server.log.error(details, "Admin message send failed");
      return reply.code(502).send({ error: "send_failed" });
    }
  });

  // Malformed JSON and oversized bodies fail before validation; answer them in the same shape.
  function invalidRequest(error: FastifyError, _request: FastifyRequest, reply: FastifyReply) {
    if (error.statusCode !== undefined && error.statusCode < 500) return reply.code(400).send({ error: "invalid_request" });
    throw error;
  }

  async function authenticate(request: FastifyRequest, reply: FastifyReply) {
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    // Async hooks must return the reply after sending, or Fastify waits for the route and the request hangs.
    if (!sameToken(token, adminToken)) return reply.code(401).send({ error: "Unauthorized" });
  }

  return server;
}

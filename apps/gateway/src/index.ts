import { BrainClient } from "./brain-client.js";
import { getGatewayEnvironment } from "./config.js";
import { startFollowUps } from "./followups.js";
import { MessageProcessor } from "./processor.js";
import { buildServer } from "./server.js";
import { WhatsAppWebTransport } from "./whatsapp-web.js";

const environment = getGatewayEnvironment();
const brainClient = new BrainClient({
  baseUrl: environment.BRAIN_BASE_URL.replace(/\/$/, ""),
  hmacSecret: environment.GATEWAY_HMAC_SECRET,
  timeoutMs: environment.WEBHOOK_TIMEOUT_MS,
});

// The transport needs a logger before the server exists, so start with a console shim and swap to pino once built.
let log = {
  info: (details: Record<string, unknown>, message: string) => console.log(message, details),
  warn: (details: Record<string, unknown>, message: string) => console.warn(message, details),
  error: (details: Record<string, unknown>, message: string) => console.error(message, details),
};
const transport = new WhatsAppWebTransport(
  environment.WHATSAPP_AUTH_PATH,
  { info: (d, m) => log.info(d, m), warn: (d, m) => log.warn(d, m), error: (d, m) => log.error(d, m) },
  environment.PUPPETEER_EXECUTABLE_PATH,
  environment.WHATSAPP_USER_AGENT,
  { ignoreSavedContacts: environment.IGNORE_SAVED_CONTACTS },
);
const server = buildServer(transport, environment.GATEWAY_ADMIN_TOKEN);
log = {
  info: (details, message) => server.log.info(details, message),
  warn: (details, message) => server.log.warn(details, message),
  error: (details, message) => server.log.error(details, message),
};

const processor = new MessageProcessor(transport, brainClient, {
  logger: log,
  mergeWindowMs: environment.MERGE_WINDOW_MS,
  mediaOrigin: new URL(environment.PRODUCT_MEDIA_ORIGIN).origin,
});
transport.onMessage((message) => processor.enqueue(message));
// The owner typing in a customer chat makes the brain pause the bot there (handoff).
transport.onOwnerMessage((message) => processor.reportOwnerMessage(message));
// Order reminders and notes to the owner, asked for every few minutes.
const followUps =
  environment.FOLLOWUP_INTERVAL_MS > 0 ? startFollowUps({ intervalMs: environment.FOLLOWUP_INTERVAL_MS, transport, brainClient, processor, logger: log }) : undefined;

let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  followUps?.stop();
  server.log.info({ signal }, "Shutting down");
  // Stop accepting HTTP, let queued chats finish (bounded), then close the browser so the session files are flushed.
  await server.close().catch(() => undefined);
  await Promise.race([processor.drain(), new Promise((resolve) => setTimeout(resolve, 20_000))]);
  await transport.destroy().catch(() => undefined);
  process.exit(0);
};
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
// Library timers (whatsapp-web.js's takeover, Puppeteer) can reject with nobody listening once the page is gone.
// That must not take the whole gateway down: the watchdog restarts the browser.
process.on("unhandledRejection", (reason) => log.error({ error: reason instanceof Error ? reason.message : String(reason) }, "Unhandled rejection"));

await server.listen({ port: environment.PORT, host: environment.HOST });
void transport.initialize().catch((error: unknown) => server.log.error(error, "WhatsApp initialization failed; retrying"));

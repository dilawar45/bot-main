import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import QRCode from "qrcode";
import pkg, { type Chat, type Contact, type Message } from "whatsapp-web.js";
import { fetchImage } from "./image-fetch.js";
import { phoneFromWid, serializeMessageId } from "./message-id.js";
import { RecentIds } from "./recent-ids.js";
import { SentRegistry } from "./sent-registry.js";
import {
  NotSentError,
  type GatewayMedia,
  type MessageHandler,
  type OwnerMessageHandler,
  type SessionHealth,
  type SessionSnapshot,
  type TransportMessage,
  type TransportOwnerMessage,
  type WhatsAppTransport,
} from "./transport.js";

const { Client, LocalAuth, MessageMedia } = pkg;
type WebClient = InstanceType<typeof Client>;

// Only plain text and photos reach the brain. Voice notes, stickers, video, documents etc. are ignored
// before any download, so large media never enters gateway memory.
const SUPPORTED_TYPES = new Set(["chat", "image"]);
// Anything the owner sends that a customer sees means a person is handling the chat, voice notes included.
const OWNER_PLACEHOLDERS: Record<string, string> = {
  ptt: "[voice note]",
  audio: "[audio]",
  video: "[video]",
  document: "[document]",
  sticker: "[sticker]",
  location: "[location]",
  vcard: "[contact]",
  multi_vcard: "[contact]",
};
const NON_CUSTOMER_CHAT = /@(g\.us|broadcast|newsletter)$/;
const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;
const RECONNECT_DELAYS_MS = [5_000, 15_000, 30_000, 60_000];
// Known whatsapp-web.js failure: a restored session reaches "authenticated" but never "ready"
// (seen after the process was killed without closing Chromium). A fresh browser on the same session fixes it.
const READY_WATCHDOG_MS = 120_000;
const MAX_STUCK_RESTARTS = 3;

// A session can stay "ready" while its page hangs or its socket never comes back. One failed check is often a
// blip (a slow page, the socket reconnecting); three in a row, about three minutes of trouble, is not.
const HEALTH_CHECK_INTERVAL_MS = 60_000;
const HEALTH_CHECK_TIMEOUT_MS = 20_000;
const MAX_FAILED_HEALTH_CHECKS = 3;
// Restarting can't fix an offline phone or a session WhatsApp revoked; past this the owner has to look.
const MAX_AUTO_RESTARTS_PER_HOUR = 6;
const AUTO_RESTART_WINDOW_MS = 60 * 60_000;
const GAVE_UP_DETAIL =
  `WhatsApp kept failing, so the gateway stopped restarting it after ${MAX_AUTO_RESTARTS_PER_HOUR} tries in an hour. ` +
  "Check that the bot's phone is online and still lists this device under Linked devices, then press Restart session. " +
  "If it still fails, unlink the number and link it again.";

// whatsapp-web.js only reports messages that arrive while its hooks work. What came in while the gateway was down,
// restarting or deaf is still unread in WhatsApp, so it's looked up and answered late. The first look waits a little
// after "ready" for WhatsApp to deliver what queued up offline (those may still come through as live events).
const CATCH_UP_DELAY_MS = 15_000;
// Customers who wrote longer ago than this have moved on; a reply now would only confuse them.
const CATCH_UP_WINDOW_MS = 6 * 60 * 60_000;
// No late replies at night (10pm–9am in Pakistan) to people who wrote hours ago; someone who wrote within the last
// hour is probably still up. The first scans of the morning (until noon) also answer what came in overnight.
const NIGHT_CATCH_UP_MS = 60 * 60_000;
// When the number was linked by QR or pairing code (stored next to the session): chats from before that are the
// phone's own history, never answered by the bot.
const LINKED_AT_FILE = "linked-at";
const CATCH_UP_MAX_CHATS = 15;
const CATCH_UP_MAX_MESSAGES = 10;
// A backlog is answered one chat at a time, each given this long, so it doesn't hit the brain all at once.
const CATCH_UP_ANSWER_WAIT_MS = 60_000;
const CHAT_LIST_TIMEOUT_MS = 30_000;
// In-page lookup of the chats with unread messages: id (WhatsApp Web renamed `_serialized` to `$1` in 2026) and the
// last activity time, nothing else.
const UNREAD_CHATS_SCRIPT = `window.require("WAWebCollections").Chat.getModelsArray()
  .filter((chat) => chat.unreadCount > 0 && chat.id)
  .map((chat) => ({ id: chat.id._serialized || chat.id.$1, t: chat.t || 0 }))`;
type UnreadChat = { id: string; t: number };
// Silent stall: the session looks connected but stops reporting messages (2026-09-29). Live messages arrive
// within seconds, so unread ones this old that never came through mean the hooks are broken.
const STALL_CHECK_INTERVAL_MS = 5 * 60_000;
const STALL_MIN_AGE_MS = 2 * 60_000;
const STALL_RESTART_COOLDOWN_MS = 10 * 60_000;
const RECEIVED_IDS_LIMIT = 2_000;
// The owner often types several messages in a row in the same chat.
const SAVED_CONTACT_CACHE_MS = 10 * 60_000;

export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

export type TransportLogger = {
  info(details: Record<string, unknown>, message: string): void;
  warn(details: Record<string, unknown>, message: string): void;
  error(details: Record<string, unknown>, message: string): void;
};

export type WhatsAppWebOptions = {
  // The bot's number doubles as someone's personal WhatsApp: chats with contacts saved in its address book are
  // private. Their messages are never handed over, and what the owner types there is never reported.
  ignoreSavedContacts?: boolean;
};

// What a catch-up waits for: whether a message reached the handlers, and their work on it (the answer).
type Handover = { handedOver: boolean; answered: Promise<unknown> };
const NOT_HANDED_OVER: Handover = { handedOver: false, answered: Promise.resolve() };

// The bits of Puppeteer's page and browser the gateway listens to (typed loosely, like teardown's process()).
type BrowserEvents = { once(event: string, listener: () => void): unknown };

export class WhatsAppWebTransport implements WhatsAppTransport {
  private readonly handlers = new Set<MessageHandler>();
  private readonly ownerHandlers = new Set<OwnerMessageHandler>();
  private readonly sentRegistry = new SentRegistry();
  private snapshot: SessionSnapshot = { state: "starting", updatedAt: new Date().toISOString() };
  private readonly health: SessionHealth;
  private client: WebClient;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private shuttingDown = false;
  private restarting = false;
  // Bumped for every new client; events from a replaced client are ignored so they can't overwrite the status.
  private generation = 0;
  private readyWatchdog: NodeJS.Timeout | undefined;
  private stuckRestarts = 0;
  // Per chat, the preparation of the latest incoming message (keeps arrival order).
  private readonly incomingChains = new Map<string, Promise<void>>();
  // Customer messages already handed over, live or by a catch-up: neither path may hand one over again.
  private readonly receivedIds = new RecentIds(RECEIVED_IDS_LIMIT);
  // Monitoring while ready (see startMonitoring).
  private catchUpTimer: NodeJS.Timeout | undefined;
  private healthTimer: NodeJS.Timeout | undefined;
  private stallTimer: NodeJS.Timeout | undefined;
  private failedHealthChecks = 0;
  // Since when the socket has been up without a gap: from then on, every message should be reported live.
  private connectedSince = 0;
  private scanningGeneration: number | undefined;
  private lastStallRestartAt = Number.NEGATIVE_INFINITY;
  // When the gateway restarted the browser on its own during the last hour.
  private autoRestarts: number[] = [];
  // Chat id -> whether it belongs to a contact saved in the phone, from a recent lookup.
  private readonly savedContacts = new Map<string, { saved: boolean; until: number }>();
  private contactLookupFailing = false;
  // When this number was linked (0 when unknown, e.g. linked before this was recorded), and whether a QR is up now.
  private linkedAt: number;
  private linking = false;

  constructor(
    private readonly authPath: string,
    private readonly logger: TransportLogger,
    private readonly chromiumPath?: string,
    private readonly userAgent: string = DEFAULT_USER_AGENT,
    private readonly options: WhatsAppWebOptions = {},
  ) {
    this.health = { recoveredMessages: 0, ...(options.ignoreSavedContacts ? { ignoredSavedContacts: 0 } : {}) };
    this.linkedAt = readLinkedAt(authPath);
    this.client = this.createClient();
  }

  // Alternative to the QR: WhatsApp shows "Link with phone number instead"; this returns the 8-character code to type there.
  async requestPairingCode(phoneNumber: string): Promise<string> {
    if (this.snapshot.state !== "qr_pending") throw new Error(`Pairing is only possible while waiting to link (now ${this.snapshot.state})`);
    const code = await this.client.requestPairingCode(phoneNumber, true);
    this.setSnapshot({ ...this.snapshot, state: "qr_pending", pairingCode: code });
    return code;
  }

  private setSnapshot(next: Omit<SessionSnapshot, "updatedAt" | "reconnectAttempts">) {
    this.snapshot = { ...next, updatedAt: new Date().toISOString(), reconnectAttempts: this.reconnectAttempts };
  }

  private createClient(): WebClient {
    const generation = ++this.generation;
    const current = () => generation === this.generation;
    const client = new Client({
      authStrategy: new LocalAuth({ dataPath: this.authPath }),
      // The library default claims Chrome 101 on macOS 10.14; WhatsApp refuses to link such outdated browsers.
      userAgent: this.userAgent,
      // CONFLICT means another browser opened this same linked-device session (a leftover Chromium, an overlapping
      // deploy). By default whatsapp-web.js then disconnects and the gateway relaunches Chromium; taking the session
      // back in place is quicker. The delay gives a brief overlap the chance to end on its own first.
      takeoverOnConflict: true,
      takeoverTimeoutMs: 10_000,
      puppeteer: {
        headless: true,
        executablePath: this.chromiumPath,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--no-zygote"],
      },
    });

    client.on("qr", async (qr) => {
      // Asked for a QR: this session isn't linked yet, so whatever is ready next is a fresh link.
      if (current()) this.linking = true;
      const qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
      // Scanned while the image was being drawn: a late QR must not hide the login that already happened.
      if (!current() || this.snapshot.state === "authenticated" || this.snapshot.state === "ready") return;
      this.setSnapshot({ state: "qr_pending", qrDataUrl, pairingCode: this.snapshot.pairingCode });
    });
    client.on("authenticated", () => {
      if (!current()) return;
      this.stopMonitoring();
      this.setSnapshot({ state: "authenticated" });
      if (!this.readyWatchdog) this.readyWatchdog = setTimeout(() => this.onReadyTimeout(generation), READY_WATCHDOG_MS);
    });
    client.on("ready", () => {
      if (!current()) return;
      clearTimeout(this.readyWatchdog);
      this.readyWatchdog = undefined;
      this.stuckRestarts = 0;
      this.reconnectAttempts = 0;
      this.setSnapshot({ state: "ready", phoneNumber: client.info?.wid?.user });
      this.logger.info({}, "WhatsApp session ready");
      if (this.linking) {
        this.linking = false;
        this.linkedAt = Date.now();
        this.saveLinkedAt();
      }
      this.startMonitoring(generation);
    });
    client.on("auth_failure", (detail) => {
      if (!current()) return;
      this.stopMonitoring();
      this.setSnapshot({ state: "error", detail: `Authentication failed: ${detail}` });
      this.logger.error({ detail }, "WhatsApp authentication failed");
    });
    client.on("disconnected", (reason) => {
      if (!current()) return;
      this.stopMonitoring();
      this.setSnapshot({ state: "disconnected", detail: String(reason) });
      this.logger.warn({ reason: String(reason) }, "WhatsApp disconnected");
      this.scheduleReconnect();
    });
    client.on("change_state", (state) => {
      if (current() && state === "CONNECTED") this.onReconnected(generation);
    });
    client.on("message", (message) => {
      if (!current()) return;
      if (isCustomerChatMessage(message)) this.health.lastInboundAt = new Date().toISOString();
      // A catch-up may have handed this one over already.
      if (this.markReceived(message)) void this.receive(message);
    });
    // Fires for every message this account sends, from the gateway or from the owner's phone and other devices.
    client.on("message_create", (message) => {
      if (!current() || !message.fromMe) return;
      void this.handleOwnMessage(message).catch((error: unknown) => this.logger.error({ error: errorMessage(error) }, "Owner message handling failed"));
    });
    return client;
  }

  private async handleOwnMessage(message: Message): Promise<void> {
    const chatId = message.to;
    const placeholder = OWNER_PLACEHOLDERS[message.type];
    if ((!SUPPORTED_TYPES.has(message.type) && !placeholder) || !chatId || NON_CUSTOMER_CHAT.test(chatId)) return;
    const id = serializeMessageId(message.id);
    if (!id) return;
    const body = message.type === "chat" || message.type === "image" ? (message.body ?? "") : "";
    if (this.sentRegistry.isOwnSend(id, [chatId], body)) return;
    const alternateChatIds = await this.resolveAlternateChatIds(chatId);
    // WhatsApp can file our own send under the contact's other id; checked after the lookup, by which time
    // the send has usually returned its id as well.
    if (this.sentRegistry.isOwnSend(id, alternateChatIds, body)) return;
    if (this.options.ignoreSavedContacts && (await this.isSavedContactChat([chatId, ...alternateChatIds]))) return;

    const ownerMessage: TransportOwnerMessage = {
      id,
      chatId,
      alternateChatIds,
      occurredAt: occurredAt(message),
      type: message.type === "image" ? "image" : "text",
      text: body || placeholder || undefined,
    };
    await Promise.allSettled([...this.ownerHandlers].map((handler) => handler(ownerMessage)));
  }

  // Only successful lookups are cached: a missed alternate id can make the brain miss the owner's takeover.
  private readonly alternatesByChat = new Map<string, string[]>();
  private async resolveAlternateChatIds(chatId: string): Promise<string[]> {
    const cached = this.alternatesByChat.get(chatId);
    if (cached) return cached;
    if (!/@(c\.us|lid)$/.test(chatId)) return [];
    const [mapping] = await withTimeout(this.client.getContactLidAndPhone([chatId]), PAGE_CALL_TIMEOUT_MS, []);
    const alternates = [mapping?.lid, mapping?.pn].filter((wid): wid is string => typeof wid === "string" && wid !== "" && wid !== chatId);
    if (alternates.length) {
      if (this.alternatesByChat.size > 5_000) this.alternatesByChat.clear();
      this.alternatesByChat.set(chatId, alternates);
    }
    return alternates;
  }

  // Remembers a customer message as handed over; false when it already was.
  private markReceived(message: Message): boolean {
    const id = serializeMessageId(message.id);
    if (!id || !isCustomerChatMessage(message)) return true;
    return this.receivedIds.add(id);
  }

  // Preparing a message (photo download, contact lookup) takes varying time; chaining per chat keeps a slow photo
  // from being overtaken by the text sent right after it.
  private receive(message: Message): Promise<Handover> {
    const key = message.from;
    const previous = this.incomingChains.get(key) ?? Promise.resolve();
    const handover = previous
      .then(() => this.handleIncoming(message))
      .catch((error: unknown) => {
        this.logger.error({ error: errorMessage(error) }, "Incoming message handling failed");
        return NOT_HANDED_OVER;
      });
    const next: Promise<void> = handover
      .then(() => undefined)
      .finally(() => {
        if (this.incomingChains.get(key) === next) this.incomingChains.delete(key);
      });
    this.incomingChains.set(key, next);
    return handover;
  }

  private async handleIncoming(message: Message): Promise<Handover> {
    if (message.fromMe || !SUPPORTED_TYPES.has(message.type) || NON_CUSTOMER_CHAT.test(message.from)) return NOT_HANDED_OVER;
    const id = serializeMessageId(message.id);
    if (!id) {
      this.logger.warn({ type: message.type }, "Incoming message without a usable id ignored");
      return NOT_HANDED_OVER;
    }
    const contact = await withTimeout(message.getContact(), PAGE_CALL_TIMEOUT_MS, undefined);
    // Checked before any photo download: a personal contact's photo never enters gateway memory.
    if (this.options.ignoreSavedContacts) {
      this.rememberSavedContact(message.from, contact);
      // Unknown counts as saved (a failed or hung lookup, usually a stuck page): answering a friend, and storing
      // their message, is worse than leaving one customer's message for the owner to see on the phone.
      if (this.savedContactStatus([message.from]) !== false) {
        this.health.ignoredSavedContacts = (this.health.ignoredSavedContacts ?? 0) + 1;
        return NOT_HANDED_OVER;
      }
    }

    const transportMessage: TransportMessage = {
      id,
      // Always reply to the id WhatsApp gave us (it may be a privacy "@lid" id rather than a phone number).
      chatId: message.from,
      phoneNumber: await this.resolvePhoneNumber(message.from),
      displayName: contact?.pushname || contact?.name || undefined,
      occurredAt: occurredAt(message),
      fromMe: false,
      isGroup: false,
      text: message.body || undefined,
      media: message.type === "image" && message.hasMedia ? await downloadPhoto(message) : undefined,
    };
    // Hand over without waiting for the answer: the per-chat chain only orders preparation, and waiting here
    // would hold the next message back until this whole turn was answered (no burst merging).
    const answered = Promise.all(
      [...this.handlers].map((handler) => handler(transportMessage).catch((error: unknown) => this.logger.error({ error: errorMessage(error) }, "Message handler failed"))),
    );
    return { handedOver: true, answered };
  }

  // WhatsApp increasingly hides numbers behind "@lid" ids. Look the real number up (cached) so the owner
  // gets a tap-to-chat link and a visible number; never required for replying.
  private readonly phoneByLid = new Map<string, string | undefined>();
  private async resolvePhoneNumber(chatId: string): Promise<string | undefined> {
    const direct = phoneFromWid(chatId);
    if (direct || !chatId.endsWith("@lid")) return direct;
    if (this.phoneByLid.has(chatId)) return this.phoneByLid.get(chatId);
    const lookup = await withTimeout(
      this.client.getContactLidAndPhone([chatId]).then((mappings) => ({ mappings })),
      PAGE_CALL_TIMEOUT_MS,
      null,
    );
    // A lookup that failed or hung isn't an answer: try again with the next message instead of caching "no number".
    if (!lookup) return undefined;
    const phone = phoneFromWid(lookup.mappings[0]?.pn);
    if (this.phoneByLid.size > 5_000) this.phoneByLid.clear();
    this.phoneByLid.set(chatId, phone);
    return phone;
  }

  // Whether any of a chat's ids belongs to a saved contact, looking it up when nothing recent is known.
  private async isSavedContactChat(chatIds: readonly string[]): Promise<boolean> {
    const known = this.savedContactStatus(chatIds);
    if (known !== undefined) return known;
    const contact = await withTimeout(this.client.getContactById(chatIds[0]!), PAGE_CALL_TIMEOUT_MS, undefined);
    this.rememberSavedContact(chatIds[0]!, contact);
    return contact?.isMyContact === true;
  }

  // Saved if any id is known as saved; undefined when none is known.
  private savedContactStatus(chatIds: readonly string[]): boolean | undefined {
    let status: boolean | undefined;
    for (const chatId of chatIds) {
      const entry = this.savedContacts.get(chatId);
      if (!entry || entry.until <= Date.now()) continue;
      if (entry.saved) return true;
      status = false;
    }
    return status;
  }

  // A failed lookup isn't cached. Incoming messages then count as saved (left alone), the owner's as not saved
  // (still reported, so the bot can't talk over them).
  // Kept next to the session files (the persistent volume), so a restart still knows where the bot's history begins.
  private saveLinkedAt(): void {
    try {
      mkdirSync(this.authPath, { recursive: true });
      writeFileSync(join(this.authPath, LINKED_AT_FILE), String(this.linkedAt));
    } catch (error) {
      this.logger.warn({ error: errorMessage(error) }, "Could not record when WhatsApp was linked");
    }
  }

  private rememberSavedContact(chatId: string, contact: Contact | undefined): void {
    if (!contact) {
      if (!this.contactLookupFailing) this.logger.warn({}, "Contact lookup failed: incoming messages are left alone, the owner's are still reported");
      this.contactLookupFailing = true;
      return;
    }
    this.contactLookupFailing = false;
    if (this.savedContacts.size > 5_000) this.savedContacts.clear();
    this.savedContacts.set(chatId, { saved: contact.isMyContact === true, until: Date.now() + SAVED_CONTACT_CACHE_MS });
  }

  private onReadyTimeout(generation: number) {
    this.readyWatchdog = undefined;
    if (generation !== this.generation || this.snapshot.state !== "authenticated" || this.shuttingDown) return;
    this.stuckRestarts += 1;
    if (this.stuckRestarts > MAX_STUCK_RESTARTS) {
      this.setSnapshot({ state: "error", detail: "WhatsApp stays stuck after login. Unlink the number and scan a new QR code." });
      this.logger.error({ attempts: this.stuckRestarts - 1 }, "WhatsApp session restore keeps failing; relink required");
      return;
    }
    this.logger.warn({ attempt: this.stuckRestarts }, "WhatsApp stuck after authentication; restarting browser");
    void this.restart().catch((error: unknown) => this.logger.error({ error: errorMessage(error) }, "Restart after stuck login failed"));
  }

  private scheduleReconnect() {
    if (this.shuttingDown || this.restarting || this.reconnectTimer) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempts, RECONNECT_DELAYS_MS.length - 1)]!;
    this.reconnectAttempts += 1;
    this.logger.info({ delayMs: delay, attempt: this.reconnectAttempts }, "Scheduling WhatsApp reconnect");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.restart().catch((error: unknown) => {
        this.logger.error({ error: errorMessage(error) }, "WhatsApp reconnect failed");
        this.scheduleReconnect();
      });
    }, delay);
  }

  // While ready: one catch-up shortly after (whatever arrived while the session wasn't), liveness checks, and
  // periodic scans for messages that never came through. Monitoring alone must never keep the process alive.
  private startMonitoring(generation: number): void {
    this.stopMonitoring();
    this.connectedSince = Date.now();
    this.scheduleCatchUp(generation);
    this.healthTimer = setInterval(this.monitor(() => this.checkHealth(generation)), HEALTH_CHECK_INTERVAL_MS).unref();
    this.stallTimer = setInterval(this.monitor(() => this.catchUp(generation)), STALL_CHECK_INTERVAL_MS).unref();
  }

  private scheduleCatchUp(generation: number): void {
    clearTimeout(this.catchUpTimer);
    this.catchUpTimer = setTimeout(this.monitor(() => this.catchUp(generation)), CATCH_UP_DELAY_MS).unref();
  }

  private monitor(task: () => Promise<void>): () => void {
    return () => void task().catch((error: unknown) => this.logger.error({ error: errorMessage(error) }, "WhatsApp session monitoring failed"));
  }

  // The socket dropped and came back while ready, which is as good as a passing check. Messages that arrived in
  // between may never be reported without the hooks being broken: look for them soon, and count only later
  // ones as a stall.
  private onReconnected(generation: number): void {
    if (!this.isLive(generation)) return;
    this.failedHealthChecks = 0;
    this.health.healthy = true;
    this.health.lastHealthCheckAt = new Date().toISOString();
    this.connectedSince = Date.now();
    this.scheduleCatchUp(generation);
  }

  private stopMonitoring(): void {
    clearTimeout(this.catchUpTimer);
    clearInterval(this.healthTimer);
    clearInterval(this.stallTimer);
    this.catchUpTimer = undefined;
    this.healthTimer = undefined;
    this.stallTimer = undefined;
    this.failedHealthChecks = 0;
    this.health.healthy = undefined;
  }

  private isLive(generation: number): boolean {
    return generation === this.generation && this.snapshot.state === "ready" && !this.shuttingDown;
  }

  private async checkHealth(generation: number): Promise<void> {
    if (!this.isLive(generation)) return;
    // A hung page never answers, so running out of time is a failure too.
    const state = await withTimeout(
      this.client.getState().then(String, (error: unknown) => `error: ${errorMessage(error)}`),
      HEALTH_CHECK_TIMEOUT_MS,
      "no answer",
    );
    if (!this.isLive(generation)) return;
    const healthy = state === "CONNECTED";
    this.health.lastHealthCheckAt = new Date().toISOString();
    this.health.healthy = healthy;
    if (healthy) {
      if (this.failedHealthChecks) this.logger.info({ failedChecks: this.failedHealthChecks }, "WhatsApp responding again");
      this.failedHealthChecks = 0;
      return;
    }
    this.failedHealthChecks += 1;
    this.logger.warn({ state, failedChecks: this.failedHealthChecks }, "WhatsApp health check failed");
    if (this.failedHealthChecks >= MAX_FAILED_HEALTH_CHECKS) this.restartAutomatically(generation, "WhatsApp Web stopped responding", { state });
  }

  // A crashed page or browser doesn't always make whatsapp-web.js report a disconnect: the status would say
  // "ready" while nothing arrives.
  private watchBrowser(client: WebClient, generation: number): void {
    const { pupPage, pupBrowser } = client as unknown as { pupPage?: BrowserEvents | null; pupBrowser?: BrowserEvents | null };
    pupPage?.once("error", () => this.onBrowserDied(generation, "the WhatsApp page crashed"));
    pupPage?.once("close", () => this.onBrowserDied(generation, "the WhatsApp page closed"));
    pupBrowser?.once("disconnected", () => this.onBrowserDied(generation, "the browser closed"));
  }

  private onBrowserDied(generation: number, reason: string): void {
    // While starting, initialize() handles failures; once disconnected, a reconnect replaces the browser anyway.
    const state = this.snapshot.state;
    if (state !== "ready" && state !== "authenticated" && state !== "qr_pending") return;
    this.restartAutomatically(generation, reason);
  }

  // Restarts the browser on the same session files: never a logout, so no new QR is needed.
  private restartAutomatically(generation: number, reason: string, details: Record<string, unknown> = {}): void {
    if (generation !== this.generation || this.shuttingDown || this.restarting || this.reconnectTimer) return;
    this.stopMonitoring();
    const now = Date.now();
    this.autoRestarts = this.autoRestarts.filter((at) => at > now - AUTO_RESTART_WINDOW_MS);
    if (this.autoRestarts.length >= MAX_AUTO_RESTARTS_PER_HOUR) {
      this.setSnapshot({ state: "error", detail: GAVE_UP_DETAIL });
      this.logger.error({ reason, ...details, restarts: this.autoRestarts.length }, "WhatsApp keeps failing; automatic restarts stopped");
      return;
    }
    this.autoRestarts.push(now);
    this.health.lastAutoRestartAt = new Date(now).toISOString();
    this.health.lastAutoRestartReason = reason;
    this.logger.warn({ reason, ...details, restartsThisHour: this.autoRestarts.length }, "Restarting WhatsApp browser on the same session");
    this.setSnapshot({ state: "disconnected", detail: `Restarting automatically: ${reason}` });
    void this.restart().catch((error: unknown) => this.logger.error({ error: errorMessage(error) }, "Automatic WhatsApp restart failed"));
  }

  // Hands over customer messages WhatsApp never reported live. Doubles as the stall detector: unread messages that
  // arrived while the session was connected, yet never came through, mean its hooks are broken.
  private async catchUp(generation: number): Promise<void> {
    // An unresponsive page can't be scanned; the liveness check deals with it.
    if (!this.isLive(generation) || this.health.healthy === false || this.scanningGeneration === generation) return;
    this.scanningGeneration = generation;
    try {
      const missed = await this.findMissedMessages();
      if (!missed?.length || !this.isLive(generation)) return;
      const now = Date.now();
      const messages = missed.flat();
      const stalled = messages.filter((message) => message.timestamp * 1_000 > this.connectedSince && now - message.timestamp * 1_000 >= STALL_MIN_AGE_MS).length;
      const details = { chats: missed.length, messages: messages.length, stalled };
      if (stalled) this.logger.warn(details, "WhatsApp stopped reporting incoming messages; answering the missed ones");
      else this.logger.info(details, "Answering customer messages that arrived while WhatsApp was offline");
      for (const chatMessages of missed) {
        if (!this.isLive(generation)) return;
        await this.recover(chatMessages);
      }
      if (!stalled || !this.isLive(generation)) return;
      // A restart that didn't help must not turn into a restart every few minutes.
      if (now - this.lastStallRestartAt < STALL_RESTART_COOLDOWN_MS) {
        this.logger.warn(details, "Messages still not coming through; not restarting again so soon");
        return;
      }
      this.lastStallRestartAt = now;
      this.restartAutomatically(generation, "messages stopped arriving", details);
    } finally {
      if (this.scanningGeneration === generation) this.scanningGeneration = undefined;
    }
  }

  // Per waiting customer chat (longest-waiting first), the unread messages that were never handed over.
  private async findMissedMessages(): Promise<Message[][] | undefined> {
    const chats = await this.chatsWithUnread();
    if (!chats) {
      if (this.health.missedMessageCheck !== false) this.logger.warn({}, "Could not list WhatsApp chats to look for missed messages");
      this.health.missedMessageCheck = false;
      return undefined;
    }
    this.health.missedMessageCheck = true;
    const since = Math.max(catchUpSince(Date.now()), this.linkedAt);
    const missed: Message[][] = [];
    for (const chat of waitingChats(chats, since, this.receivedIds)) {
      const latest = await withTimeout(chat.fetchMessages({ limit: Math.min(chat.unreadCount, CATCH_UP_MAX_MESSAGES) }), PAGE_CALL_TIMEOUT_MS, []);
      const messages = unanswered(latest, since, this.receivedIds);
      if (messages.length) missed.push(messages);
    }
    return missed;
  }

  // Chats with unread messages, the longest-waiting first. getChats() builds every chat in full (group details, the
  // last message fetched from WhatsApp's servers), which on a number with hundreds of chats takes longer than a scan
  // may wait; so WhatsApp Web is asked for the unread ones only, and just those are loaded.
  private async chatsWithUnread(): Promise<Chat[] | undefined> {
    const page = (this.client as unknown as { pupPage?: { evaluate?(script: string): Promise<unknown> } | null }).pupPage;
    if (!page?.evaluate) return withTimeout(this.client.getChats(), CHAT_LIST_TIMEOUT_MS, undefined);
    // A string, not a function: it runs as written in the page, untouched by the TypeScript build.
    const unread = await withTimeout(page.evaluate(UNREAD_CHATS_SCRIPT).then((found) => (Array.isArray(found) ? (found as UnreadChat[]) : undefined)), PAGE_CALL_TIMEOUT_MS, undefined);
    if (!unread) return undefined;
    const ids = unread
      .filter((chat) => typeof chat.id === "string" && !NON_CUSTOMER_CHAT.test(chat.id))
      .sort((a, b) => a.t - b.t)
      .slice(0, CATCH_UP_MAX_CHATS)
      .map((chat) => chat.id);
    const chats = await Promise.all(ids.map((id) => withTimeout(this.client.getChatById(id), PAGE_CALL_TIMEOUT_MS, undefined)));
    return chats.filter((chat): chat is Chat => chat !== undefined);
  }

  // Hands one chat's missed messages over through the live path, in order, then waits (bounded) for the answer.
  private async recover(messages: readonly Message[]): Promise<void> {
    const handovers = messages
      .filter((message) => this.markReceived(message))
      .map(async (message) => {
        const { handedOver, answered } = await this.receive(message);
        if (handedOver) this.health.recoveredMessages = (this.health.recoveredMessages ?? 0) + 1;
        await answered;
      });
    await withTimeout(Promise.all(handovers).then(() => undefined), CATCH_UP_ANSWER_WAIT_MS, undefined);
  }

  async initialize(): Promise<void> {
    this.setSnapshot({ state: "starting" });
    const client = this.client;
    const generation = this.generation;
    try {
      await client.initialize();
    } catch (error) {
      // A half-initialized client can still show a QR that will never link (e.g. WhatsApp reloaded the page
      // mid-injection: "detached Frame"). Throw it away and start clean.
      const detail = errorMessage(error);
      this.logger.error({ detail }, "WhatsApp client failed to start; will retry with a fresh browser");
      if (client === this.client) {
        this.generation += 1;
        await this.teardown(client);
        this.setSnapshot({ state: "error", detail });
        this.scheduleReconnect();
      }
      throw error;
    }
    // The page and browser exist only once initialize() has run.
    if (generation === this.generation) this.watchBrowser(client, generation);
  }

  // The owner asked for a restart, which also gives automatic restarts a fresh budget.
  async reinitialize(): Promise<void> {
    this.autoRestarts = [];
    await this.restart();
  }

  // Tears down the browser and starts a fresh client on the same session (a new QR only if WhatsApp logged it out).
  private async restart(): Promise<void> {
    if (this.restarting) return;
    this.restarting = true;
    try {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
      this.generation += 1;
      await this.teardown(this.client);
      this.client = this.createClient();
    } finally {
      this.restarting = false;
    }
    await this.initialize();
  }

  async destroy(): Promise<void> {
    this.shuttingDown = true;
    clearTimeout(this.reconnectTimer);
    await this.teardown(this.client);
  }

  // Close the browser for certain. Two Chromiums on the same session folder crash each other ("Target closed").
  private async teardown(client: WebClient): Promise<void> {
    clearTimeout(this.readyWatchdog);
    this.readyWatchdog = undefined;
    this.stopMonitoring();
    await Promise.race([client.destroy().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 15_000))]);
    const browserProcess = (client as unknown as { pupBrowser?: { process(): { exitCode: number | null; kill(signal: string): boolean } | null } }).pupBrowser?.process();
    if (browserProcess && browserProcess.exitCode === null) browserProcess.kill("SIGKILL");
    // Give Chromium a moment to release its profile lock before a new one starts.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }

  async logout(): Promise<void> {
    this.restarting = true;
    try {
      await this.client.logout();
    } finally {
      this.restarting = false;
    }
    this.setSnapshot({ state: "disconnected", detail: "Logged out" });
    // Start again so a new QR is available for relinking.
    await this.reinitialize();
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.add(handler);
  }

  onOwnerMessage(handler: OwnerMessageHandler): void {
    this.ownerHandlers.add(handler);
  }

  async sendText(chatId: string, text: string): Promise<string> {
    if (this.snapshot.state !== "ready") throw new NotSentError(`WhatsApp not ready (${this.snapshot.state})`);
    this.sentRegistry.expect(chatId, text);
    return this.sentId(await this.client.sendMessage(chatId, text));
  }

  async sendImage(chatId: string, url: string, caption?: string): Promise<string> {
    if (this.snapshot.state !== "ready") throw new NotSentError(`WhatsApp not ready (${this.snapshot.state})`);
    const image = await fetchImage(url).catch((error: unknown) => {
      throw new NotSentError(`Photo download failed: ${errorMessage(error)}`);
    });
    const media = new MessageMedia(image.mimeType, image.dataBase64, image.fileName);
    this.sentRegistry.expect(chatId, caption ?? "");
    return this.sentId(await this.client.sendMessage(chatId, media, caption ? { caption } : {}));
  }

  // Never throw after a successful send: the caller would retry and the customer would get the message twice.
  private sentId(sent: Message | undefined): string {
    const id = serializeMessageId(sent?.id) ?? "";
    if (id) this.sentRegistry.remember(id);
    return id;
  }

  async setTyping(chatId: string, typing: boolean): Promise<void> {
    if (this.snapshot.state !== "ready") return;
    try {
      // Typed as always resolving a chat, but yields undefined for unknown ids.
      const chat: Chat | undefined = await this.client.getChatById(chatId);
      if (typing) await chat?.sendStateTyping();
      else await chat?.clearState();
    } catch {
      // Cosmetic only; a reply must never wait on or fail because of the typing indicator.
    }
  }

  getSessionSnapshot(): SessionSnapshot {
    return { ...this.snapshot, ...this.health };
  }
}

// Page calls (contact lookup, photo download) that hang would otherwise hold the chat's later messages until
// Puppeteer's own 180 s protocol timeout. A failure or timeout resolves to `fallback`.
const PAGE_CALL_TIMEOUT_MS = 15_000;
const MEDIA_DOWNLOAD_TIMEOUT_MS = 30_000;

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise.catch(() => fallback), timeout]).finally(() => clearTimeout(timer));
}

async function downloadPhoto(message: Message): Promise<GatewayMedia | undefined> {
  const downloaded = await withTimeout(message.downloadMedia(), MEDIA_DOWNLOAD_TIMEOUT_MS, undefined);
  // base64 is ~4/3 of the byte size; skip oversized payloads before decoding.
  if (!downloaded?.data || downloaded.data.length * 0.75 > MAX_DOWNLOAD_BYTES) return undefined;
  return { mimeType: downloaded.mimetype, dataBase64: downloaded.data, fileName: downloaded.filename ?? undefined };
}

// Customer chats with unread messages from the last few hours, longest-waiting first.
function waitingChats(chats: readonly Chat[], since: number, received: RecentIds): Chat[] {
  return chats
    .filter((chat) => {
      const chatId = chat.id?._serialized;
      if (!chatId || chat.isGroup || NON_CUSTOMER_CHAT.test(chatId) || !(chat.unreadCount > 0) || chat.timestamp * 1_000 < since) return false;
      // Its latest message came through live (or is ours): the conversation has moved on since anything missed.
      const last = chat.lastMessage;
      const lastId = last ? serializeMessageId(last.id) : undefined;
      return !(last?.fromMe || (lastId && received.has(lastId)));
    })
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(0, CATCH_UP_MAX_CHATS);
}

// Of a chat's latest messages, the customer's that nobody answered: after the last one this account sent (a reply
// means what came before was seen), text or photo, recent, and never handed over. Oldest first.
function unanswered(messages: readonly Message[], since: number, received: RecentIds): Message[] {
  const ordered = [...messages].sort((a, b) => a.timestamp - b.timestamp);
  let firstUnanswered = 0;
  ordered.forEach((message, index) => {
    if (message.fromMe) firstUnanswered = index + 1;
  });
  return ordered.slice(firstUnanswered).filter((message) => {
    const id = serializeMessageId(message.id);
    return id !== undefined && !received.has(id) && SUPPORTED_TYPES.has(message.type) && message.timestamp * 1_000 >= since;
  });
}

const HOUR_MS = 60 * 60_000;
// Pakistan time (UTC+5, no daylight saving): the shop's customers.
const pakistanHour = (at: number) => new Date(at + 5 * HOUR_MS).getUTCHours();

// The oldest message a catch-up still answers: the last 6 hours by day, the last hour at night, and in the morning
// also what came in since 9pm yesterday.
export function catchUpSince(now: number): number {
  const hour = pakistanHour(now);
  if (hour >= 22 || hour < 9) return now - NIGHT_CATCH_UP_MS;
  if (hour >= 12) return now - CATCH_UP_WINDOW_MS;
  const localMidnight = Math.floor((now + 5 * HOUR_MS) / (24 * HOUR_MS)) * 24 * HOUR_MS - 5 * HOUR_MS;
  return Math.min(now - CATCH_UP_WINDOW_MS, localMidnight - 3 * HOUR_MS);
}

function readLinkedAt(authPath: string): number {
  try {
    const value = Number(readFileSync(join(authPath, LINKED_AT_FILE), "utf8").trim());
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

function isCustomerChatMessage(message: Message): boolean {
  return !message.fromMe && !NON_CUSTOMER_CHAT.test(message.from);
}

function occurredAt(message: Message): string {
  // Locally created messages can lack a timestamp; an invalid date would throw and drop the message.
  return (message.timestamp > 0 ? new Date(message.timestamp * 1_000) : new Date()).toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

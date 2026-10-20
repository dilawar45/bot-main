import {
  InboundMessageSchema,
  MediaUploadRequestSchema,
  type DeliveryAcknowledgement,
  type InboundMessage,
  type OutboundAction,
} from "@huzaifa/contracts";
import type { BrainClient } from "./brain-client.js";
import { defaultSleep, withRetry, type Sleep } from "./retry.js";
import { NotSentError, type TransportMessage, type TransportOwnerMessage, type WhatsAppTransport } from "./transport.js";

const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_LENGTH = 4_000;
// WhatsApp drops "typing…" after about 25 seconds; the brain can take longer than that.
const TYPING_REFRESH_MS = 20_000;
// The brain may only make the gateway download public catalog photos.
const PRODUCT_IMAGE_PATH = "/storage/v1/object/public/product-images/";
// Messages that arrive while a chat's previous turn is still being answered join one follow-up turn, up to this many.
const MAX_BATCH_MESSAGES = 10;
// After the owner types in a chat, the gateway stays out of it: no "typing…", no fallback messages.
const OWNER_QUIET_MS = 3 * 60 * 60 * 1_000;

// Chats that are never customers: groups, status updates, broadcast lists, channels.
const NON_CUSTOMER_CHAT = /@(g\.us|broadcast|newsletter)$/;

// Language is unknown when the brain is unreachable, so the fallback carries English and Roman Urdu.
export const FALLBACK_REPLY =
  "Sorry, we're having a temporary problem. Please try again in a few minutes.\nMaazrat, abhi thori technical kharabi hai. Kuch dair baad dobara message karein.";

export type ProcessorLogger = {
  warn(details: Record<string, unknown>, message: string): void;
  error(details: Record<string, unknown>, message: string): void;
};

export type ProcessorOptions = {
  brainRetryDelaysMs?: readonly number[];
  sendRetryDelaysMs?: readonly number[];
  // Quiet time after a customer's latest message before the burst is answered as one turn.
  mergeWindowMs?: number;
  // Longest the first message of a burst waits for the rest, however long the customer keeps typing.
  maxMergeWaitMs?: number;
  // Typing pause between consecutive messages to the same chat.
  sendPauseMs?: number;
  // Gap between follow-ups to different chats.
  scheduledGapMs?: number;
  // When set (e.g. "https://xyz.supabase.co"), product photos must come from exactly this origin.
  mediaOrigin?: string;
  sleep?: Sleep;
  logger?: ProcessorLogger;
};

type Batch = {
  messages: TransportMessage[];
  openedAt: number;
  timer?: NodeJS.Timeout;
  // Set while the batch waits for the chat's previous turn to finish.
  waiting?: boolean;
  done: Promise<void>;
  settle: () => void;
};

type Typing = {
  show(chatId: string): Promise<void>;
  stop(): Promise<void>;
};

const silentLogger: ProcessorLogger = { warn() {}, error() {} };
const noTyping: Typing = { show: async () => undefined, stop: async () => undefined };

export class MessageProcessor {
  private readonly chatQueues = new Map<string, Promise<void>>();
  // Per chat, the burst still inside its merge window.
  private readonly pendingBatches = new Map<string, Batch>();
  private readonly brainRetryDelaysMs: readonly number[];
  private readonly sendRetryDelaysMs: readonly number[];
  private readonly mergeWindowMs: number;
  private readonly maxMergeWaitMs: number;
  private readonly sendPauseMs: number;
  private readonly scheduledGapMs: number;
  private readonly mediaOrigin: string | undefined;
  private readonly sleep: Sleep;
  private readonly logger: ProcessorLogger;
  // Chat id -> until when the owner is considered to be handling it.
  private readonly ownerActiveUntil = new Map<string, number>();

  constructor(
    private readonly transport: WhatsAppTransport,
    private readonly brainClient: BrainClient,
    options: ProcessorOptions = {},
  ) {
    this.brainRetryDelaysMs = options.brainRetryDelaysMs ?? [1_000, 3_000];
    this.sendRetryDelaysMs = options.sendRetryDelaysMs ?? [2_000];
    this.mergeWindowMs = options.mergeWindowMs ?? 2_500;
    this.maxMergeWaitMs = options.maxMergeWaitMs ?? 6_000;
    this.sendPauseMs = options.sendPauseMs ?? 900;
    this.scheduledGapMs = options.scheduledGapMs ?? 4_000;
    this.mediaOrigin = options.mediaOrigin?.replace(/\/$/, "") || undefined;
    this.sleep = options.sleep ?? defaultSleep;
    this.logger = options.logger ?? silentLogger;
  }

  // Resolves once the burst this message belongs to has been answered.
  enqueue(message: TransportMessage): Promise<void> {
    if (message.fromMe || message.isGroup || NON_CUSTOMER_CHAT.test(message.chatId)) return Promise.resolve();
    if (!message.text?.trim() && !message.media) return Promise.resolve();

    // Customers split one thought over several quick messages; answering each one separately talks over them.
    const batch = this.pendingBatches.get(message.chatId) ?? this.openBatch(message.chatId);
    batch.messages.push(message);
    clearTimeout(batch.timer);
    if (message.media) {
      // A photo is usually what the burst was leading up to: answer now, with the texts before it as context.
      this.flush(message.chatId);
    } else if (batch.messages.length >= MAX_BATCH_MESSAGES) {
      this.flush(message.chatId);
    } else if (!batch.waiting) {
      const wait = Math.min(this.mergeWindowMs, batch.openedAt + this.maxMergeWaitMs - Date.now());
      batch.timer = setTimeout(() => this.flushWhenIdle(message.chatId), Math.max(0, wait));
    }
    return batch.done;
  }

  // While the chat's previous turn is still being answered, keep collecting: everything the customer
  // added meanwhile is answered together in one follow-up turn instead of several back-to-back replies.
  private flushWhenIdle(chatId: string): void {
    const batch = this.pendingBatches.get(chatId);
    if (!batch) return;
    const inFlight = this.chatQueues.get(chatId);
    if (!inFlight) {
      this.flush(chatId);
      return;
    }
    if (batch.waiting) return;
    batch.waiting = true;
    void inFlight.finally(() => {
      batch.waiting = false;
      if (this.pendingBatches.get(chatId) === batch) this.flushWhenIdle(chatId);
    });
  }

  private ownerActive(chatId: string): boolean {
    return (this.ownerActiveUntil.get(chatId) ?? 0) > Date.now();
  }

  // Resolves once every received message has been answered; used for graceful shutdown.
  async drain(): Promise<void> {
    while (this.pendingBatches.size > 0 || this.chatQueues.size > 0) {
      for (const chatId of [...this.pendingBatches.keys()]) this.flush(chatId);
      await Promise.allSettled([...this.chatQueues.values()]);
    }
  }

  // The owner typed in a chat. The brain records it and pauses the bot there; if the report is lost the bot
  // keeps answering over the owner, so it gets the same retries as other brain calls. Never throws.
  async reportOwnerMessage(message: TransportOwnerMessage): Promise<void> {
    const until = Date.now() + OWNER_QUIET_MS;
    if (this.ownerActiveUntil.size > 5_000) this.ownerActiveUntil.clear();
    for (const chatId of [message.chatId, ...message.alternateChatIds]) this.ownerActiveUntil.set(chatId, until);
    const ownerMessage = {
      messageId: message.id,
      chatId: message.chatId,
      alternateChatIds: message.alternateChatIds.slice(0, 3),
      occurredAt: message.occurredAt,
      type: message.type,
      text: message.text?.slice(0, MAX_TEXT_LENGTH) || undefined,
    };
    try {
      await withRetry(() => this.brainClient.reportOwnerMessage(ownerMessage), this.brainRetryDelaysMs, this.sleep);
    } catch (error) {
      this.logger.error({ chatId: redact(message.chatId), error: describe(error) }, "Owner message report failed");
    }
  }

  private openBatch(chatId: string): Batch {
    let settle!: () => void;
    const done = new Promise<void>((resolve) => {
      settle = () => resolve();
    });
    const batch: Batch = { messages: [], openedAt: Date.now(), done, settle };
    this.pendingBatches.set(chatId, batch);
    return batch;
  }

  private flush(chatId: string): void {
    const batch = this.pendingBatches.get(chatId);
    if (!batch) return;
    this.pendingBatches.delete(chatId);
    clearTimeout(batch.timer);

    void this.inChatQueue(chatId, () => this.process(batch.messages))
      .catch((error: unknown) => this.logger.error({ chatId: redact(chatId), error: describe(error) }, "Message processing failed"))
      .then(batch.settle);
  }

  // One queue per chat keeps its turns (and follow-ups) in order; different chats run concurrently.
  private inChatQueue<T>(chatId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chatQueues.get(chatId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(task);
    const settled: Promise<void> = result
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        if (this.chatQueues.get(chatId) === settled) this.chatQueues.delete(chatId);
      });
    this.chatQueues.set(chatId, settled);
    return result;
  }

  // Follow-ups the brain sends without a customer message first (order reminders, notes to the owner). Chats are
  // taken one at a time with a gap, because several chats getting a message in the same second looks automated.
  async sendScheduled(actions: readonly OutboundAction[]): Promise<void> {
    const byChat = new Map<string, OutboundAction[]>();
    for (const action of actions) byChat.set(action.recipientChatId, [...(byChat.get(action.recipientChatId) ?? []), action]);

    const acknowledgements: DeliveryAcknowledgement[] = [];
    let first = true;
    for (const [chatId, chatActions] of byChat) {
      if (!first) await this.sleep(this.scheduledGapMs);
      first = false;
      // The owner is talking to this customer: an automated reminder would land in their conversation.
      if (this.ownerActive(chatId)) {
        acknowledgements.push(...chatActions.map((action): DeliveryAcknowledgement => ({ actionId: action.actionId, status: "failed", errorCode: "owner_active" })));
        continue;
      }
      // The customer is writing or being answered right now (maybe "confirm"): a reminder decided before their
      // message would contradict the reply ("order placed" followed by "your order isn't placed yet").
      if (this.pendingBatches.has(chatId) || this.chatQueues.has(chatId)) {
        acknowledgements.push(...chatActions.map((action): DeliveryAcknowledgement => ({ actionId: action.actionId, status: "failed", errorCode: "customer_active" })));
        continue;
      }
      const sent = await this.inChatQueue(chatId, async () => {
        const typing = this.startTyping(chatId);
        try {
          await this.sleep(this.sendPauseMs);
          return await this.deliver(chatActions, typing);
        } finally {
          await typing.stop();
        }
      }).catch((error: unknown) => {
        this.logger.error({ chatId: redact(chatId), error: describe(error) }, "Follow-up send failed");
        return chatActions.map((action): DeliveryAcknowledgement => ({ actionId: action.actionId, status: "failed", errorCode: "send_failed" }));
      });
      acknowledgements.push(...sent);
    }

    // A delivery report takes at most 8 acknowledgements.
    for (let index = 0; index < acknowledgements.length; index += 8) {
      const chunk = acknowledgements.slice(index, index + 8);
      try {
        await withRetry(() => this.brainClient.reportDeliveries(chunk), this.brainRetryDelaysMs, this.sleep);
      } catch (error) {
        this.logger.warn({ error: describe(error) }, "Follow-up delivery report failed");
      }
    }
  }

  private async process(batch: readonly TransportMessage[]): Promise<void> {
    // The latest message speaks for the burst: its id is the event id, and only it can carry a photo.
    const latest = batch[batch.length - 1]!;
    const text = mergeTexts(batch);
    let image: Buffer | undefined;

    if (latest.media) {
      const bytes = Buffer.from(latest.media.dataBase64, "base64");
      if (ALLOWED_IMAGE_TYPES.has(latest.media.mimeType) && bytes.byteLength > 0 && bytes.byteLength <= MAX_MEDIA_BYTES) {
        image = bytes;
      } else if (!text) {
        this.logger.warn({ messageId: latest.id, mimeType: latest.media.mimeType, bytes: bytes.byteLength }, "Unsupported media ignored");
        return;
      }
    }

    // The owner is chatting here: don't show the bot "typing…" over them (the brain decides silence).
    const typing = this.ownerActive(latest.chatId) ? noTyping : this.startTyping(latest.chatId);
    let acknowledgements: DeliveryAcknowledgement[];
    try {
      const actions = await this.askBrain(latest, text, image);
      // The brain answers the customer again (the owner pressed "Resume bot"): the gateway stops holding back.
      if (actions?.some((action) => action.recipientChatId === latest.chatId)) this.ownerActiveUntil.delete(latest.chatId);
      acknowledgements = actions ? await this.deliver(actions, typing) : [];
    } finally {
      await typing.stop();
    }

    if (acknowledgements.length) {
      try {
        await withRetry(() => this.brainClient.reportDeliveries(acknowledgements), this.brainRetryDelaysMs, this.sleep);
      } catch (error) {
        this.logger.warn({ messageId: latest.id, error: describe(error) }, "Delivery report failed");
      }
    }
  }

  // Returns the brain's actions, or undefined when the customer got the fallback reply instead.
  private async askBrain(latest: TransportMessage, text: string | undefined, image: Buffer | undefined): Promise<OutboundAction[] | undefined> {
    let media: InboundMessage["media"];
    if (image) {
      try {
        media = await this.uploadImage(latest, image);
      } catch (error) {
        this.logger.warn({ messageId: latest.id, error: describe(error) }, "Image upload failed");
        if (!text) {
          await this.sendFallback(latest.chatId);
          return undefined;
        }
      }
    }

    const inbound = InboundMessageSchema.parse({
      eventId: latest.id,
      messageId: latest.id,
      chatId: latest.chatId,
      displayName: latest.displayName,
      phoneNumber: latest.phoneNumber,
      occurredAt: latest.occurredAt,
      type: media ? "image" : "text",
      text,
      media,
    });

    let attempts = 0;
    try {
      // The brain dedupes by event ID, so retrying after a lost response cannot create a second agent run.
      const result = await withRetry(
        () => {
          attempts += 1;
          return this.brainClient.processMessage(inbound);
        },
        this.brainRetryDelaysMs,
        this.sleep,
      );
      // A retry that comes back "duplicate" with nothing to send means the brain answered an earlier attempt
      // whose response we never got: the customer would otherwise hear nothing at all.
      if (result.duplicate && result.actions.length === 0 && attempts > 1) {
        this.logger.warn({ messageId: latest.id }, "Brain response lost; sending fallback");
        await this.sendFallback(latest.chatId);
        return undefined;
      }
      return result.actions;
    } catch (error) {
      this.logger.error({ messageId: latest.id, error: describe(error) }, "Brain unavailable, sending fallback");
      await this.sendFallback(latest.chatId);
      return undefined;
    }
  }

  private async deliver(actions: readonly OutboundAction[], typing: Typing): Promise<DeliveryAcknowledgement[]> {
    const acknowledgements: DeliveryAcknowledgement[] = [];
    let previousRecipient: string | undefined;

    for (const action of actions) {
      let send: () => Promise<string>;
      if (action.type === "text") {
        send = () => this.transport.sendText(action.recipientChatId, action.text);
      } else if (!action.url) {
        acknowledgements.push({ actionId: action.actionId, status: "failed", errorCode: "unsupported_action" });
        continue;
      } else if (!isProductImageUrl(action.url, this.mediaOrigin)) {
        acknowledgements.push({ actionId: action.actionId, status: "failed", errorCode: "invalid_media_url" });
        continue;
      } else {
        const url = action.url;
        send = () => this.transport.sendImage(action.recipientChatId, url, action.caption);
      }

      if (action.recipientChatId === previousRecipient) {
        // Several messages landing at once read like a bot; a short typing pause reads like a person.
        await typing.show(action.recipientChatId);
        await this.sleep(this.sendPauseMs);
      }
      previousRecipient = action.recipientChatId;

      try {
        // Only failures before WhatsApp took the message are retried; retrying anything else risks a duplicate.
        const providerMessageId = await withRetry(send, this.sendRetryDelaysMs, this.sleep, (error) => error instanceof NotSentError);
        acknowledgements.push({ actionId: action.actionId, status: "sent", ...(providerMessageId ? { providerMessageId: providerMessageId.slice(0, 180) } : {}) });
      } catch (error) {
        this.logger.error({ actionId: action.actionId, error: describe(error) }, "WhatsApp send failed");
        acknowledgements.push({ actionId: action.actionId, status: "failed", errorCode: "send_failed" });
        // A product photo that can't be sent still owes the customer its name, price and sizes. Only when it
        // certainly didn't go out: after WhatsApp took it, the caption would arrive twice.
        if (action.type === "image" && action.caption && error instanceof NotSentError) {
          await this.transport.sendText(action.recipientChatId, action.caption).catch((textError: unknown) =>
            this.logger.warn({ actionId: action.actionId, error: describe(textError) }, "Caption fallback failed"),
          );
        }
      }
    }
    return acknowledgements;
  }

  // Shows "typing…" in the customer's chat from the start of a turn until its last message is out.
  private startTyping(chatId: string): Typing {
    const shownIn = new Set<string>();
    let latest: Promise<void> = Promise.resolve();
    const show = (target: string) => {
      shownIn.add(target);
      latest = this.transport.setTyping(target, true).catch(() => undefined);
      return latest;
    };
    void show(chatId);
    const refresh = setInterval(() => void show(chatId), TYPING_REFRESH_MS);
    return {
      show,
      stop: async () => {
        clearInterval(refresh);
        // A refresh still in flight must not bring the indicator back after it was cleared.
        await latest;
        await Promise.all([...shownIn].map((target) => this.transport.setTyping(target, false).catch(() => undefined)));
      },
    };
  }

  private async uploadImage(message: TransportMessage, bytes: Buffer): Promise<InboundMessage["media"]> {
    const uploadRequest = MediaUploadRequestSchema.parse({
      messageId: message.id,
      chatId: message.chatId,
      mimeType: message.media!.mimeType,
      sizeBytes: bytes.byteLength,
      fileName: message.media!.fileName?.slice(0, 180) || undefined,
    });
    const grant = await withRetry(() => this.brainClient.createMediaUpload(uploadRequest), this.brainRetryDelaysMs, this.sleep);
    await withRetry(() => this.brainClient.uploadMedia(grant, bytes, uploadRequest.mimeType), this.brainRetryDelaysMs, this.sleep);
    return { objectPath: grant.objectPath, mimeType: uploadRequest.mimeType, sizeBytes: uploadRequest.sizeBytes, fileName: uploadRequest.fileName };
  }

  private async sendFallback(chatId: string): Promise<void> {
    // The owner is handling this chat; an automated "temporary problem" would land in their conversation.
    if (this.ownerActive(chatId)) return;
    try {
      await this.transport.sendText(chatId, FALLBACK_REPLY);
    } catch (error) {
      this.logger.error({ chatId: redact(chatId), error: describe(error) }, "Fallback send failed");
    }
  }
}

// A burst's texts in arrival order (a photo caption included), as one message the brain answers in one turn.
function mergeTexts(batch: readonly TransportMessage[]): string | undefined {
  const texts = batch.map((message) => message.text?.trim()).filter((text): text is string => Boolean(text));
  return texts.join("\n").slice(0, MAX_TEXT_LENGTH) || undefined;
}

function isProductImageUrl(value: string, origin?: string): boolean {
  try {
    const url = new URL(value);
    // The resolved path must start with the public product-images prefix ("../" tricks are resolved by URL).
    if (url.protocol !== "https:" || !url.pathname.startsWith(PRODUCT_IMAGE_PATH)) return false;
    return !origin || url.origin === origin;
  } catch {
    return false;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

// Keep logs useful without storing full phone numbers.
export function redact(chatId: string): string {
  return chatId.replace(/^(\d{4})\d+(\d{2})@/, "$1…$2@");
}

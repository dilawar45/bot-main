import { afterEach, describe, expect, it, vi } from "vitest";
import { BrainClient } from "./brain-client.js";
import { FALLBACK_REPLY, MessageProcessor } from "./processor.js";
import { NotSentError, type MessageHandler, type OwnerMessageHandler, type SessionSnapshot, type WhatsAppTransport } from "./transport.js";

class TestTransport implements WhatsAppTransport {
  sent: Array<{ chatId: string; text: string }> = [];
  images: Array<{ chatId: string; url: string; caption?: string }> = [];
  // Everything the customer would see, in order.
  events: string[] = [];
  async initialize() {}
  async destroy() {}
  async logout() {}
  async reinitialize() {}
  async requestPairingCode() {
    return "ABCD1234";
  }
  onMessage(_handler: MessageHandler) {}
  onOwnerMessage(_handler: OwnerMessageHandler) {}
  getSessionSnapshot(): SessionSnapshot { return { state: "ready" }; }
  async sendText(chatId: string, text: string) {
    this.sent.push({ chatId, text });
    this.events.push(`text:${chatId}:${text}`);
    return `sent-${this.sent.length}`;
  }
  async sendImage(chatId: string, url: string, caption?: string) {
    this.images.push({ chatId, url, caption });
    this.events.push(`image:${chatId}:${url}`);
    return `image-${this.images.length}`;
  }
  async setTyping(chatId: string, typing: boolean) {
    this.events.push(`typing:${chatId}:${typing ? "on" : "off"}`);
  }
}

describe("MessageProcessor", () => {
  it("signs a text event and sends validated actions", async () => {
    let signature = "";
    const brain = new BrainClient({
      baseUrl: "https://brain.example.com",
      hmacSecret: "a-secret-long-enough-for-production-use",
      timeoutMs: 1_000,
      fetchImplementation: async (_input, init) => {
        signature = new Headers(init?.headers).get("x-huzaifa-signature") ?? "";
        return Response.json({
          eventId: "message-1",
          duplicate: false,
          actions: [
            {
              actionId: "6f548628-7b8a-4e29-92fc-b19829adccf6",
              recipientChatId: "customer@c.us",
              type: "text",
              text: "Grounded reply",
            },
          ],
        });
      },
    });
    const transport = new TestTransport();
    const processor = new MessageProcessor(transport, brain, { mergeWindowMs: 0 });

    await processor.enqueue({
      id: "message-1",
      chatId: "customer@c.us",
      occurredAt: "2026-09-28T12:00:00.000Z",
      fromMe: false,
      isGroup: false,
      text: "green kurta",
    });

    expect(signature).toMatch(/^[a-f0-9]{64}$/);
    expect(transport.sent).toEqual([{ chatId: "customer@c.us", text: "Grounded reply" }]);
  });

  it("ignores owner and group messages", async () => {
    const brain = new BrainClient({
      baseUrl: "https://brain.example.com",
      hmacSecret: "a-secret-long-enough-for-production-use",
      timeoutMs: 1_000,
      fetchImplementation: async () => { throw new Error("should not call brain"); },
    });
    const transport = new TestTransport();
    const processor = new MessageProcessor(transport, brain);
    await processor.enqueue({ id: "1", chatId: "one", occurredAt: new Date().toISOString(), fromMe: true, isGroup: false, text: "hi" });
    await processor.enqueue({ id: "2", chatId: "group", occurredAt: new Date().toISOString(), fromMe: false, isGroup: true, text: "hi" });
    expect(transport.sent).toEqual([]);
  });

  it("uploads image bytes before forwarding image metadata", async () => {
    const calls: Array<{ url: string; method?: string; body?: BodyInit | null }> = [];
    const brain = new BrainClient({
      baseUrl: "https://brain.example.com",
      hmacSecret: "a-secret-long-enough-for-production-use",
      timeoutMs: 1_000,
      fetchImplementation: async (input, init) => {
        const url = input.toString();
        calls.push({ url, method: init?.method, body: init?.body });
        if (url.endsWith("/api/gateway/media-upload")) {
          return Response.json({
            bucket: "inbound-media",
            objectPath: "messages/chat-hash/message-hash.png",
            signedUrl:
              "https://project.supabase.co/storage/v1/object/upload/sign/inbound-media/messages/chat-hash/message-hash.png?token=signed-token",
            expiresAt: "2026-09-28T14:00:00.000Z",
          });
        }
        if (url.startsWith("https://project.supabase.co/storage/")) {
          return Response.json({ Key: "inbound-media/messages/chat-hash/message-hash.png" });
        }
        return Response.json({ eventId: "image-1", duplicate: false, actions: [] });
      },
    });
    const processor = new MessageProcessor(new TestTransport(), brain);

    await processor.enqueue({
      id: "image-1",
      chatId: "customer@c.us",
      occurredAt: "2026-09-28T12:00:00.000Z",
      fromMe: false,
      isGroup: false,
      text: "green lawn kurta",
      media: {
        mimeType: "image/png",
        dataBase64: Buffer.from([1, 2, 3, 4]).toString("base64"),
        fileName: "customer.png",
      },
    });

    expect(calls.map((call) => call.method)).toEqual(["POST", "PUT", "POST"]);
    expect(calls[1].body).toBeInstanceOf(ArrayBuffer);
    const forwarded = JSON.parse(String(calls[2].body));
    expect(forwarded).toMatchObject({
      type: "image",
      text: "green lawn kurta",
      media: {
        objectPath: "messages/chat-hash/message-hash.png",
        mimeType: "image/png",
        sizeBytes: 4,
      },
    });
    expect(forwarded.media).not.toHaveProperty("dataBase64");
  });
});
const secret = "a-secret-long-enough-for-production-use";
const noSleep = async () => {};
const reply = {
  eventId: "m1",
  duplicate: false,
  actions: [{ actionId: "6f548628-7b8a-4e29-92fc-b19829adccf6", recipientChatId: "923001234567@c.us", type: "text", text: "Here you go" }],
};
const textMessage = (overrides: Partial<Parameters<MessageProcessor["enqueue"]>[0]> = {}) => ({
  id: "m1",
  chatId: "923001234567@c.us",
  occurredAt: "2026-09-28T12:00:00.000Z",
  fromMe: false,
  isGroup: false,
  text: "kurta",
  ...overrides,
});

describe("MessageProcessor reliability", () => {
  it("retries a 5xx brain response, then reports delivery", async () => {
    const paths: string[] = [];
    let attempts = 0;
    const brain = new BrainClient({
      baseUrl: "https://brain.example.com",
      hmacSecret: secret,
      timeoutMs: 1_000,
      fetchImplementation: async (input, init) => {
        const path = new URL(input.toString()).pathname;
        paths.push(path);
        if (path === "/api/gateway/messages" && attempts++ === 0) return new Response("down", { status: 503 });
        if (path === "/api/gateway/deliveries") {
          const body = JSON.parse(String(init?.body));
          expect(body.acknowledgements).toEqual([{ actionId: reply.actions[0]!.actionId, status: "sent", providerMessageId: "sent-1" }]);
          return Response.json({ updated: 1 });
        }
        return Response.json(reply);
      },
    });
    const transport = new TestTransport();
    await new MessageProcessor(transport, brain, { sleep: noSleep, mergeWindowMs: 0 }).enqueue(textMessage());

    expect(paths).toEqual(["/api/gateway/messages", "/api/gateway/messages", "/api/gateway/deliveries"]);
    expect(transport.sent.map((sent) => sent.text)).toEqual(["Here you go"]);
  });

  it("sends the bilingual fallback when the brain stays down, without retrying 4xx forever", async () => {
    let calls = 0;
    const brain = new BrainClient({
      baseUrl: "https://brain.example.com",
      hmacSecret: secret,
      timeoutMs: 1_000,
      fetchImplementation: async () => {
        calls += 1;
        return new Response("unauthorized", { status: 401 });
      },
    });
    const transport = new TestTransport();
    await new MessageProcessor(transport, brain, { sleep: noSleep, mergeWindowMs: 0 }).enqueue(textMessage());
    expect(calls).toBe(1);
    expect(transport.sent).toEqual([{ chatId: "923001234567@c.us", text: FALLBACK_REPLY }]);
  });

  it("reports a failed send so the brain can surface it", async () => {
    let report: unknown;
    const brain = new BrainClient({
      baseUrl: "https://brain.example.com",
      hmacSecret: secret,
      timeoutMs: 1_000,
      fetchImplementation: async (input, init) => {
        if (input.toString().endsWith("/deliveries")) {
          report = JSON.parse(String(init?.body));
          return Response.json({ updated: 1 });
        }
        return Response.json(reply);
      },
    });
    const transport = new TestTransport();
    transport.sendText = async () => {
      throw new Error("not ready");
    };
    await new MessageProcessor(transport, brain, { sleep: noSleep, mergeWindowMs: 0 }).enqueue(textMessage());
    expect(report).toEqual({ acknowledgements: [{ actionId: reply.actions[0]!.actionId, status: "failed", errorCode: "send_failed" }] });
  });

  it("ignores status broadcasts, channels and caption-less unsupported media", async () => {
    const brain = new BrainClient({
      baseUrl: "https://brain.example.com",
      hmacSecret: secret,
      timeoutMs: 1_000,
      fetchImplementation: async () => {
        throw new Error("should not call brain");
      },
    });
    const transport = new TestTransport();
    const processor = new MessageProcessor(transport, brain, { sleep: noSleep });
    await processor.enqueue(textMessage({ chatId: "status@broadcast" }));
    await processor.enqueue(textMessage({ chatId: "1203630@newsletter" }));
    await processor.enqueue(textMessage({ text: undefined, media: { mimeType: "image/gif", dataBase64: "AAAA" } }));
    expect(transport.sent).toEqual([]);
  });

  it("keeps each chat's messages in order", async () => {
    const order: string[] = [];
    const brain = new BrainClient({
      baseUrl: "https://brain.example.com",
      hmacSecret: secret,
      timeoutMs: 1_000,
      fetchImplementation: async (input, init) => {
        if (input.toString().endsWith("/deliveries")) return Response.json({ updated: 0 });
        const body = JSON.parse(String(init?.body));
        if (body.eventId === "first") await new Promise((resolve) => setTimeout(resolve, 30));
        order.push(body.eventId);
        return Response.json({ eventId: body.eventId, duplicate: false, actions: [] });
      },
    });
    const processor = new MessageProcessor(new TestTransport(), brain, { sleep: noSleep, mergeWindowMs: 0 });
    void processor.enqueue(textMessage({ id: "first" }));
    // Let the first burst close so the second message becomes its own turn.
    await new Promise((resolve) => setTimeout(resolve, 5));
    void processor.enqueue(textMessage({ id: "second" }));
    await processor.drain();
    expect(order).toEqual(["first", "second"]);
  });

  it("sends the fallback when a retried turn comes back already answered with nothing to send", async () => {
    let attempts = 0;
    const brain = new BrainClient({
      baseUrl: "https://brain.example.com",
      hmacSecret: secret,
      timeoutMs: 1_000,
      fetchImplementation: async (input) => {
        if (input.toString().endsWith("/deliveries")) return json({ updated: 0 });
        attempts += 1;
        // The first answer is lost on the way back; the retry finds the event already handled.
        if (attempts === 1) return new Response("gateway timeout", { status: 504 });
        return json({ eventId: "m1", duplicate: true, actions: [] });
      },
    });
    const transport = new TestTransport();
    await new MessageProcessor(transport, brain, { sleep: noSleep, mergeWindowMs: 0 }).enqueue(textMessage());
    expect(attempts).toBe(2);
    expect(transport.sent).toEqual([{ chatId: customer, text: FALLBACK_REPLY }]);
  });

  it("stays quiet when WhatsApp redelivers a message the brain already answered", async () => {
    const brain = new BrainClient({
      baseUrl: "https://brain.example.com",
      hmacSecret: secret,
      timeoutMs: 1_000,
      fetchImplementation: async () => json({ eventId: "m1", duplicate: true, actions: [] }),
    });
    const transport = new TestTransport();
    await new MessageProcessor(transport, brain, { sleep: noSleep, mergeWindowMs: 0 }).enqueue(textMessage());
    expect(transport.sent).toEqual([]);
  });

  it("retries only sends that never reached WhatsApp", async () => {
    const { brain, reports } = scriptedBrain([
      { actionId: actionIds[0], recipientChatId: customer, type: "text", text: "one" },
      { actionId: actionIds[1], recipientChatId: customer, type: "text", text: "two" },
    ]);
    const transport = new TestTransport();
    const calls: string[] = [];
    transport.sendText = async (_chatId, text) => {
      calls.push(text);
      if (text === "one" && calls.length === 1) throw new NotSentError("WhatsApp not ready (authenticated)");
      // Failing after the hand-over may still have delivered it: a retry could send it twice.
      if (text === "two") throw new Error("Evaluation failed: Protocol error");
      return "sent-1";
    };
    await new MessageProcessor(transport, brain, { sleep: noSleep, mergeWindowMs: 0 }).enqueue(textMessage());
    expect(calls).toEqual(["one", "one", "two"]);
    expect(reports).toEqual([
      {
        acknowledgements: [
          { actionId: actionIds[0], status: "sent", providerMessageId: "sent-1" },
          { actionId: actionIds[1], status: "failed", errorCode: "send_failed" },
        ],
      },
    ]);
  });
});

describe("LID chats", () => {
  it("forwards the resolved phone number and replies to the @lid chat id", async () => {
    let forwarded: Record<string, unknown> = {};
    const brain = new BrainClient({
      baseUrl: "https://brain.example.com",
      hmacSecret: secret,
      timeoutMs: 1_000,
      fetchImplementation: async (input, init) => {
        if (input.toString().endsWith("/deliveries")) return Response.json({ updated: 1 });
        forwarded = JSON.parse(String(init?.body));
        return Response.json({ ...reply, actions: [{ ...reply.actions[0], recipientChatId: "98100000000068@lid" }] });
      },
    });
    const transport = new TestTransport();
    await new MessageProcessor(transport, brain, { sleep: noSleep, mergeWindowMs: 0 }).enqueue(
      textMessage({ id: "false_98100000000068@lid_3EB0", chatId: "98100000000068@lid", phoneNumber: "923001112233" }),
    );
    expect(forwarded).toMatchObject({ chatId: "98100000000068@lid", phoneNumber: "923001112233", eventId: "false_98100000000068@lid_3EB0" });
    expect(transport.sent[0]?.chatId).toBe("98100000000068@lid");
  });
});

const customer = "923001234567@c.us";
const shopOwner = "923009999999@c.us";
const photo = "https://project.supabase.co/storage/v1/object/public/product-images/kurta-green.jpg";
const actionIds = [
  "6f548628-7b8a-4e29-92fc-b19829adccf6",
  "0d8e7f3a-54b1-4c1e-9a52-3f1c2b7d8e90",
  "a3c1d2e4-5f67-4890-8abc-def012345678",
  "b7e9f1a2-3c4d-4e5f-a617-28394a5b6c7d",
] as const;

// Plain response double: no body stream internals, so it also works under fake timers.
const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

// Brain double that answers every turn with `actions` and records turns and delivery reports.
function scriptedBrain(actions: unknown[]) {
  const turns: Array<Record<string, unknown>> = [];
  const reports: unknown[] = [];
  const brain = new BrainClient({
    baseUrl: "https://brain.example.com",
    hmacSecret: secret,
    timeoutMs: 1_000,
    fetchImplementation: async (input, init) => {
      const url = input.toString();
      if (url.endsWith("/api/gateway/media-upload")) {
        return json({
          bucket: "inbound-media",
          objectPath: "messages/chat/photo.png",
          signedUrl: "https://project.supabase.co/storage/v1/object/upload/sign/inbound-media/messages/chat/photo.png?token=t",
          expiresAt: "2026-09-28T14:00:00.000Z",
        });
      }
      if (url.startsWith("https://project.supabase.co/")) return json({});
      const body = JSON.parse(String(init?.body));
      if (url.endsWith("/api/gateway/deliveries")) {
        reports.push(body);
        return json({ updated: body.acknowledgements.length });
      }
      turns.push(body);
      return json({ eventId: body.eventId, duplicate: false, actions });
    },
  });
  return { brain, turns, reports };
}

describe("bursts", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("answers quick consecutive texts as one brain turn", async () => {
    const { brain, turns } = scriptedBrain([]);
    const processor = new MessageProcessor(new TestTransport(), brain, { sleep: noSleep, mergeWindowMs: 20 });
    await Promise.all([
      processor.enqueue(textMessage({ id: "m1", text: "salam" })),
      processor.enqueue(textMessage({ id: "m2", text: "  green kurta  " })),
      processor.enqueue(textMessage({ id: "m3", text: "size M?", displayName: "Ayesha", occurredAt: "2026-09-28T12:00:04.000Z" })),
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      eventId: "m3",
      messageId: "m3",
      type: "text",
      text: "salam\ngreen kurta\nsize M?",
      displayName: "Ayesha",
      occurredAt: "2026-09-28T12:00:04.000Z",
    });
  });

  it("answers at once when a photo arrives, with the texts before it", async () => {
    const { brain, turns } = scriptedBrain([]);
    // A window this long would time the test out if the photo did not close the burst.
    const processor = new MessageProcessor(new TestTransport(), brain, { sleep: noSleep, mergeWindowMs: 60_000, maxMergeWaitMs: 60_000 });
    await Promise.all([
      processor.enqueue(textMessage({ id: "m1", text: "is this available?" })),
      processor.enqueue(
        textMessage({ id: "m2", text: "in red", media: { mimeType: "image/png", dataBase64: Buffer.from([1, 2, 3]).toString("base64") } }),
      ),
    ]);
    expect(turns).toEqual([
      expect.objectContaining({
        eventId: "m2",
        type: "image",
        text: "is this available?\nin red",
        media: expect.objectContaining({ objectPath: "messages/chat/photo.png", mimeType: "image/png" }),
      }),
    ]);
  });

  it("stops waiting after maxMergeWaitMs while the customer keeps typing", async () => {
    vi.useFakeTimers();
    const { brain, turns } = scriptedBrain([]);
    const processor = new MessageProcessor(new TestTransport(), brain, { sleep: noSleep, mergeWindowMs: 100, maxMergeWaitMs: 250 });
    for (const [index, text] of ["one", "two", "three", "four"].entries()) {
      if (index) await vi.advanceTimersByTimeAsync(80);
      void processor.enqueue(textMessage({ id: `m${index}`, text }));
    }
    // Now at 240ms; the quiet window alone would hold the burst until 340ms.
    await vi.advanceTimersByTimeAsync(9);
    expect(turns).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(turns).toEqual([expect.objectContaining({ eventId: "m3", text: "one\ntwo\nthree\nfour" })]);
    await processor.drain();
  });

  it("caps the merged text at the brain's limit", async () => {
    const { brain, turns } = scriptedBrain([]);
    const processor = new MessageProcessor(new TestTransport(), brain, { sleep: noSleep, mergeWindowMs: 0 });
    await Promise.all([
      processor.enqueue(textMessage({ id: "m1", text: "a".repeat(3_000) })),
      processor.enqueue(textMessage({ id: "m2", text: "b".repeat(3_000) })),
    ]);
    expect(turns[0]?.text).toBe(`${"a".repeat(3_000)}\n${"b".repeat(999)}`);
  });

  it("answers what arrives during a slow turn as one follow-up turn", async () => {
    const turns: Array<Record<string, unknown>> = [];
    let releaseFirst = () => {};
    const brain = new BrainClient({
      baseUrl: "https://brain.example.com",
      hmacSecret: secret,
      timeoutMs: 5_000,
      fetchImplementation: async (input, init) => {
        if (input.toString().endsWith("/deliveries")) return json({ updated: 0 });
        const body = JSON.parse(String(init?.body));
        turns.push(body);
        if (turns.length === 1) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        return json({ eventId: body.eventId, duplicate: false, actions: [] });
      },
    });
    const processor = new MessageProcessor(new TestTransport(), brain, { sleep: noSleep, mergeWindowMs: 5 });
    void processor.enqueue(textMessage({ id: "m1", text: "green kurta hai?" }));
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    // Both windows close while the first turn is still being answered.
    void processor.enqueue(textMessage({ id: "m2", text: "size M" }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    void processor.enqueue(textMessage({ id: "m3", text: "aur price?" }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(turns).toHaveLength(1);
    releaseFirst();
    await vi.waitFor(() => expect(turns).toHaveLength(2));
    await processor.drain();
    expect(turns.map((turn) => [turn.eventId, turn.text])).toEqual([
      ["m1", "green kurta hai?"],
      ["m3", "size M\naur price?"],
    ]);
  });

  it("drain answers bursts still inside their window", async () => {
    const { brain, turns } = scriptedBrain([]);
    const processor = new MessageProcessor(new TestTransport(), brain, { sleep: noSleep, mergeWindowMs: 60_000 });
    const answered = processor.enqueue(textMessage());
    await processor.drain();
    expect(turns).toHaveLength(1);
    await expect(answered).resolves.toBeUndefined();
  });
});

describe("typing and pacing", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows typing while the brain works and clears it after the reply", async () => {
    const { brain } = scriptedBrain([{ actionId: actionIds[0], recipientChatId: customer, type: "text", text: "Here you go" }]);
    const transport = new TestTransport();
    await new MessageProcessor(transport, brain, { sleep: noSleep, mergeWindowMs: 0 }).enqueue(textMessage());
    expect(transport.events).toEqual([`typing:${customer}:on`, `text:${customer}:Here you go`, `typing:${customer}:off`]);
  });

  it("clears typing when the brain is down and the fallback goes out", async () => {
    const brain = new BrainClient({
      baseUrl: "https://brain.example.com",
      hmacSecret: secret,
      timeoutMs: 1_000,
      fetchImplementation: async () => new Response("unauthorized", { status: 401 }),
    });
    const transport = new TestTransport();
    await new MessageProcessor(transport, brain, { sleep: noSleep, mergeWindowMs: 0 }).enqueue(textMessage());
    expect(transport.events).toEqual([`typing:${customer}:on`, `text:${customer}:${FALLBACK_REPLY}`, `typing:${customer}:off`]);
  });

  it("keeps typing alive while the brain takes long", async () => {
    vi.useFakeTimers();
    let answer = () => {};
    const brain = new BrainClient({
      baseUrl: "https://brain.example.com",
      hmacSecret: secret,
      timeoutMs: 60_000,
      fetchImplementation: async (input) => {
        if (input.toString().endsWith("/deliveries")) return json({ updated: 1 });
        await new Promise<void>((resolve) => {
          answer = resolve;
        });
        return json(reply);
      },
    });
    const transport = new TestTransport();
    const answered = new MessageProcessor(transport, brain, { sleep: noSleep, mergeWindowMs: 0 }).enqueue(textMessage());
    await vi.advanceTimersByTimeAsync(45_000);
    answer();
    await answered;
    const on = `typing:${customer}:on`;
    expect(transport.events).toEqual([on, on, on, `text:${customer}:Here you go`, `typing:${customer}:off`]);
  });

  it("pauses with typing between messages to the same chat, never before the first", async () => {
    const { brain, reports } = scriptedBrain([
      { actionId: actionIds[0], recipientChatId: customer, type: "text", text: "We have it" },
      { actionId: actionIds[1], recipientChatId: customer, type: "image", objectPath: "kurta-green.jpg", url: photo, caption: "Green kurta" },
      { actionId: actionIds[2], recipientChatId: shopOwner, type: "text", text: "Customer wants a discount" },
    ]);
    const transport = new TestTransport();
    const sleep = async (ms: number) => {
      transport.events.push(`sleep:${ms}`);
    };
    await new MessageProcessor(transport, brain, { sleep, mergeWindowMs: 0 }).enqueue(textMessage());
    expect(transport.events).toEqual([
      `typing:${customer}:on`,
      `text:${customer}:We have it`,
      `typing:${customer}:on`,
      "sleep:900",
      `image:${customer}:${photo}`,
      `text:${shopOwner}:Customer wants a discount`,
      `typing:${customer}:off`,
    ]);
    expect(reports).toHaveLength(1);
  });
});

describe("image actions", () => {
  it("sends catalog photos with their caption and acknowledges them", async () => {
    const { brain, reports } = scriptedBrain([
      { actionId: actionIds[0], recipientChatId: customer, type: "image", objectPath: "kurta-green.jpg", url: photo, caption: "Green kurta, Rs 3,500" },
    ]);
    const transport = new TestTransport();
    await new MessageProcessor(transport, brain, { sleep: noSleep, mergeWindowMs: 0 }).enqueue(textMessage());
    expect(transport.images).toEqual([{ chatId: customer, url: photo, caption: "Green kurta, Rs 3,500" }]);
    expect(reports).toEqual([{ acknowledgements: [{ actionId: actionIds[0], status: "sent", providerMessageId: "image-1" }] }]);
  });

  it("refuses image actions without a URL or outside the public catalog bucket", async () => {
    const storage = "https://project.supabase.co/storage/v1/object/public";
    const { brain, reports } = scriptedBrain([
      { actionId: actionIds[0], recipientChatId: customer, type: "image", objectPath: "kurta-green.jpg" },
      { actionId: actionIds[1], recipientChatId: customer, type: "image", objectPath: "x.jpg", url: `${storage}/inbound-media/other-customer.jpg` },
      { actionId: actionIds[2], recipientChatId: customer, type: "image", objectPath: "x.jpg", url: `${storage}/product-images/../inbound-media/x.jpg` },
      { actionId: actionIds[3], recipientChatId: customer, type: "image", objectPath: "x.jpg", url: "https://files.example.com/x.jpg" },
    ]);
    const transport = new TestTransport();
    await new MessageProcessor(transport, brain, { sleep: noSleep, mergeWindowMs: 0 }).enqueue(textMessage());
    expect(transport.images).toEqual([]);
    expect(reports).toEqual([
      {
        acknowledgements: [
          { actionId: actionIds[0], status: "failed", errorCode: "unsupported_action" },
          { actionId: actionIds[1], status: "failed", errorCode: "invalid_media_url" },
          { actionId: actionIds[2], status: "failed", errorCode: "invalid_media_url" },
          { actionId: actionIds[3], status: "failed", errorCode: "invalid_media_url" },
        ],
      },
    ]);
  });

  it("only fetches photos from the shop's own storage when its origin is configured", async () => {
    const { brain, reports } = scriptedBrain([
      { actionId: actionIds[0], recipientChatId: customer, type: "image", objectPath: "x.jpg", url: "https://other.supabase.co/storage/v1/object/public/product-images/x.jpg" },
      { actionId: actionIds[1], recipientChatId: customer, type: "image", objectPath: "x.jpg", url: "https://project.supabase.co/proxy/storage/v1/object/public/product-images/x.jpg" },
      { actionId: actionIds[2], recipientChatId: customer, type: "image", objectPath: "kurta-green.jpg", url: photo, caption: "Green kurta" },
    ]);
    const transport = new TestTransport();
    await new MessageProcessor(transport, brain, { sleep: noSleep, mergeWindowMs: 0, mediaOrigin: "https://project.supabase.co/" }).enqueue(textMessage());
    expect(transport.images).toEqual([{ chatId: customer, url: photo, caption: "Green kurta" }]);
    expect(reports).toEqual([
      {
        acknowledgements: [
          { actionId: actionIds[0], status: "failed", errorCode: "invalid_media_url" },
          { actionId: actionIds[1], status: "failed", errorCode: "invalid_media_url" },
          { actionId: actionIds[2], status: "sent", providerMessageId: "image-1" },
        ],
      },
    ]);
  });

  it("sends the caption as text when the photo can't be sent", async () => {
    const { brain, reports } = scriptedBrain([
      { actionId: actionIds[0], recipientChatId: customer, type: "image", objectPath: "kurta-green.jpg", url: photo, caption: "*Green kurta*\nRs 3,500" },
    ]);
    const transport = new TestTransport();
    let attempts = 0;
    transport.sendImage = async () => {
      attempts += 1;
      throw new NotSentError("Photo download failed: Image download failed with status 404");
    };
    await new MessageProcessor(transport, brain, { sleep: noSleep, mergeWindowMs: 0 }).enqueue(textMessage());
    expect(attempts).toBe(2);
    expect(transport.sent).toEqual([{ chatId: customer, text: "*Green kurta*\nRs 3,500" }]);
    expect(reports).toEqual([{ acknowledgements: [{ actionId: actionIds[0], status: "failed", errorCode: "send_failed" }] }]);
  });

  it("doesn't resend the caption when the photo may already have gone out", async () => {
    const { brain } = scriptedBrain([{ actionId: actionIds[0], recipientChatId: customer, type: "image", objectPath: "kurta-green.jpg", url: photo, caption: "*Green kurta*" }]);
    const transport = new TestTransport();
    transport.sendImage = async () => {
      // Failed after WhatsApp took the photo: the customer may already have it, caption included.
      throw new Error("Evaluation failed: Protocol error");
    };
    await new MessageProcessor(transport, brain, { sleep: noSleep, mergeWindowMs: 0 }).enqueue(textMessage());
    expect(transport.sent).toEqual([]);
  });
});

describe("owner messages", () => {
  const ownerMessage = {
    id: "true_98100000000068@lid_3EB0OWNER",
    chatId: "98100000000068@lid",
    alternateChatIds: ["923001234567@c.us"],
    occurredAt: "2026-09-28T12:01:00.000Z",
    type: "text" as const,
    text: "Main dekhti hoon",
  };

  it("reports what the owner typed to the brain, signed", async () => {
    const requests: Array<{ path: string; signature: string | null; body: unknown }> = [];
    const brain = new BrainClient({
      baseUrl: "https://brain.example.com",
      hmacSecret: secret,
      timeoutMs: 1_000,
      fetchImplementation: async (input, init) => {
        requests.push({
          path: new URL(input.toString()).pathname,
          signature: new Headers(init?.headers).get("x-huzaifa-signature"),
          body: JSON.parse(String(init?.body)),
        });
        return Response.json({ recorded: true, paused: true });
      },
    });
    await new MessageProcessor(new TestTransport(), brain, { sleep: noSleep }).reportOwnerMessage(ownerMessage);
    expect(requests).toEqual([
      {
        path: "/api/gateway/owner-messages",
        signature: expect.stringMatching(/^[a-f0-9]{64}$/),
        body: {
          messageId: ownerMessage.id,
          chatId: "98100000000068@lid",
          alternateChatIds: ["923001234567@c.us"],
          occurredAt: "2026-09-28T12:01:00.000Z",
          type: "text",
          text: "Main dekhti hoon",
        },
      },
    ]);
  });

  it("retries a brain outage, then logs instead of throwing", async () => {
    let calls = 0;
    const errors: string[] = [];
    const brain = new BrainClient({
      baseUrl: "https://brain.example.com",
      hmacSecret: secret,
      timeoutMs: 1_000,
      fetchImplementation: async () => {
        calls += 1;
        return new Response("down", { status: 503 });
      },
    });
    const logger = { warn() {}, error: (_details: Record<string, unknown>, message: string) => void errors.push(message) };
    const processor = new MessageProcessor(new TestTransport(), brain, { sleep: noSleep, logger });
    await expect(processor.reportOwnerMessage(ownerMessage)).resolves.toBeUndefined();
    expect(calls).toBe(3);
    expect(errors).toEqual(["Owner message report failed"]);
  });

  it("shows no typing and sends no fallback in a chat the owner is handling", async () => {
    const paths: string[] = [];
    const brain = new BrainClient({
      baseUrl: "https://brain.example.com",
      hmacSecret: secret,
      timeoutMs: 1_000,
      fetchImplementation: async (input) => {
        const path = new URL(input.toString()).pathname;
        paths.push(path);
        if (path === "/api/gateway/owner-messages") return json({ recorded: true, paused: true });
        return new Response("unauthorized", { status: 401 });
      },
    });
    const transport = new TestTransport();
    const processor = new MessageProcessor(transport, brain, { sleep: noSleep, mergeWindowMs: 0 });
    // The owner typed under the customer's @lid id; the customer's next message arrives under the phone id.
    await processor.reportOwnerMessage(ownerMessage);
    await processor.enqueue(textMessage({ chatId: customer }));
    expect(paths).toEqual(["/api/gateway/owner-messages", "/api/gateway/messages"]);
    expect(transport.events).toEqual([]);

    // Other chats are unaffected.
    const other = "923005550000@c.us";
    await processor.enqueue(textMessage({ id: "m2", chatId: other }));
    expect(transport.events).toEqual([`typing:${other}:on`, `text:${other}:${FALLBACK_REPLY}`, `typing:${other}:off`]);
  });

  it("goes back to normal once the brain answers the customer again (bot resumed)", async () => {
    let resumed = false;
    const brain = new BrainClient({
      baseUrl: "https://brain.example.com",
      hmacSecret: secret,
      timeoutMs: 1_000,
      fetchImplementation: async (input, init) => {
        const path = new URL(input.toString()).pathname;
        if (path === "/api/gateway/owner-messages") return json({ recorded: true, paused: true });
        if (path === "/api/gateway/deliveries") return json({ updated: 1 });
        const body = JSON.parse(String(init?.body));
        return json({ eventId: body.eventId, duplicate: false, actions: resumed ? [{ actionId: actionIds[0], recipientChatId: customer, type: "text", text: "Ji bataen" }] : [] });
      },
    });
    const transport = new TestTransport();
    const processor = new MessageProcessor(transport, brain, { sleep: noSleep, mergeWindowMs: 0 });
    await processor.reportOwnerMessage(ownerMessage);
    // The owner pressed "Resume bot": the brain answers again, and later turns show typing as usual.
    resumed = true;
    await processor.enqueue(textMessage({ id: "m1", chatId: customer }));
    expect(transport.events).toEqual([`text:${customer}:Ji bataen`]);
    transport.events.length = 0;
    await processor.enqueue(textMessage({ id: "m2", chatId: customer }));
    expect(transport.events).toEqual([`typing:${customer}:on`, `text:${customer}:Ji bataen`, `typing:${customer}:off`]);
  });

  it("validates the brain's answer", async () => {
    let answer: unknown = { recorded: true, paused: false };
    const brain = new BrainClient({
      baseUrl: "https://brain.example.com",
      hmacSecret: secret,
      timeoutMs: 1_000,
      fetchImplementation: async () => Response.json(answer),
    });
    const photoMessage = { messageId: "m1", chatId: customer, alternateChatIds: [], occurredAt: "2026-09-28T12:01:00.000Z", type: "image" as const };
    await expect(brain.reportOwnerMessage(photoMessage)).resolves.toEqual({ recorded: true, paused: false });
    answer = { recorded: "yes" };
    await expect(brain.reportOwnerMessage(photoMessage)).rejects.toThrow();
  });
});

describe("scheduled follow-ups", () => {
  const reminder = (index: number, recipientChatId = customer) => ({
    actionId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    recipientChatId,
    type: "text" as const,
    text: `Reminder ${index}`,
  });

  it("types, sends and reports each chat's follow-ups, one chat after another", async () => {
    const { brain, reports } = scriptedBrain([]);
    const transport = new TestTransport();
    const sleep = async (ms: number) => {
      transport.events.push(`sleep:${ms}`);
    };
    await new MessageProcessor(transport, brain, { sleep, scheduledGapMs: 4_000 }).sendScheduled([reminder(1), reminder(2, shopOwner)]);
    expect(transport.events).toEqual([
      `typing:${customer}:on`,
      "sleep:900",
      `text:${customer}:Reminder 1`,
      `typing:${customer}:off`,
      "sleep:4000",
      `typing:${shopOwner}:on`,
      "sleep:900",
      `text:${shopOwner}:Reminder 2`,
      `typing:${shopOwner}:off`,
    ]);
    expect(reports).toEqual([
      {
        acknowledgements: [
          { actionId: reminder(1).actionId, status: "sent", providerMessageId: "sent-1" },
          { actionId: reminder(2).actionId, status: "sent", providerMessageId: "sent-2" },
        ],
      },
    ]);
  });

  it("drops a follow-up for a chat whose customer is being answered or still typing", async () => {
    let releaseTurn = () => {};
    const brain = new BrainClient({
      baseUrl: "https://brain.example.com",
      hmacSecret: secret,
      timeoutMs: 5_000,
      fetchImplementation: async (input, init) => {
        if (input.toString().endsWith("/deliveries")) return json({ updated: 1 });
        const body = JSON.parse(String(init?.body));
        await new Promise<void>((resolve) => {
          releaseTurn = resolve;
        });
        return json({ eventId: body.eventId, duplicate: false, actions: [{ actionId: actionIds[0], recipientChatId: customer, type: "text", text: "Ji, M available hai" }] });
      },
    });
    const transport = new TestTransport();
    const processor = new MessageProcessor(transport, brain, { sleep: noSleep, mergeWindowMs: 0 });
    const turn = processor.enqueue(textMessage({ id: "m1", chatId: customer, text: "confirm" }));
    await vi.waitFor(() => expect(transport.events).toContain(`typing:${customer}:on`));
    await processor.sendScheduled([reminder(1)]);
    releaseTurn();
    await turn;
    expect(transport.sent.map((message) => message.text)).toEqual(["Ji, M available hai"]);

    // A burst still inside its merge window counts too.
    const { brain: idleBrain, reports } = scriptedBrain([]);
    const typing = new MessageProcessor(new TestTransport(), idleBrain, { sleep: noSleep, mergeWindowMs: 60_000 });
    void typing.enqueue(textMessage({ id: "m2", chatId: customer, text: "confirm" }));
    await typing.sendScheduled([reminder(2)]);
    expect(reports[0]).toEqual({ acknowledgements: [{ actionId: reminder(2).actionId, status: "failed", errorCode: "customer_active" }] });
    await typing.drain();
  });

  it("holds follow-ups back from a chat the owner is handling", async () => {
    const { brain, reports } = scriptedBrain([]);
    const transport = new TestTransport();
    const processor = new MessageProcessor(transport, brain, { sleep: noSleep });
    await processor.reportOwnerMessage({ id: "owner-1", chatId: customer, alternateChatIds: [], occurredAt: "2026-10-06T10:00:00.000Z", type: "text", text: "Ji main dekhta hoon" });
    await processor.sendScheduled([reminder(1), reminder(2, shopOwner)]);
    expect(transport.sent).toEqual([{ chatId: shopOwner, text: "Reminder 2" }]);
    expect(reports.at(-1)).toEqual({
      acknowledgements: [
        { actionId: reminder(1).actionId, status: "failed", errorCode: "owner_active" },
        { actionId: reminder(2).actionId, status: "sent", providerMessageId: "sent-1" },
      ],
    });
  });

  it("keeps the round's valid follow-ups when one action is malformed", async () => {
    const brain = new BrainClient({
      baseUrl: "https://brain.example.com",
      hmacSecret: secret,
      timeoutMs: 1_000,
      fetchImplementation: async () => json({ actions: [reminder(1), { ...reminder(2), text: "x".repeat(4_001) }] }),
    });
    await expect(brain.fetchFollowUps()).resolves.toEqual({ actions: [reminder(1)], invalid: 1 });
  });

  it("splits delivery reports into the brain's limit of 8", async () => {
    const { brain, reports } = scriptedBrain([]);
    const processor = new MessageProcessor(new TestTransport(), brain, { sleep: noSleep });
    await processor.sendScheduled(Array.from({ length: 10 }, (_, index) => reminder(index + 1, `92300000000${index}@c.us`)));
    expect(reports.map((report) => (report as { acknowledgements: unknown[] }).acknowledgements.length)).toEqual([8, 2]);
  });
});

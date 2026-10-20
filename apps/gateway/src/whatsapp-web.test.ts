import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "whatsapp-web.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TransportMessage, TransportOwnerMessage } from "./transport.js";
import { catchUpSince, WhatsAppWebTransport, type WhatsAppWebOptions } from "./whatsapp-web.js";

const { Client, MessageMedia } = pkg;
const customer = "923001234567@c.us";
const lid = "98100000000068@lid";
const photo = "https://project.supabase.co/storage/v1/object/public/product-images/kurta-green.jpg";
const silent = { info() {}, warn() {}, error() {} };

// No test may start a real browser: every client "starts" at once, with a stand-in page and browser.
const browserStarts = vi.spyOn(Client.prototype, "initialize").mockImplementation(async function (this: InstanceType<typeof Client>) {
  Object.assign(this, { pupPage: new EventEmitter(), pupBrowser: Object.assign(new EventEmitter(), { process: () => null }) });
});

type FakeClient = EventEmitter & Record<string, unknown> & { pupPage: EventEmitter; pupBrowser: EventEmitter };

// The browser is never started: the tests drive the transport through its WhatsApp client's events and methods.
function linkedTransport(options: WhatsAppWebOptions = {}, logger = silent) {
  const transport = new WhatsAppWebTransport(join(tmpdir(), "huzaifa-gateway-test-auth"), logger, undefined, undefined, options);
  const client = (transport as unknown as { client: FakeClient }).client;
  client.emit("ready");
  client.getContactLidAndPhone = vi.fn(async () => [{ lid, pn: customer }]);
  const ownerMessages: TransportOwnerMessage[] = [];
  transport.onOwnerMessage(async (message) => {
    ownerMessages.push(message);
  });
  return { transport, client, ownerMessages };
}

// What "message_create" delivers for a message this account sent.
function sentByAccount(overrides: Record<string, unknown> = {}) {
  return { fromMe: true, to: customer, type: "chat", body: "", timestamp: 1_790_000_000, id: { fromMe: true, remote: customer, id: "OWNER1" }, ...overrides };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("owner messages", () => {
  it("reports what the owner types, with the customer's other id", async () => {
    const { client, ownerMessages } = linkedTransport();
    client.emit("message_create", sentByAccount({ body: "Main dekhti hoon" }));
    await vi.waitFor(() => expect(ownerMessages).toHaveLength(1));
    expect(ownerMessages[0]).toEqual({
      id: `true_${customer}_OWNER1`,
      chatId: customer,
      alternateChatIds: [lid],
      occurredAt: new Date(1_790_000_000_000).toISOString(),
      type: "text",
      text: "Main dekhti hoon",
    });
  });

  it("does not mistake the gateway's own sends for the owner", async () => {
    const { transport, client, ownerMessages } = linkedTransport();
    let echoTo = customer;
    let sends = 0;
    client.sendMessage = vi.fn(async (_chatId: string, content: string) => {
      const id = { fromMe: true, remote: echoTo, id: `BOT${(sends += 1)}` };
      // WhatsApp can echo a send well before sendMessage returns its id, and can file it under the contact's other id.
      client.emit("message_create", sentByAccount({ to: echoTo, id, body: content }));
      await settle();
      return { id };
    });
    await transport.sendText(customer, "Here you go");
    echoTo = lid;
    await transport.sendText(customer, "Anything else?");
    await settle();
    expect(ownerMessages).toEqual([]);

    // The owner later typing the same words is still the owner.
    client.emit("message_create", sentByAccount({ body: "Here you go" }));
    await vi.waitFor(() => expect(ownerMessages.map((message) => message.text)).toEqual(["Here you go"]));
  });

  it("reports voice notes and other media the owner sends as a placeholder", async () => {
    const { client, ownerMessages } = linkedTransport();
    client.emit("message_create", sentByAccount({ type: "ptt", body: "", id: { fromMe: true, remote: customer, id: "VOICE1" } }));
    client.emit("message_create", sentByAccount({ type: "document", body: "invoice.pdf", id: { fromMe: true, remote: customer, id: "DOC1" } }));
    await vi.waitFor(() => expect(ownerMessages).toHaveLength(2));
    // A document's body is its file name, not something the owner typed.
    expect(ownerMessages.map((message) => [message.type, message.text])).toEqual([
      ["text", "[voice note]"],
      ["text", "[document]"],
    ]);
  });

  it("ignores incoming messages, groups, status updates and unsupported types", async () => {
    const { client, ownerMessages } = linkedTransport();
    client.emit("message_create", sentByAccount({ fromMe: false, body: "hi" }));
    client.emit("message_create", sentByAccount({ to: "120363000000000000@g.us", body: "group" }));
    client.emit("message_create", sentByAccount({ to: "status@broadcast", body: "status" }));
    client.emit("message_create", sentByAccount({ type: "e2e_notification" }));
    await settle();
    expect(ownerMessages).toEqual([]);
  });
});

// What the "message" event delivers for a customer's message.
function received(overrides: Record<string, unknown> = {}) {
  return {
    fromMe: false,
    from: customer,
    type: "chat",
    body: "",
    hasMedia: false,
    timestamp: 1_790_000_000,
    id: { fromMe: false, remote: customer, id: "IN1" },
    getContact: async () => ({ pushname: "Ayesha" }),
    ...overrides,
  };
}

describe("incoming messages", () => {
  it("hands each chat's messages over in arrival order, even when a photo is slow to download", async () => {
    const { transport, client } = linkedTransport();
    const seen: string[] = [];
    transport.onMessage(async (message) => {
      seen.push(message.text ?? "");
    });
    let finishDownload = () => {};
    const downloadMedia = () =>
      new Promise((resolve) => {
        finishDownload = () => resolve({ mimetype: "image/png", data: Buffer.from([1, 2, 3]).toString("base64") });
      });
    client.emit("message", received({ type: "image", hasMedia: true, body: "this one", downloadMedia, id: { fromMe: false, remote: customer, id: "IN1" } }));
    client.emit("message", received({ body: "in red?", id: { fromMe: false, remote: customer, id: "IN2" } }));
    await settle();
    expect(seen).toEqual([]);
    finishDownload();
    await vi.waitFor(() => expect(seen).toEqual(["this one", "in red?"]));
  });

  it("doesn't let a hung contact lookup hold the chat back", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { transport, client } = linkedTransport();
      const seen: string[] = [];
      transport.onMessage(async (message) => {
        seen.push(message.text ?? "");
      });
      client.emit("message", received({ body: "salam", getContact: () => new Promise(() => {}) }));
      await vi.advanceTimersByTimeAsync(14_000);
      expect(seen).toEqual([]);
      await vi.advanceTimersByTimeAsync(1_500);
      expect(seen).toEqual(["salam"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not wait for the answer before handing over the next message", async () => {
    const { transport, client } = linkedTransport();
    const seen: string[] = [];
    // A handler that answers slowly (the whole brain turn) must not hold back the customer's next message.
    transport.onMessage((message) => {
      seen.push(message.text ?? "");
      return new Promise(() => {});
    });
    client.emit("message", received({ body: "salam", id: { fromMe: false, remote: customer, id: "IN1" } }));
    client.emit("message", received({ body: "green kurta", id: { fromMe: false, remote: customer, id: "IN2" } }));
    await vi.waitFor(() => expect(seen).toEqual(["salam", "green kurta"]));
  });
});

describe("sending", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("downloads a catalog photo and sends it with its caption", async () => {
    const { transport, client, ownerMessages } = linkedTransport();
    vi.stubGlobal("fetch", async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }));
    const sendMessage = vi.fn(async (chatId: string, _media: unknown, _options?: unknown) => ({ id: { fromMe: true, remote: chatId, id: "IMG1" } }));
    client.sendMessage = sendMessage;

    await expect(transport.sendImage(customer, photo, "Green kurta")).resolves.toBe(`true_${customer}_IMG1`);
    const [chatId, media, options] = sendMessage.mock.calls[0]!;
    expect(chatId).toBe(customer);
    expect(media).toBeInstanceOf(MessageMedia);
    expect(media).toMatchObject({ mimetype: "image/png", data: Buffer.from([1, 2, 3]).toString("base64"), filename: "kurta-green.jpg" });
    expect(options).toEqual({ caption: "Green kurta" });

    client.emit("message_create", sentByAccount({ type: "image", body: "Green kurta", id: { fromMe: true, remote: customer, id: "IMG1" } }));
    await settle();
    expect(ownerMessages).toEqual([]);
  });

  it("marks sends that never reached WhatsApp as safe to retry", async () => {
    const { transport, client } = linkedTransport();
    vi.stubGlobal("fetch", async () => new Response("missing", { status: 404 }));
    client.sendMessage = vi.fn(async () => ({ id: { fromMe: true, remote: customer, id: "X" } }));
    await expect(transport.sendImage(customer, photo, "Green kurta")).rejects.toMatchObject({ name: "NotSentError" });
    expect(client.sendMessage).not.toHaveBeenCalled();

    // (Not "disconnected": that schedules a reconnect, which would start a real browser.)
    client.emit("auth_failure", "session revoked");
    await expect(transport.sendText(customer, "hi")).rejects.toMatchObject({ name: "NotSentError" });
  });

  it("shows and clears typing, and never throws for it", async () => {
    const { transport, client } = linkedTransport();
    const chat = { sendStateTyping: vi.fn(async () => {}), clearState: vi.fn(async () => true) };
    client.getChatById = vi.fn(async () => chat);
    await transport.setTyping(customer, true);
    await transport.setTyping(customer, false);
    expect(chat.sendStateTyping).toHaveBeenCalledOnce();
    expect(chat.clearState).toHaveBeenCalledOnce();

    client.getChatById = vi.fn(async () => {
      throw new Error("Target closed");
    });
    await expect(transport.setTyping(customer, true)).resolves.toBeUndefined();
    client.getChatById = vi.fn(async () => undefined);
    await expect(transport.setTyping(customer, true)).resolves.toBeUndefined();
  });
});

const NOW = Date.parse("2026-09-29T12:00:00.000Z");
const MINUTE = 60_000;
// A WhatsApp timestamp (Unix seconds) `ago` milliseconds before the fake clock's present.
const sentAgo = (ago: number) => Math.floor((Date.now() - ago) / 1_000);

// A transport started the way index.ts starts it, on fake timers. connect() makes the current client ready,
// answering health checks and listing `chats()` the way WhatsApp Web would.
async function startedTransport(options: WhatsAppWebOptions = {}) {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  browserStarts.mockClear();
  const transport = new WhatsAppWebTransport(join(tmpdir(), "huzaifa-gateway-test-auth"), silent, undefined, undefined, options);
  const current = () => (transport as unknown as { client: FakeClient }).client;
  await transport.initialize();
  const connect = (chats: () => unknown[] = () => []) => {
    const client = current();
    client.getState = vi.fn(async () => "CONNECTED");
    client.getChats = vi.fn(async () => chats());
    client.emit("ready");
    return client;
  };
  return { transport, current, connect };
}

// A message as WhatsApp Web keeps it in a chat.
function stored(chatId: string, id: string, overrides: Record<string, unknown> = {}) {
  return received({ from: chatId, id: { fromMe: false, remote: chatId, id }, ...overrides });
}

function reply(chatId: string, id: string, timestamp: number) {
  return { fromMe: true, from: "923110000000@c.us", to: chatId, type: "chat", body: "Ji, available hai", timestamp, id: { fromMe: true, remote: chatId, id } };
}

// A chat as getChats() lists it: unread counts the messages after the last reply, and fetchMessages returns the
// latest `limit` messages.
function chat(id: string, messages: Array<Record<string, unknown>>, overrides: Record<string, unknown> = {}) {
  const last = messages[messages.length - 1];
  return {
    id: { _serialized: id },
    isGroup: id.endsWith("@g.us"),
    unreadCount: messages.length - 1 - messages.map((message) => message.fromMe).lastIndexOf(true),
    timestamp: last?.timestamp ?? 0,
    lastMessage: last,
    fetchMessages: vi.fn(async ({ limit }: { limit: number }) => messages.slice(-limit)),
    ...overrides,
  };
}

describe("liveness", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("restarts the browser on the same session after about three minutes without a healthy answer, not after a blip", async () => {
    const logout = vi.spyOn(Client.prototype, "logout");
    const { transport, current, connect } = await startedTransport();
    const client = connect();
    const answers: Array<() => Promise<unknown>> = [
      async () => "CONNECTED",
      async () => "OPENING",
      async () => "CONNECTED",
      async () => {
        throw new Error("Protocol error (Runtime.callFunctionOn): Target closed");
      },
      async () => null,
      () => new Promise(() => {}),
    ];
    client.getState = vi.fn(() => answers.shift()!());

    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(transport.getSessionSnapshot()).toMatchObject({ state: "ready", healthy: false });
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(transport.getSessionSnapshot()).toMatchObject({ state: "ready", healthy: true, lastHealthCheckAt: new Date(NOW + 3 * MINUTE).toISOString() });

    // An error, no state, then no answer at all: three failures in a row. The last one counts once it times out.
    await vi.advanceTimersByTimeAsync(3 * MINUTE + 19_000);
    expect(browserStarts).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(transport.getSessionSnapshot()).toMatchObject({ state: "disconnected", lastAutoRestartReason: "WhatsApp Web stopped responding" });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(browserStarts).toHaveBeenCalledTimes(2);
    expect(current()).not.toBe(client);
    expect(transport.getSessionSnapshot().state).toBe("starting");
    expect(logout).not.toHaveBeenCalled();
    logout.mockRestore();
  });

  it("restarts at once when the page crashes, and ignores the dying browser afterwards", async () => {
    const { current, connect } = await startedTransport();
    const client = connect();
    client.pupPage.emit("error", new Error("Page crashed!"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(browserStarts).toHaveBeenCalledTimes(2);
    expect(current()).not.toBe(client);

    // The old browser finally going away must not restart the new session; the new one dying does.
    const fresh = connect();
    client.pupBrowser.emit("disconnected");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(browserStarts).toHaveBeenCalledTimes(2);
    fresh.pupBrowser.emit("disconnected");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(browserStarts).toHaveBeenCalledTimes(3);
  });

  it("gives up after six automatic restarts in an hour and asks the owner to check the phone", async () => {
    const { transport, connect } = await startedTransport();
    const crash = () => connect().pupPage.emit("error", new Error("Page crashed!"));
    for (let restart = 0; restart < 6; restart += 1) {
      crash();
      await vi.advanceTimersByTimeAsync(2_000);
    }
    expect(browserStarts).toHaveBeenCalledTimes(7);
    crash();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(browserStarts).toHaveBeenCalledTimes(7);
    expect(transport.getSessionSnapshot()).toMatchObject({ state: "error", detail: expect.stringContaining("phone") });

    // "Restart session" in the admin starts over, with a fresh budget.
    const restarted = transport.reinitialize();
    await vi.advanceTimersByTimeAsync(2_000);
    await restarted;
    crash();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(browserStarts).toHaveBeenCalledTimes(9);
    expect(transport.getSessionSnapshot().state).toBe("starting");
  });
});

describe("missed messages", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("answers unread messages that never came through, longest-waiting chat first, skipping what needs no answer", async () => {
    const { transport, connect } = await startedTransport();
    const handed: TransportMessage[] = [];
    transport.onMessage(async (message) => {
      handed.push(message);
    });
    const second = "923339876543@c.us";
    const third = "923451112223@c.us";
    const group = "120363000000000000@g.us";
    const photoData = Buffer.from([1, 2, 3]).toString("base64");
    const chats = [
      // WhatsApp's unread count can cover more than the messages (a missed call); the reply bounds what's unanswered.
      chat(
        customer,
        [
          stored(customer, "A1", { body: "salam", timestamp: sentAgo(200 * MINUTE) }),
          reply(customer, "A2", sentAgo(199 * MINUTE)),
          stored(customer, "A3", { body: "green kurta price?", timestamp: sentAgo(120 * MINUTE) }),
          stored(customer, "A4", { type: "image", hasMedia: true, body: "this one", timestamp: sentAgo(119 * MINUTE), downloadMedia: async () => ({ mimetype: "image/jpeg", data: photoData }) }),
          stored(customer, "A5", { type: "ptt", timestamp: sentAgo(118 * MINUTE) }),
        ],
        { unreadCount: 5 },
      ),
      chat(lid, [stored(lid, "B1", { body: "assalam o alaikum", timestamp: sentAgo(30 * MINUTE) }), stored(lid, "B2", { body: "M size hai?", timestamp: sentAgo(29 * MINUTE) })]),
      chat(second, [stored(second, "C1", { body: "kal wali baat", timestamp: sentAgo(7 * 60 * MINUTE) }), stored(second, "C2", { body: "order confirm karein", timestamp: sentAgo(300 * MINUTE) })]),
      chat(third, [stored(third, "D1", { body: "too long ago", timestamp: sentAgo(7 * 60 * MINUTE) })]),
      chat(group, [stored(group, "G1", { body: "group chatter", timestamp: sentAgo(MINUTE) })]),
      chat("status@broadcast", [stored("status@broadcast", "S1", { body: "status", timestamp: sentAgo(MINUTE) })]),
    ];
    const client = connect(() => chats);
    // One of them did come through live.
    client.emit("message", stored(lid, "B1", { body: "assalam o alaikum", timestamp: sentAgo(30 * MINUTE) }));
    await vi.advanceTimersByTimeAsync(15_000);

    expect(handed.map((message) => message.text)).toEqual(["assalam o alaikum", "order confirm karein", "green kurta price?", "this one", "M size hai?"]);
    expect(handed[3]).toMatchObject({ chatId: customer, media: { mimeType: "image/jpeg", dataBase64: photoData }, occurredAt: new Date((NOW / 1_000 - 119 * 60) * 1_000).toISOString() });
    for (const skipped of chats.slice(3)) expect(skipped.fetchMessages).not.toHaveBeenCalled();
    expect(transport.getSessionSnapshot()).toMatchObject({ recoveredMessages: 4, lastInboundAt: new Date(NOW).toISOString() });

    // Nothing is handed over twice: not when WhatsApp reports a recovered message late, nor by the next scan.
    client.emit("message", stored(lid, "B2", { body: "M size hai?", timestamp: sentAgo(29 * MINUTE) }));
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(handed).toHaveLength(5);
    expect(browserStarts).toHaveBeenCalledOnce();
  });

  it("answers a backlog one chat at a time, giving each at most a minute", async () => {
    const { transport, connect } = await startedTransport();
    const handed: string[] = [];
    transport.onMessage((message) => {
      handed.push(message.text ?? "");
      if (message.text === "first") return new Promise((resolve) => setTimeout(resolve, 10_000));
      // The brain never finishes this one.
      if (message.text === "second") return new Promise(() => {});
      return Promise.resolve();
    });
    const texts = ["first", "second", "third"];
    const ids = ["923001111111@c.us", "923002222222@c.us", "923003333333@c.us"];
    connect(() => ids.map((id, index) => chat(id, [stored(id, `M${index}`, { body: texts[index], timestamp: sentAgo((30 - index) * MINUTE) })])));

    await vi.advanceTimersByTimeAsync(15_000);
    expect(handed).toEqual(["first"]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(handed).toEqual(["first", "second"]);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(handed).toEqual(["first", "second"]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(handed).toEqual(["first", "second", "third"]);
  });

  it("restarts when messages stop coming through while connected, after answering them, at most every ten minutes", async () => {
    const { transport, connect } = await startedTransport();
    const handed: string[] = [];
    transport.onMessage(async (message) => {
      handed.push(message.text ?? "");
    });
    const messages: Array<Record<string, unknown>> = [];
    const chats = () => (messages.length ? [chat(customer, messages)] : []);
    connect(chats);

    // Two minutes after connecting, a customer writes. WhatsApp shows it unread but never reports it.
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    messages.push(stored(customer, "LOST1", { body: "hello?", timestamp: sentAgo(0) }));
    await vi.advanceTimersByTimeAsync(3 * MINUTE);
    expect(handed).toEqual(["hello?"]);
    expect(transport.getSessionSnapshot()).toMatchObject({ state: "disconnected", lastAutoRestartReason: "messages stopped arriving", recoveredMessages: 1 });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(browserStarts).toHaveBeenCalledTimes(2);

    // The fresh browser is just as deaf: missed messages are still answered, but no second restart so soon.
    connect(chats);
    await vi.advanceTimersByTimeAsync(MINUTE);
    messages.push(stored(customer, "LOST2", { body: "anyone there?", timestamp: sentAgo(0) }));
    await vi.advanceTimersByTimeAsync(4 * MINUTE);
    expect(handed).toEqual(["hello?", "anyone there?"]);
    expect(browserStarts).toHaveBeenCalledTimes(2);
    expect(transport.getSessionSnapshot().state).toBe("ready");

    // Ten minutes after the first restart, it may try again.
    messages.push(stored(customer, "LOST3", { body: "??", timestamp: sentAgo(0) }));
    await vi.advanceTimersByTimeAsync(5 * MINUTE + 2_000);
    expect(handed).toEqual(["hello?", "anyone there?", "??"]);
    expect(browserStarts).toHaveBeenCalledTimes(3);
  });

  it("catches up soon after the socket drops and comes back, without taking the gap for broken hooks", async () => {
    const { transport, connect } = await startedTransport();
    const handed: string[] = [];
    transport.onMessage(async (message) => {
      handed.push(message.text ?? "");
    });
    const messages: Array<Record<string, unknown>> = [];
    const client = connect(() => (messages.length ? [chat(customer, messages)] : []));
    await vi.advanceTimersByTimeAsync(90_000);
    client.emit("change_state", "OPENING");
    messages.push(stored(customer, "GAP1", { body: "still open?", timestamp: sentAgo(0) }));
    await vi.advanceTimersByTimeAsync(30_000);
    client.emit("change_state", "CONNECTED");

    await vi.advanceTimersByTimeAsync(15_000);
    expect(handed).toEqual(["still open?"]);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(handed).toEqual(["still open?"]);
    expect(browserStarts).toHaveBeenCalledOnce();
    expect(transport.getSessionSnapshot()).toMatchObject({ state: "ready", healthy: true });
  });
});

describe("saved contacts", () => {
  const friend = "923215550000@c.us";
  const savedContact = async () => ({ pushname: "Bilal", isMyContact: true });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("are treated like anyone else unless the filter is on", async () => {
    const { transport, client } = linkedTransport();
    const handed: string[] = [];
    transport.onMessage(async (message) => {
      handed.push(message.text ?? "");
    });
    client.emit("message", stored(friend, "F1", { body: "dinner?", getContact: savedContact }));
    await vi.waitFor(() => expect(handed).toEqual(["dinner?"]));
    expect(transport.getSessionSnapshot().ignoredSavedContacts).toBeUndefined();
  });

  it("are never handed over when the filter is on, live or in a catch-up, and their photos never downloaded", async () => {
    const { transport, connect } = await startedTransport({ ignoreSavedContacts: true });
    const handed: string[] = [];
    transport.onMessage(async (message) => {
      handed.push(message.text ?? "");
    });
    const downloadMedia = vi.fn();
    const client = connect(() => [chat(friend, [stored(friend, "F2", { body: "missed call?", timestamp: sentAgo(10 * MINUTE), getContact: savedContact })])]);
    client.emit("message", stored(friend, "F1", { type: "image", hasMedia: true, body: "dinner?", getContact: savedContact, downloadMedia }));
    client.emit("message", stored(customer, "C1", { body: "kurta price?" }));
    await vi.advanceTimersByTimeAsync(15_000);

    expect(handed).toEqual(["kurta price?"]);
    expect(downloadMedia).not.toHaveBeenCalled();
    expect(transport.getSessionSnapshot()).toMatchObject({ ignoredSavedContacts: 2, recoveredMessages: 0 });
  });

  it("keep what the owner types to them private, looking each chat up at most every ten minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const { client, ownerMessages } = linkedTransport({ ignoreSavedContacts: true });
    client.getContactLidAndPhone = vi.fn(async () => []);
    const getContactById = vi.fn(async (id: string) => ({ isMyContact: id === friend }));
    client.getContactById = getContactById;
    const lookups = (id: string) => getContactById.mock.calls.filter(([looked]) => looked === id).length;
    const ownerTypes = async (to: string, id: string, body: string) => {
      client.emit("message_create", sentByAccount({ to, body, id: { fromMe: true, remote: to, id } }));
      await settle();
    };

    await ownerTypes(friend, "OWN1", "kal milte hain");
    await ownerTypes(friend, "OWN2", "9 baje");
    await ownerTypes(customer, "OWN3", "Main dekhti hoon");
    expect(ownerMessages.map((message) => message.text)).toEqual(["Main dekhti hoon"]);
    expect(lookups(friend)).toBe(1);

    vi.setSystemTime(NOW + 10 * MINUTE + 1);
    await ownerTypes(friend, "OWN4", "pohanch gaye?");
    expect(lookups(friend)).toBe(2);
    expect(ownerMessages).toHaveLength(1);
  });

  it("leave an incoming message alone when the contact can't be looked up", async () => {
    const { transport, client } = linkedTransport({ ignoreSavedContacts: true });
    const handed: string[] = [];
    transport.onMessage(async (message) => {
      handed.push(message.text ?? "");
    });
    client.emit("message", stored(friend, "F1", { body: "kidhar ho?", getContact: async () => Promise.reject(new Error("Evaluation failed")) }));
    client.emit("message", stored(customer, "C1", { body: "kurta price?", getContact: async () => ({ pushname: "Sana", isMyContact: false }) }));
    await vi.waitFor(() => expect(handed).toEqual(["kurta price?"]));
    expect(transport.getSessionSnapshot().ignoredSavedContacts).toBe(1);
  });

  it("can't hide the owner's messages when the lookup fails: reported as before, with one warning", async () => {
    const warn = vi.fn();
    const { client, ownerMessages } = linkedTransport({ ignoreSavedContacts: true }, { ...silent, warn });
    client.getContactById = vi.fn(async () => {
      throw new Error("Evaluation failed");
    });
    client.emit("message_create", sentByAccount({ body: "first", id: { fromMe: true, remote: customer, id: "OWN1" } }));
    await vi.waitFor(() => expect(ownerMessages).toHaveLength(1));
    client.emit("message_create", sentByAccount({ body: "second", id: { fromMe: true, remote: customer, id: "OWN2" } }));
    await vi.waitFor(() => expect(ownerMessages).toHaveLength(2));
    // Failures aren't cached: the next message tries again.
    expect(client.getContactById).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe("late answers", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("answers the last hour at night, last night's messages in the morning, six hours by day", () => {
    const at = (iso: string) => Date.parse(iso);
    expect(catchUpSince(at("2026-09-29T12:00:00Z"))).toBe(at("2026-09-29T06:00:00Z")); // 5pm in Pakistan
    expect(catchUpSince(at("2026-09-29T21:30:00Z"))).toBe(at("2026-09-29T20:30:00Z")); // 2:30am
    expect(catchUpSince(at("2026-09-30T05:00:00Z"))).toBe(at("2026-09-29T16:00:00Z")); // 10am: everything since 9pm
    expect(catchUpSince(at("2026-09-30T07:00:00Z"))).toBe(at("2026-09-30T01:00:00Z")); // noon: six hours again
  });

  it("leaves a message from hours ago for the morning when it comes back at night", async () => {
    const night = Date.parse("2026-09-29T21:30:00.000Z");
    const { transport, connect } = await startedTransport();
    vi.setSystemTime(night);
    const handed: string[] = [];
    transport.onMessage(async (message) => {
      handed.push(message.text ?? "");
    });
    const early = "923004444444@c.us";
    connect(() => [
      chat(early, [stored(early, "N1", { body: "9 baje wala message", timestamp: sentAgo(5 * 60 * MINUTE) })]),
      chat(customer, [stored(customer, "N2", { body: "abhi bhi khula hai?", timestamp: sentAgo(20 * MINUTE) })]),
    ]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(handed).toEqual(["abhi bhi khula hai?"]);
  });

  it("never answers chats from before the number was linked, also after a restart", async () => {
    const authPath = mkdtempSync(join(tmpdir(), "huzaifa-link-"));
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const start = async () => {
      const transport = new WhatsAppWebTransport(authPath, silent);
      const handed: string[] = [];
      transport.onMessage(async (message) => {
        handed.push(message.text ?? "");
      });
      await transport.initialize();
      return { transport, handed, client: (transport as unknown as { client: FakeClient }).client };
    };
    const messages = [stored(customer, "OLD1", { body: "purani baat", timestamp: sentAgo(30 * MINUTE) })];
    const connect = (client: FakeClient) => {
      client.getState = vi.fn(async () => "CONNECTED");
      client.getChats = vi.fn(async () => [chat(customer, messages)]);
      client.emit("ready");
    };

    // The owner scans the QR: the phone's existing unread chats are its own history.
    const first = await start();
    // Scanned at once: the QR image may still be drawing when the session is ready, and must not hide that.
    first.client.emit("qr", "2@qr-payload");
    vi.setSystemTime(NOW + 10);
    connect(first.client);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(first.handed).toEqual([]);
    expect(Number(readFileSync(join(authPath, "linked-at"), "utf8"))).toBe(NOW + 10);

    // After linking, a missed message is answered as usual; after a restart the old one still isn't.
    messages.push(stored(customer, "NEW1", { body: "naya message", timestamp: sentAgo(-MINUTE) }));
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(first.handed).toEqual(["naya message"]);
    // Closing the browser waits a moment for it to release the session folder.
    const closed = first.transport.destroy();
    await vi.advanceTimersByTimeAsync(2_000);
    await closed;
    const second = await start();
    connect(second.client);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(second.handed).toEqual(["naya message"]);
  });
});

describe("chat list health", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("tells the admin when missed messages can't be looked for, and when that works again", async () => {
    const { transport, connect } = await startedTransport();
    const client = connect();
    client.getChats = vi.fn(async () => Promise.reject(new Error("DataError: Failed to execute 'get' on 'IDBObjectStore'")));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(transport.getSessionSnapshot().missedMessageCheck).toBe(false);
    client.getChats = vi.fn(async () => []);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(transport.getSessionSnapshot().missedMessageCheck).toBe(true);
  });
});

describe("unread chat lookup", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads only the chats with unread messages, never the whole chat list", async () => {
    const { transport, connect } = await startedTransport();
    const handed: string[] = [];
    transport.onMessage(async (message) => {
      handed.push(message.text ?? "");
    });
    const group = "120363000000000000@g.us";
    const waiting = chat(customer, [stored(customer, "U1", { body: "price?", timestamp: sentAgo(20 * MINUTE) })]);
    const client = connect();
    client.getChats = vi.fn(async () => {
      throw new Error("too slow on a big account");
    });
    (client.pupPage as unknown as { evaluate: unknown }).evaluate = vi.fn(async () => [
      { id: group, t: sentAgo(MINUTE) },
      { id: customer, t: sentAgo(20 * MINUTE) },
    ]);
    client.getChatById = vi.fn(async (id: string) => (id === customer ? waiting : undefined));
    await vi.advanceTimersByTimeAsync(15_000);

    expect(handed).toEqual(["price?"]);
    expect(client.getChats).not.toHaveBeenCalled();
    expect(client.getChatById).toHaveBeenCalledExactlyOnceWith(customer);
    expect(transport.getSessionSnapshot().missedMessageCheck).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import type { CatalogItem } from "../catalog/search";
import { DEFAULT_SHOP_SETTINGS, type ShopSettings } from "../shop/settings";
import { EMPTY_DETAILS, orderFingerprint, type OrderDraft } from "./cart";
import { planFollowUps, renderCartReminder, renderOwnerDigest, summaryStillValid, type CartCandidate, type PlacedCandidate } from "./followups";

const kurta: CatalogItem = {
  id: "11111111-1111-4111-8111-111111111111",
  sku: "SKU-RUBY",
  name: "Ruby Kurta",
  description: "",
  category: "kurta",
  color: "red",
  material: null,
  styleTags: [],
  aliases: [],
  pricePkr: 3200,
  createdAt: "2026-09-01T00:00:00Z",
  variants: [
    { size: "M", normalizedSize: "M", stockQty: 2 },
    { size: "L", normalizedSize: "L", stockQty: 0 },
  ],
  imagePaths: [],
  aiText: "",
};
const products = new Map([[kurta.id, kurta]]);
const shop: ShopSettings = { ...DEFAULT_SHOP_SETTINGS, deliveryFeePkr: 250, freeDeliveryFromPkr: null, cartReminderMinutes: 60, ownerFollowUps: true };
const pricing = { deliveryFeePkr: 250, freeDeliveryFromPkr: null };

// 12:00 in Karachi (UTC+5), inside the default 11am–10pm hours.
const NOON = new Date("2026-10-06T07:00:00.000Z");
const minutesBefore = (minutes: number, now = NOON) => new Date(now.getTime() - minutes * 60_000).toISOString();

function draft(overrides: Partial<OrderDraft> = {}): OrderDraft {
  const base: OrderDraft = {
    id: "order-1",
    number: null,
    lines: [{ productId: kurta.id, size: "M", normalizedSize: "M", quantity: 1 }],
    details: { ...EMPTY_DETAILS, name: "Ali Raza", phone: "923001234567", address: "House 12, Street 4, Gulberg", city: "Lahore" },
    summaryFingerprint: null,
    ...overrides,
  };
  return { ...base, summaryFingerprint: overrides.summaryFingerprint ?? orderFingerprint(base, products, pricing) };
}

function cart(overrides: Partial<CartCandidate> = {}): CartCandidate {
  return {
    orderId: "order-1",
    conversationId: "conversation-1",
    conversationState: "bot_active",
    chatId: "923001234567@c.us",
    language: "roman_ur",
    customerName: "Ali Raza",
    whatsappPhone: "923001234567",
    draft: draft(),
    itemsLabel: "Ruby Kurta (M)",
    totalPkr: 3450,
    summarySentAt: minutesBefore(70),
    reminderSentAt: null,
    cartAlertedAt: null,
    lastInboundAt: minutesBefore(71),
    ...overrides,
  };
}

const plan = (carts: CartCandidate[], options: { now?: Date; shop?: ShopSettings; placed?: PlacedCandidate[] } = {}) =>
  planFollowUps({ now: options.now ?? NOON, shop: options.shop ?? shop, carts, placed: options.placed ?? [], products });

describe("customer reminders", () => {
  it("reminds a customer who went quiet after the summary, once the delay has passed", () => {
    expect(plan([cart()]).reminders.map((item) => item.orderId)).toEqual(["order-1"]);
    expect(plan([cart({ summarySentAt: minutesBefore(30), lastInboundAt: minutesBefore(31) })]).reminders).toEqual([]);
  });

  it("leaves the chat alone when the customer wrote after seeing the summary", () => {
    expect(plan([cart({ lastInboundAt: minutesBefore(10) })]).reminders).toEqual([]);
  });

  it("never reminds twice, and not chats with the owner or waiting for a person", () => {
    expect(plan([cart({ reminderSentAt: minutesBefore(5) })]).reminders).toEqual([]);
    expect(plan([cart({ conversationState: "human_active" })]).reminders).toEqual([]);
    expect(plan([cart({ conversationState: "handoff_requested" })]).reminders).toEqual([]);
  });

  it("stays quiet at night, even for a shop that is open all day", () => {
    const night = new Date("2026-10-06T18:30:00.000Z"); // 11:30pm in Karachi
    const allDay = { ...shop, openHour: 0, closeHour: 24 };
    expect(plan([cart({ summarySentAt: minutesBefore(70, night), lastInboundAt: minutesBefore(71, night) })], { now: night, shop: allDay }).reminders).toEqual([]);
  });

  it("skips summaries that no longer hold: price changed or the size sold out", () => {
    const repriced = new Map([[kurta.id, { ...kurta, pricePkr: 3500 }]]);
    expect(summaryStillValid(draft(), repriced, pricing)).toBe(false);
    const soldOut = draft({ lines: [{ productId: kurta.id, size: "L", normalizedSize: "L", quantity: 1 }] });
    expect(summaryStillValid(soldOut, products, pricing)).toBe(false);
    expect(plan([cart({ draft: soldOut })]).reminders).toEqual([]);
  });

  it("is off when the owner turned reminders or orders off, and for carts older than a day", () => {
    expect(plan([cart()], { shop: { ...shop, cartReminderMinutes: null } }).reminders).toEqual([]);
    expect(plan([cart()], { shop: { ...shop, ordersEnabled: false } }).reminders).toEqual([]);
    expect(plan([cart({ summarySentAt: minutesBefore(23 * 60), lastInboundAt: minutesBefore(23 * 60 + 1) })]).reminders).toEqual([]);
  });

  it("sends a few reminders per round at most", () => {
    const carts = Array.from({ length: 5 }, (_, index) => cart({ orderId: `order-${index}` }));
    expect(plan(carts).reminders).toHaveLength(3);
  });

  it("writes in the customer's language, with their first name when it looks like one", () => {
    expect(renderCartReminder({ orderId: "a", language: "roman_ur", customerName: "Ali Raza" })).toMatch(/^Ali ji, .*\*confirm\*/);
    expect(renderCartReminder({ orderId: "a", language: "en", customerName: null })).toMatch(/^Hi[!,] .*confirm/);
    expect(renderCartReminder({ orderId: "a", language: "ur", customerName: "علی" })).toMatch(/^علی جی، /);
    expect(renderCartReminder({ orderId: "a", language: "en", customerName: "0300 1234567" })).not.toContain("0300");
    // Stable per order, so a repeated round can't change the wording.
    expect(renderCartReminder({ orderId: "b", language: "en", customerName: "Sara" })).toBe(renderCartReminder({ orderId: "b", language: "en", customerName: "Sara" }));
  });
});

describe("owner digest", () => {
  const placed: PlacedCandidate = { orderId: "order-9", orderNumber: 1024, customer: "Sara", itemsLabel: "Ruby Kurta (M)", totalPkr: 3450, placedAt: minutesBefore(180) };

  it("tells the owner about carts quiet for a while, after the customer's reminder had its chance", () => {
    expect(plan([cart({ summarySentAt: minutesBefore(130), lastInboundAt: minutesBefore(131), reminderSentAt: minutesBefore(70) })]).cartAlerts).toHaveLength(1);
    // Reminder just went out: give it an hour first.
    expect(plan([cart({ summarySentAt: minutesBefore(130), lastInboundAt: minutesBefore(131), reminderSentAt: minutesBefore(20) })]).cartAlerts).toEqual([]);
    // Reminder going out in this round (held back overnight): the owner waits too.
    expect(plan([cart({ summarySentAt: minutesBefore(600), lastInboundAt: minutesBefore(601) })]).cartAlerts).toEqual([]);
  });

  it("skips carts the owner is already handling, alerted ones, and closed hours", () => {
    const quiet = { summarySentAt: minutesBefore(200), lastInboundAt: minutesBefore(201), reminderSentAt: minutesBefore(130) };
    expect(plan([cart({ ...quiet, conversationState: "human_active" })]).cartAlerts).toEqual([]);
    expect(plan([cart({ ...quiet, cartAlertedAt: minutesBefore(60) })]).cartAlerts).toEqual([]);
    const closed = new Date("2026-10-06T19:00:00.000Z"); // midnight in Karachi
    expect(plan([cart(quiet)], { now: closed, placed: [placed] })).toMatchObject({ cartAlerts: [], confirmReminders: [] });
  });

  it("reminds the owner about placed orders still waiting for confirmation", () => {
    expect(plan([], { placed: [placed] }).confirmReminders).toHaveLength(1);
    expect(plan([], { placed: [{ ...placed, placedAt: minutesBefore(60) }] }).confirmReminders).toEqual([]);
    expect(plan([], { placed: [placed], shop: { ...shop, ownerFollowUps: false } }).confirmReminders).toEqual([]);
  });

  it("puts everything in one message with links", () => {
    const text = renderOwnerDigest({
      carts: [cart({ reminderSentAt: minutesBefore(70), summarySentAt: minutesBefore(130) })],
      placed: [placed],
      now: NOON,
      adminBaseUrl: "https://shop.example.com/",
    });
    expect(text).toContain("🛒 A cart is waiting for a confirm");
    expect(text).toContain("1. Ali Raza — Ruby Kurta (M) — Rs 3,450 — summary 2 h ago, reminded — +923001234567 (https://wa.me/923001234567)");
    expect(text).toContain("Open carts: https://shop.example.com/admin/orders?tab=carts");
    expect(text).toContain("⏳ An order is waiting for your confirmation");
    expect(text).toContain("#1024 Sara — Ruby Kurta (M) — Rs 3,450 — placed 3 h ago — https://shop.example.com/admin/orders/order-9");
    expect(renderOwnerDigest({ carts: [], placed: [], now: NOON })).toBeNull();
  });

  it("stays within one WhatsApp text the gateway accepts, however long the product names", () => {
    const longLabel = `${"Very Long Embroidered Chiffon Formal Three Piece Suit With Dupatta ".repeat(3)} (XL) ×2, another long item name +3 more`;
    const carts = Array.from({ length: 5 }, (_, index) => cart({ orderId: `order-${index}`, itemsLabel: longLabel, customerName: "A".repeat(120), reminderSentAt: minutesBefore(70) }));
    const orders = Array.from({ length: 5 }, (_, index) => ({ ...placed, orderId: `placed-${index}`, itemsLabel: longLabel, customer: "B".repeat(120) }));
    const text = renderOwnerDigest({ carts, placed: orders, now: NOON, adminBaseUrl: "https://shop.example.com" })!;
    expect(text.length).toBeLessThanOrEqual(4_000);
    expect(text).toContain("5 orders are waiting for your confirmation");
  });
});

import type { Language } from "@huzaifa/contracts";
import { formatPrice } from "../agent/compose";
import { normalizeSize } from "../catalog/admin/validation";
import type { CatalogItem } from "../catalog/search";
import { karachiTime, shopStatus, type ShopSettings } from "../shop/settings";
import { orderFingerprint, type DeliveryPricing, type OrderDraft } from "./cart";

// Follow-ups the brain hands the gateway every few minutes: one reminder to a customer who saw the priced
// summary and went quiet, and a note to the owner about carts that went cold and placed orders nobody has
// confirmed yet. Everything here is decided by code; nothing is written by the model.

export type CartCandidate = {
  orderId: string;
  conversationId: string;
  conversationState: "bot_active" | "handoff_requested" | "human_active";
  chatId: string;
  language: Language;
  // The name they gave for the order, else the one in their profile.
  customerName: string | null;
  whatsappPhone: string | null;
  // Lines and details as saved, with the fingerprint of the summary they were shown.
  draft: OrderDraft;
  itemsLabel: string;
  totalPkr: number;
  summarySentAt: string;
  reminderSentAt: string | null;
  cartAlertedAt: string | null;
  // The customer's latest message in this chat (server time); null when none is known.
  lastInboundAt: string | null;
};

export type PlacedCandidate = {
  orderId: string;
  orderNumber: number;
  customer: string;
  itemsLabel: string;
  totalPkr: number;
  placedAt: string;
};

export type FollowUpPlan = {
  reminders: CartCandidate[];
  cartAlerts: CartCandidate[];
  confirmReminders: PlacedCandidate[];
};

const HOUR_MS = 60 * 60 * 1_000;
// A summary older than this is a cart from yesterday: no reminder, no alert.
export const CART_FOLLOW_UP_WINDOW_MS = 22 * HOUR_MS;
// Customers are only written to within a day of their own last message.
const CUSTOMER_SILENCE_LIMIT_MS = 23 * HOUR_MS;
// The owner hears about a quiet cart this long after the summary (and after the reminder had its chance).
const MIN_CART_ALERT_AFTER_MS = 2 * HOUR_MS;
// ...but not while the customer is still chatting.
const CART_QUIET_FOR_MS = HOUR_MS;
export const CONFIRM_REMINDER_AFTER_MS = 2 * HOUR_MS;
export const CONFIRM_REMINDER_WINDOW_MS = 3 * 24 * HOUR_MS;
// Never more than a few customer messages at once: bursts of identical texts look like spam to WhatsApp.
export const MAX_REMINDERS_PER_ROUND = 3;
const MAX_DIGEST_ITEMS = 5;
// Even when the shop is open late, customers aren't written to at night.
const CUSTOMER_EARLIEST_HOUR = 9;
const CUSTOMER_LATEST_HOUR = 22;

const age = (iso: string, now: Date) => now.getTime() - new Date(iso).getTime();

export function cartAlertAfterMs(shop: ShopSettings): number {
  return Math.max(MIN_CART_ALERT_AFTER_MS, shop.cartReminderMinutes === null ? 0 : shop.cartReminderMinutes * 60_000 + HOUR_MS);
}

function customerHours(shop: ShopSettings, now: Date): boolean {
  const { hour } = karachiTime(now);
  return shopStatus(shop, now).open && hour >= CUSTOMER_EARLIEST_HOUR && hour < CUSTOMER_LATEST_HOUR;
}

// The summary they saw still holds: same items, prices and delivery charge, and everything still in stock.
// Otherwise a "confirm" would only get them a corrected summary, so the reminder would mislead.
export function summaryStillValid(draft: OrderDraft, products: ReadonlyMap<string, CatalogItem>, pricing: DeliveryPricing): boolean {
  if (!draft.summaryFingerprint || !draft.lines.length) return false;
  const inStock = draft.lines.every((line) => {
    const variant = products.get(line.productId)?.variants.find((candidate) => normalizeSize(candidate.normalizedSize) === normalizeSize(line.normalizedSize));
    return variant !== undefined && variant.stockQty >= line.quantity;
  });
  return inStock && orderFingerprint(draft, products, pricing) === draft.summaryFingerprint;
}

export function planFollowUps(input: {
  now: Date;
  shop: ShopSettings;
  carts: readonly CartCandidate[];
  placed: readonly PlacedCandidate[];
  products: ReadonlyMap<string, CatalogItem>;
}): FollowUpPlan {
  const { now, shop, products } = input;
  const plan: FollowUpPlan = { reminders: [], cartAlerts: [], confirmReminders: [] };
  const pricing: DeliveryPricing = { deliveryFeePkr: shop.deliveryFeePkr, freeDeliveryFromPkr: shop.freeDeliveryFromPkr };
  const ownerHours = shopStatus(shop, now).open;

  if (shop.ordersEnabled && shop.cartReminderMinutes !== null && customerHours(shop, now)) {
    const delay = shop.cartReminderMinutes * 60_000;
    plan.reminders = input.carts
      .filter((cart) => {
        if (cart.reminderSentAt || cart.conversationState !== "bot_active" || !cart.lastInboundAt) return false;
        const summaryAge = age(cart.summarySentAt, now);
        if (summaryAge < delay || summaryAge > CART_FOLLOW_UP_WINDOW_MS) return false;
        // They wrote after seeing the summary: the bot is already talking with them about it.
        if (new Date(cart.lastInboundAt).getTime() > new Date(cart.summarySentAt).getTime()) return false;
        if (age(cart.lastInboundAt, now) > CUSTOMER_SILENCE_LIMIT_MS) return false;
        return summaryStillValid(cart.draft, products, pricing);
      })
      .slice(0, MAX_REMINDERS_PER_ROUND);
  }

  if (shop.ownerFollowUps && ownerHours) {
    const alertAfter = cartAlertAfterMs(shop);
    const remindingNow = new Set(plan.reminders.map((cart) => cart.orderId));
    plan.cartAlerts = input.carts
      .filter((cart) => {
        // The owner is in that chat already.
        if (cart.cartAlertedAt || cart.conversationState === "human_active") return false;
        // A reminder going out now (e.g. held back overnight) or just now gets its hour before the owner steps in.
        if (remindingNow.has(cart.orderId) || (cart.reminderSentAt && age(cart.reminderSentAt, now) < CART_QUIET_FOR_MS)) return false;
        const summaryAge = age(cart.summarySentAt, now);
        if (summaryAge < alertAfter || summaryAge > CART_FOLLOW_UP_WINDOW_MS) return false;
        return !cart.lastInboundAt || age(cart.lastInboundAt, now) >= CART_QUIET_FOR_MS;
      })
      .slice(0, MAX_DIGEST_ITEMS);
    plan.confirmReminders = input.placed
      .filter((order) => {
        const placedAge = age(order.placedAt, now);
        return placedAge >= CONFIRM_REMINDER_AFTER_MS && placedAge <= CONFIRM_REMINDER_WINDOW_MS;
      })
      .slice(0, MAX_DIGEST_ITEMS);
  }
  return plan;
}

// "Ali Raza" → "Ali"; anything that doesn't look like a name is left out rather than read back oddly.
function firstName(name: string | null): string | null {
  const first = name?.trim().split(/\s+/)[0] ?? "";
  return /^\p{L}[\p{L}'.-]{1,19}$/u.test(first) ? first : null;
}

// Two wordings per language so repeat customers don't get the same canned line every time.
const REMINDERS: Record<Language, ((name: string | null) => string)[]> = {
  roman_ur: [
    (name) => `${name ? `${name} ji, ` : ""}aap ka order abhi confirm nahi hua 🙂 Upar wali summary theek hai to *confirm* likh dein, order place ho jayega. Kuch change karna ho to bata dein.`,
    (name) => `${name ? `${name} ji, ` : ""}bas yaad dilana tha: aap ka order abhi place nahi hua. Summary theek lage to *confirm* likh dein, ya bata dein kya badalna hai.`,
  ],
  en: [
    (name) => `${name ? `Hi ${name}! ` : "Hi! "}Just checking in: your order isn't placed yet. If the summary above looks right, reply *confirm* and it's done. Want to change anything? Just tell me.`,
    (name) => `${name ? `Hi ${name}, ` : "Hi, "}a quick reminder that your order is still waiting. Reply *confirm* to place it, or let me know what to change.`,
  ],
  ur: [
    (name) => `${name ? `${name} جی، ` : ""}آپ کا آرڈر ابھی کنفرم نہیں ہوا۔ اوپر والی تفصیل ٹھیک ہے تو *confirm* لکھ دیں، آرڈر ہو جائے گا۔ کچھ بدلنا ہو تو بتا دیں۔`,
    (name) => `${name ? `${name} جی، ` : ""}یاد دہانی: آپ کا آرڈر ابھی نہیں ہوا۔ تفصیل ٹھیک ہو تو *confirm* لکھ دیں، یا بتا دیں کیا بدلنا ہے۔`,
  ],
};

export function renderCartReminder(cart: Pick<CartCandidate, "orderId" | "language" | "customerName">): string {
  const variants = REMINDERS[cart.language];
  // Stable per order: a retried round can't flip the wording.
  const pick = [...cart.orderId].reduce((sum, character) => sum + character.charCodeAt(0), 0) % variants.length;
  return variants[pick]!(firstName(cart.customerName));
}

function ago(iso: string, now: Date): string {
  const minutes = Math.max(1, Math.round(age(iso, now) / 60_000));
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

// A WhatsApp text the gateway accepts (packages/contracts: 4000 characters); longer ones are cut with "…".
export const MAX_TEXT_CHARS = 4_000;
export function fitText(text: string): string {
  return text.length <= MAX_TEXT_CHARS ? text : `${text.slice(0, MAX_TEXT_CHARS - 1)}…`;
}

const shorten = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

// One WhatsApp message to the owner covering everything due this round.
export function renderOwnerDigest(input: { carts: readonly CartCandidate[]; placed: readonly PlacedCandidate[]; now: Date; adminBaseUrl?: string }): string | null {
  const { carts, placed, now } = input;
  if (!carts.length && !placed.length) return null;
  const admin = input.adminBaseUrl?.replace(/\/$/, "");
  const sections: string[] = [];
  if (carts.length) {
    const rows = carts.map((cart, index) => {
      const contact = cart.whatsappPhone ? ` — +${cart.whatsappPhone} (https://wa.me/${cart.whatsappPhone})` : "";
      const reminded = cart.reminderSentAt ? ", reminded" : "";
      return `${index + 1}. ${shorten(cart.customerName ?? "Customer", 60)} — ${shorten(cart.itemsLabel, 120)} — ${formatPrice(cart.totalPkr)} — summary ${ago(cart.summarySentAt, now)}${reminded}${contact}`;
    });
    sections.push(
      [
        `🛒 ${carts.length === 1 ? "A cart is" : `${carts.length} carts are`} waiting for a confirm`,
        ...rows,
        "They saw the priced summary but didn't confirm. A quick call or message often closes it.",
        admin ? `Open carts: ${admin}/admin/orders?tab=carts` : "See Orders → Open carts in the admin.",
      ].join("\n"),
    );
  }
  if (placed.length) {
    const rows = placed.map((order, index) => {
      const link = admin ? ` — ${admin}/admin/orders/${order.orderId}` : "";
      return `${index + 1}. #${order.orderNumber} ${shorten(order.customer, 60)} — ${shorten(order.itemsLabel, 120)} — ${formatPrice(order.totalPkr)} — placed ${ago(order.placedAt, now)}${link}`;
    });
    sections.push([`⏳ ${placed.length === 1 ? "An order is" : `${placed.length} orders are`} waiting for your confirmation`, ...rows].join("\n"));
  }
  return fitText(sections.join("\n\n"));
}

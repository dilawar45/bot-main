import { createHash } from "node:crypto";
import type { Language } from "@huzaifa/contracts";
import { normalizeSize } from "../catalog/admin/validation";
import { inStockSizes, type CatalogItem } from "../catalog/search";
import { formatPrice, type ProductRefs } from "../agent/compose";

// Orders the bot takes in the chat. The model only says what the customer wants (product refs, sizes,
// quantities, details); this module checks it against the catalog, and code renders every price and total.

export type OrderLine = { productId: string; size: string; normalizedSize: string; quantity: number };
export type OrderDetails = { name: string | null; phone: string | null; address: string | null; city: string | null; note: string | null };
export type OrderDraft = {
  id: string | null;
  number: number | null;
  lines: OrderLine[];
  details: OrderDetails;
  // Fingerprint of the summary the customer was last shown (see orderFingerprint).
  summaryFingerprint: string | null;
};
export type OrderStatus = "draft" | "placed" | "confirmed" | "shipped" | "delivered" | "cancelled";
export type RecentOrder = { id: string; number: number; status: Exclude<OrderStatus, "draft">; placedAt: string | null };
// `available` is false until the orders migration is applied; the bot then hands buyers to the team.
export type OrderState = { available: boolean; draft: OrderDraft | null; recent: RecentOrder | null };

export const NO_ORDERS: OrderState = { available: false, draft: null, recent: null };
export const EMPTY_DETAILS: OrderDetails = { name: null, phone: null, address: null, city: null, note: null };

// What the model asked for this turn (already shape-checked by the agent).
export type OrderUpdate = {
  action: "none" | "update" | "place" | "discard";
  // The whole cart as it should be now; an empty list keeps the current items.
  items: { product: string; size: string; quantity: number }[];
  name: string;
  phone: string;
  address: string;
  city: string;
  note: string;
};

export type DeliveryPricing = { deliveryFeePkr: number | null; freeDeliveryFromPkr: number | null };

export const MAX_ORDER_LINES = 10;
export const MAX_LINE_QUANTITY = 10;

// Digits with country code (923001234567), or null when it isn't a usable mobile number.
export function normalizePhone(raw: string): string | null {
  const compact = raw.replace(/[\s\-().]/g, "");
  const pakistan = compact.match(/^(?:\+|00)?92(3\d{9})$/) ?? compact.match(/^0?(3\d{9})$/);
  if (pakistan) return `92${pakistan[1]}`;
  // Other countries only with an explicit international prefix, so a mistyped local number isn't accepted.
  const international = compact.match(/^(?:\+|00)([1-9]\d{9,14})$/);
  return international ? international[1]! : null;
}

export function formatPhone(digits: string): string {
  return /^923\d{9}$/.test(digits) ? `0${digits.slice(2, 5)} ${digits.slice(5)}` : `+${digits}`;
}

function cleanText(value: string, max: number): string | null {
  const text = value.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : null;
}

export function deliveryFeeFor(itemsTotalPkr: number, pricing: DeliveryPricing): number | null {
  if (pricing.freeDeliveryFromPkr !== null && itemsTotalPkr >= pricing.freeDeliveryFromPkr) return 0;
  return pricing.deliveryFeePkr;
}

export function itemsTotal(lines: readonly OrderLine[], products: ReadonlyMap<string, CatalogItem>): number {
  return lines.reduce((sum, line) => sum + (products.get(line.productId)?.pricePkr ?? 0) * line.quantity, 0);
}

export function missingForOrder(draft: OrderDraft | null): ("items" | "name" | "phone" | "address" | "city")[] {
  const missing: ("items" | "name" | "phone" | "address" | "city")[] = [];
  if (!draft?.lines.length) missing.push("items");
  if (!draft?.details.name) missing.push("name");
  if (!draft?.details.phone) missing.push("phone");
  if (!draft?.details.address) missing.push("address");
  if (!draft?.details.city) missing.push("city");
  return missing;
}

// Identifies exactly what a summary showed: items, current prices, details and delivery charge. Placing
// an order requires the customer to have seen the summary with this fingerprint.
export function orderFingerprint(draft: OrderDraft, products: ReadonlyMap<string, CatalogItem>, pricing: DeliveryPricing): string {
  const lines = [...draft.lines]
    .map((line) => [line.productId, line.normalizedSize, line.quantity, products.get(line.productId)?.pricePkr ?? -1] as const)
    .sort((a, b) => `${a[0]}|${a[1]}`.localeCompare(`${b[0]}|${b[1]}`));
  const { name, phone, address, city, note } = draft.details;
  const payload = JSON.stringify([lines, name, phone, address, city, note, deliveryFeeFor(itemsTotal(draft.lines, products), pricing)]);
  return createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

export function summaryIsCurrent(draft: OrderDraft | null, products: ReadonlyMap<string, CatalogItem>, pricing: DeliveryPricing): boolean {
  return Boolean(draft?.summaryFingerprint && draft.summaryFingerprint === orderFingerprint(draft, products, pricing));
}

export type OrderCheck = {
  // The draft to save; null discards it.
  next: OrderDraft | null;
  // Reasons to send the model back for a rewrite (empty when the update is usable).
  problems: string[];
  changed: boolean;
  // The customer confirmed the summary they saw: place the order.
  place: boolean;
};

export function applyOrderUpdate(input: {
  current: OrderDraft | null;
  update: OrderUpdate;
  refs: ProductRefs;
  products: ReadonlyMap<string, CatalogItem>;
  pricing: DeliveryPricing;
}): OrderCheck {
  const { current, update, refs, products, pricing } = input;
  if (update.action === "none") return { next: current, problems: [], changed: false, place: false };
  if (update.action === "discard") return { next: null, problems: [], changed: current !== null, place: false };

  const problems: string[] = [];
  let lines = current?.lines ?? [];
  if (update.items.length) {
    const merged = new Map<string, OrderLine>();
    if (update.items.length > MAX_ORDER_LINES) problems.push(`at most ${MAX_ORDER_LINES} different items per order; bigger orders go to the team (handoff)`);
    for (const item of update.items.slice(0, MAX_ORDER_LINES)) {
      const product = refs.byRef.get(item.product.trim().toUpperCase());
      const fresh = product ? products.get(product.id) : undefined;
      if (!fresh) {
        problems.push(`order item "${item.product}" is not a product ref from PRODUCT DATA`);
        continue;
      }
      const wanted = item.size.trim() ? normalizeSize(item.size) : "";
      const variant = wanted
        ? fresh.variants.find((candidate) => normalizeSize(candidate.normalizedSize) === wanted)
        : fresh.variants.length === 1
          ? fresh.variants[0]
          : undefined;
      if (!variant) {
        const sizes = inStockSizes(fresh);
        problems.push(
          wanted
            ? `{{product:${refs.refOf.get(fresh.id)}}} doesn't come in size ${item.size}; in stock: ${sizes.join(", ") || "none"}`
            : `ask which size they want for {{product:${refs.refOf.get(fresh.id)}}} before adding it (in stock: ${sizes.join(", ") || "none"})`,
        );
        continue;
      }
      const quantity = Number.isFinite(item.quantity) ? Math.trunc(item.quantity) : 1;
      // 0 (or less) means "take it out": order.items is the whole cart, so it's simply left out.
      if (quantity < 1) continue;
      const key = `${fresh.id}|${normalizeSize(variant.normalizedSize)}`;
      merged.set(key, {
        productId: fresh.id,
        size: variant.size,
        normalizedSize: variant.normalizedSize,
        quantity: (merged.get(key)?.quantity ?? 0) + quantity,
      });
    }
    lines = [...merged.values()];
    // Checked after merging, so "5 + 5 + 5 of the same" can't slip past the limit.
    if (lines.some((line) => line.quantity > MAX_LINE_QUANTITY)) problems.push(`quantity must be 1–${MAX_LINE_QUANTITY} per item; for more, hand the order to the team`);
  }

  // Every line must still be buyable now (stock can change between turns).
  for (const line of lines) {
    const product = products.get(line.productId);
    const variant = product?.variants.find((candidate) => normalizeSize(candidate.normalizedSize) === normalizeSize(line.normalizedSize));
    const ref = product ? refs.refOf.get(product.id) : undefined;
    const label = ref ? `{{product:${ref}}} size ${line.size}` : `an item in the order (size ${line.size})`;
    if (!product || !variant || variant.stockQty <= 0) problems.push(`${label} is sold out now; tell them and offer another size or item (remove it from order.items)`);
    else if (variant.stockQty < line.quantity) problems.push(`${label}: not that many in stock; ask for fewer (never say how many are left)`);
  }

  const details: OrderDetails = { ...(current?.details ?? EMPTY_DETAILS) };
  const name = cleanText(update.name, 120);
  if (name && /\p{L}/u.test(name)) details.name = name;
  if (update.phone.trim()) {
    const phone = normalizePhone(update.phone);
    if (phone) details.phone = phone;
    // No example digits here: the model would copy them into its reply.
    else problems.push(`"${update.phone.slice(0, 24)}" isn't a valid mobile number; ask them to send their full 11-digit mobile number again`);
  }
  const address = cleanText(update.address, 400);
  if (address) {
    if (address.length >= 8) details.address = address;
    else problems.push("the address is too short to deliver to; ask for the full address (house, street, area)");
  }
  const city = cleanText(update.city, 80);
  if (city && city.length >= 2) details.city = city;
  const note = cleanText(update.note, 400);
  if (note) details.note = note;

  const next: OrderDraft = {
    id: current?.id ?? null,
    number: current?.number ?? null,
    lines,
    details,
    summaryFingerprint: current?.summaryFingerprint ?? null,
  };
  // Nothing to keep yet (e.g. the only item asked for was sold out): no empty order is started.
  if (!current && !lines.length && !Object.values(details).some(Boolean)) return { next: null, problems, changed: false, place: false };
  const changed = !current || orderFingerprint(next, products, pricing) !== orderFingerprint(current, products, pricing);

  if (update.action === "place" && problems.length === 0) {
    const missing = missingForOrder(next);
    if (missing.length) {
      problems.push(`the order can't be placed yet: still missing ${missing.join(", ")}. Ask for it and keep order.action = "update"`);
    } else if (changed || !summaryIsCurrent(current, products, pricing)) {
      problems.push(
        'the order can\'t be placed yet: the customer hasn\'t confirmed the latest summary. Set order.action = "update"; the system sends the summary with prices now — ask them to confirm it.',
      );
    }
  }
  return { next, problems, changed, place: update.action === "place" && problems.length === 0 };
}

// Claims that an order went through: "order" near a done-word in either order ("Your order has been
// successfully placed", "order lag gaya hai", "Done! Aapka order confirm hai", "I've placed your order",
// "آپ کا آرڈر لگ گیا ہے"). Future and conditional sentences ("will be placed once you confirm") are not claims.
const DONE_WORD = String.raw`(?:placed|booked|confirmed|received|completed?|done|ho\s*gay[ai]|hogay[ai]|ho\s*gya|ho\s*chuk[ai]|lag\s*gay[ai]|lag\s*gya|lg\s*gya|kar\s*d(?:iy|i)a|kr\s*d(?:iy|i)a|kard(?:iy|i)a|note\s+kar\s+liya|confirm\s+(?:hai|ha|he))`;
const PLACED_CLAIM = new RegExp(
  String.raw`\border\b(?:\W+[\p{L}\p{N}]+){0,4}?\W+${DONE_WORD}(?![\p{L}])` +
    String.raw`|\b(?:placed|booked|confirmed|received)\s+(?:your|the|aap\s*ka|apka)\s+order\b` +
    String.raw`|\b(?:done|confirmed|booked)\b[^.!?]{0,20}\border\b` +
    String.raw`|آرڈر(?:\s+\S+){0,3}?\s*(?:لگ\s*گیا|ہو\s*گیا|ہو\s*چکا|بک\s*ہو|کنفرم\s*ہو|کنفرم\s*ہے|مل\s*گیا)`,
  "iu",
);
const FUTURE_OR_CONDITION = /\b(?:will|would|once|after|when|if|jab|agar|phir|jaise\s+hi)\b|\bjaye?\s*g[ai]\b|\bho\s+jaye?\s*g[ai]\b|\bkarein\s+g[ae]\b|\?\s*$|جائے\s*گا|جب|اگر/iu;

export function claimsOrderPlaced(messages: readonly string[]): boolean {
  return messages.some((message) =>
    message
      .split(/(?<=[.!?۔\n])\s*/)
      .some((sentence) => PLACED_CLAIM.test(sentence) && !FUTURE_OR_CONDITION.test(sentence)),
  );
}

// A clear yes to the summary ("confirm", "ji theek hai", "haan kar do", "ok"). Questions are never a yes.
const AFFIRMATIVE = /\b(?:confirm(?:ed)?|yes|yeah|yep|yup|haan|han|haa|ji|jee|g|theek|thik|tk|ok|okay|okk|done|place|kar\s*do|kardo|kar\s*dein|kardein|bilkul|sure|zaroor|chalo|perfect)\b|ٹھیک|جی|ہاں|کنفرم|بالکل/iu;

export function isAffirmative(text: string): boolean {
  const trimmed = text.trim();
  return Boolean(trimmed) && !/[?؟]\s*$/.test(trimmed) && AFFIRMATIVE.test(trimmed);
}

type Labels = {
  // Never "Order #1042": before the customer confirms it isn't an order yet, and must not read like one.
  title: string;
  confirmLine: string;
  items: string;
  delivery: string;
  free: string;
  teamConfirms: string;
  total: string;
  name: string;
  phone: string;
  address: string;
  note: string;
};

const LABELS: Record<Language, Labels> = {
  en: {
    title: "🧾 *Your order — not placed yet*",
    confirmLine: "Reply *confirm* to place it, or tell me what to change.",
    items: "Items",
    delivery: "Delivery",
    free: "free",
    teamConfirms: "our team will confirm the charge",
    total: "Total",
    name: "Name",
    phone: "Phone",
    address: "Address",
    note: "Note",
  },
  roman_ur: {
    title: "🧾 *Aap ka order — abhi place nahi hua*",
    confirmLine: "Place karne ke liye *confirm* likh dein, ya bata dein kya change karna hai.",
    items: "Items",
    delivery: "Delivery",
    free: "free",
    teamConfirms: "charges team confirm karegi",
    total: "Total",
    name: "Naam",
    phone: "Phone",
    address: "Address",
    note: "Note",
  },
  ur: {
    title: "🧾 *آپ کا آرڈر — ابھی نہیں ہوا*",
    confirmLine: "آرڈر کرنے کے لیے *confirm* لکھ دیں، یا بتا دیں کیا بدلنا ہے۔",
    items: "اشیاء",
    delivery: "ڈیلیوری",
    free: "مفت",
    teamConfirms: "چارجز ٹیم بتائے گی",
    total: "کل",
    name: "نام",
    phone: "فون",
    address: "پتہ",
    note: "نوٹ",
  },
};

function fullAddress(details: OrderDetails): string | null {
  if (!details.address) return details.city;
  if (!details.city || details.address.toLowerCase().includes(details.city.toLowerCase())) return details.address;
  return `${details.address}, ${details.city}`;
}

// The priced summary the customer confirms. Rendered by code: names, prices and totals come from the catalog.
export function renderOrderSummary(draft: OrderDraft, products: ReadonlyMap<string, CatalogItem>, language: Language, pricing: DeliveryPricing): string {
  const labels = LABELS[language];
  const lines = draft.lines.map((line, index) => {
    const product = products.get(line.productId);
    const price = (product?.pricePkr ?? 0) * line.quantity;
    return `${index + 1}. ${product?.name ?? "Item"} — ${line.size} × ${line.quantity} — ${formatPrice(price)}`;
  });
  const subtotal = itemsTotal(draft.lines, products);
  const fee = deliveryFeeFor(subtotal, pricing);
  const rows = [
    labels.title,
    ...lines,
    `${labels.items}: ${formatPrice(subtotal)}`,
    `${labels.delivery}: ${fee === null ? labels.teamConfirms : fee === 0 ? labels.free : formatPrice(fee)}`,
  ];
  if (fee !== null) rows.push(`*${labels.total}: ${formatPrice(subtotal + fee)}*`);
  const address = fullAddress(draft.details);
  if (draft.details.name) rows.push(`${labels.name}: ${draft.details.name}`);
  if (draft.details.phone) rows.push(`${labels.phone}: ${formatPhone(draft.details.phone)}`);
  if (address) rows.push(`${labels.address}: ${address}`);
  if (draft.details.note) rows.push(`${labels.note}: ${draft.details.note}`);
  rows.push("", labels.confirmLine);
  return rows.join("\n");
}

export function renderOrderPlaced(number: number, language: Language, shopOpen: boolean): string {
  const text: Record<Language, string> = {
    en: `✅ Order #${number} received! Our team will confirm it and share the dispatch details here.${shopOpen ? "" : " (We're closed right now, so it'll be confirmed after we open.)"}`,
    roman_ur: `✅ Order #${number} mil gaya! Team confirm karke dispatch ki details yahin bhej degi.${shopOpen ? "" : " (Shop abhi band hai, khulne ke baad confirm hoga.)"}`,
    ur: `✅ آرڈر #${number} مل گیا! ٹیم تصدیق کر کے ڈسپیچ کی تفصیل یہیں بھیج دے گی۔${shopOpen ? "" : " (دکان ابھی بند ہے، کھلنے کے بعد تصدیق ہو گی۔)"}`,
  };
  return text[language];
}

export function renderOrderFailed(reason: "out_of_stock" | "outdated" | "error", language: Language): string {
  const text: Record<typeof reason, Record<Language, string>> = {
    out_of_stock: {
      en: "Sorry, an item in your order just went out of stock, so I couldn't place it. Want me to suggest something similar?",
      roman_ur: "Maazrat, order ki ek item abhi stock se khatam ho gayi, is liye order place nahi ho saka. Kuch milta julta dikhaun?",
      ur: "معذرت، آرڈر کی ایک چیز ابھی اسٹاک میں ختم ہو گئی، اس لیے آرڈر نہیں ہو سکا۔ کچھ ملتا جلتا دکھاؤں؟",
    },
    outdated: {
      en: "Something in the order changed, so here's the updated summary — please confirm it again.",
      roman_ur: "Order mein kuch change hua hai, ye updated summary dekh kar dobara confirm kar dein.",
      ur: "آرڈر میں کچھ تبدیلی ہوئی ہے، یہ نئی تفصیل دیکھ کر دوبارہ تصدیق کر دیں۔",
    },
    error: {
      en: "Sorry, I couldn't place the order just now. Our team has been told and will confirm it with you here.",
      roman_ur: "Maazrat, abhi order place nahi ho saka. Team ko bata diya hai, wo yahin aap se confirm kar lenge.",
      ur: "معذرت، ابھی آرڈر نہیں ہو سکا۔ ٹیم کو بتا دیا ہے، وہ یہیں آپ سے تصدیق کر لیں گے۔",
    },
  };
  return text[reason][language];
}

// For the owner's support chat when a customer places an order.
export function renderOrderAlert(input: {
  number: number;
  draft: OrderDraft;
  products: ReadonlyMap<string, CatalogItem>;
  pricing: DeliveryPricing;
  chatId: string;
  whatsappPhone?: string | null;
  adminUrl?: string | null;
}): string {
  const { draft, products } = input;
  const subtotal = itemsTotal(draft.lines, products);
  const fee = deliveryFeeFor(subtotal, input.pricing);
  const digits = input.whatsappPhone ?? (input.chatId.endsWith("@c.us") ? input.chatId.slice(0, -5) : null);
  const rows = [
    `🛒 New order #${input.number} — please confirm it`,
    `Customer: ${draft.details.name ?? "unknown"}${digits ? ` — WhatsApp +${digits} (https://wa.me/${digits})` : ""}`,
    `Phone: ${draft.details.phone ? formatPhone(draft.details.phone) : "—"}`,
    `Address: ${fullAddress(draft.details) ?? "—"}`,
    ...draft.lines.map((line, index) => {
      const product = products.get(line.productId);
      return `${index + 1}. ${product?.name ?? "Item"}${product ? ` (${product.sku})` : ""} — ${line.size} × ${line.quantity} — ${formatPrice((product?.pricePkr ?? 0) * line.quantity)}`;
    }),
    `Items ${formatPrice(subtotal)} · Delivery ${fee === null ? "to confirm" : fee === 0 ? "free" : formatPrice(fee)}${fee === null ? "" : ` · Total ${formatPrice(subtotal + fee)}`}`,
  ];
  if (draft.details.note) rows.push(`Note: ${draft.details.note}`);
  rows.push(input.adminUrl ? `Confirm or cancel: ${input.adminUrl}` : "Confirm or cancel it in the admin under Orders.");
  return rows.join("\n");
}

const STATUS_TEXT: Record<RecentOrder["status"], string> = {
  placed: "placed, waiting for the shop to confirm",
  confirmed: "confirmed by the shop, being prepared",
  shipped: "shipped",
  delivered: "delivered",
  cancelled: "cancelled",
};

// ORDER section of the turn context.
export function orderContext(input: {
  state: OrderState;
  refs: ProductRefs;
  products: ReadonlyMap<string, CatalogItem>;
  pricing: DeliveryPricing;
  whatsappPhone?: string | null;
  now?: Date;
}): string {
  const { state, refs, products, pricing } = input;
  const rows: string[] = [];
  const draft = state.draft;
  if (draft && (draft.lines.length || Object.values(draft.details).some(Boolean))) {
    rows.push(`Open order (not placed yet)${draft.number ? ` #${draft.number}` : ""}:`);
    for (const line of draft.lines) {
      const product = products.get(line.productId);
      const ref = product ? refs.refOf.get(product.id) : undefined;
      rows.push(`- ${ref ? `[${ref}] ` : ""}${product?.name ?? "an item no longer in the catalog"} — size ${line.size} × ${line.quantity}`);
    }
    if (!draft.lines.length) rows.push("- no items yet");
    const { name, phone, address, city, note } = draft.details;
    rows.push(`Details: name ${name ?? "—"} | phone ${phone ? formatPhone(phone) : "—"} | address ${address ?? "—"} | city ${city ?? "—"}${note ? ` | note ${note}` : ""}`);
    const missing = missingForOrder(draft);
    rows.push(missing.length ? `Still needed: ${missing.join(", ")}` : "Complete.");
    rows.push(
      !missing.length && summaryIsCurrent(draft, products, pricing)
        ? 'The customer was shown this exact summary. If they now confirm it, set order.action = "place".'
        : "No confirmed summary yet: the system sends one automatically as soon as everything is filled in.",
    );
  } else {
    rows.push("No open order.");
  }
  if (input.whatsappPhone) rows.push(`Their WhatsApp number: ${formatPhone(input.whatsappPhone)} (you may ask if it's fine for delivery calls)`);
  if (state.recent) {
    const placed = state.recent.placedAt ? ` on ${state.recent.placedAt.slice(0, 10)}` : "";
    rows.push(`Their last order: #${state.recent.number}${placed} — ${STATUS_TEXT[state.recent.status]}.`);
  }
  return rows.join("\n");
}

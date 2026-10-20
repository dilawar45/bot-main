import { describe, expect, it } from "vitest";
import type { CatalogItem } from "../catalog/search";
import { createProductRefs, refFor } from "../agent/compose";
import {
  applyOrderUpdate,
  claimsOrderPlaced,
  EMPTY_DETAILS,
  isAffirmative,
  normalizePhone,
  orderContext,
  orderFingerprint,
  renderOrderAlert,
  renderOrderSummary,
  summaryIsCurrent,
  type OrderDraft,
  type OrderUpdate,
} from "./cart";

const product = (id: string, name: string, pricePkr: number, variants: CatalogItem["variants"]): CatalogItem => ({
  id,
  sku: `SKU-${name.split(" ")[0]}`,
  name,
  description: "",
  category: "kurta",
  color: "red",
  material: null,
  styleTags: [],
  aliases: [],
  pricePkr,
  createdAt: "2026-09-01T00:00:00Z",
  variants,
  imagePaths: [],
  aiText: "",
});

const ruby = product("11111111-1111-4111-8111-111111111111", "Ruby Kurta", 3200, [
  { size: "S", normalizedSize: "S", stockQty: 2 },
  { size: "M", normalizedSize: "M", stockQty: 0 },
  { size: "L", normalizedSize: "L", stockQty: 3 },
]);
const shawl = product("22222222-2222-4222-8222-222222222222", "Pashmina Shawl", 4500, [{ size: "Free", normalizedSize: "FREE", stockQty: 4 }]);
const products = new Map([ruby, shawl].map((item) => [item.id, item]));
const pricing = { deliveryFeePkr: 200, freeDeliveryFromPkr: 10_000 };

function setup() {
  const refs = createProductRefs();
  refFor(refs, ruby); // P1
  refFor(refs, shawl); // P2
  return refs;
}

const update = (overrides: Partial<OrderUpdate>): OrderUpdate => ({ action: "update", items: [], name: "", phone: "", address: "", city: "", note: "", ...overrides });
const complete: OrderDraft = {
  id: "o1",
  number: 1024,
  lines: [{ productId: ruby.id, size: "L", normalizedSize: "L", quantity: 1 }],
  details: { ...EMPTY_DETAILS, name: "Ali Khan", phone: "923001234567", address: "House 5, Street 2, Gulberg", city: "Lahore" },
  summaryFingerprint: null,
};

describe("normalizePhone", () => {
  it("accepts Pakistani mobiles in every usual shape and international numbers with a prefix", () => {
    for (const raw of ["0300 1234567", "03001234567", "+92 300 1234567", "0092-300-1234567", "923001234567", "3001234567", "(0300) 123-4567"]) {
      expect(normalizePhone(raw), raw).toBe("923001234567");
    }
    expect(normalizePhone("+971 50 123 4567")).toBe("971501234567");
    for (const raw of ["042 1234567", "12345", "0300 12345", "call me", "971501234567"]) expect(normalizePhone(raw), raw).toBeNull();
  });
});

describe("applyOrderUpdate", () => {
  it("adds items by ref with normalised sizes, merges repeats and keeps prices out of the model's hands", () => {
    const check = applyOrderUpdate({
      current: null,
      update: update({ items: [{ product: "p1", size: "large", quantity: 1 }, { product: "P1", size: "L", quantity: 1 }, { product: "P2", size: "", quantity: 1 }] }),
      refs: setup(),
      products,
      pricing,
    });
    expect(check.problems).toEqual([]);
    expect(check.next?.lines).toEqual([
      { productId: ruby.id, size: "L", normalizedSize: "L", quantity: 2 },
      // One-size products don't need a size.
      { productId: shawl.id, size: "Free", normalizedSize: "FREE", quantity: 1 },
    ]);
    expect(check.changed).toBe(true);
    expect(check.place).toBe(false);
  });

  it("refuses sold-out sizes, unknown refs, missing sizes and silly quantities", () => {
    const refs = setup();
    const problemsFor = (items: OrderUpdate["items"]) => applyOrderUpdate({ current: null, update: update({ items }), refs, products, pricing }).problems.join(" | ");
    expect(problemsFor([{ product: "P1", size: "M", quantity: 1 }])).toMatch(/sold out/);
    expect(problemsFor([{ product: "P1", size: "L", quantity: 4 }])).toMatch(/not that many in stock; ask for fewer \(never say how many/);
    expect(problemsFor([{ product: "P9", size: "L", quantity: 1 }])).toMatch(/not a product ref/);
    expect(problemsFor([{ product: "P1", size: "", quantity: 1 }])).toMatch(/ask which size .*in stock: S, L/);
    expect(problemsFor([{ product: "P1", size: "XXL", quantity: 1 }])).toMatch(/doesn't come in size XXL/);
    expect(problemsFor([{ product: "P1", size: "L", quantity: 50 }])).toMatch(/quantity must be 1–10/);
  });

  it("merges details, keeps what it already had and rejects unusable phone numbers and addresses", () => {
    const refs = setup();
    const first = applyOrderUpdate({ current: null, update: update({ name: "  Ali   Khan ", phone: "0300-1234567", city: "Lahore" }), refs, products, pricing });
    expect(first.problems).toEqual([]);
    expect(first.next?.details).toMatchObject({ name: "Ali Khan", phone: "923001234567", city: "Lahore", address: null });
    const second = applyOrderUpdate({ current: first.next, update: update({ address: "House 5, Street 2, Gulberg" }), refs, products, pricing });
    expect(second.next?.details).toMatchObject({ name: "Ali Khan", phone: "923001234567", address: "House 5, Street 2, Gulberg" });
    expect(applyOrderUpdate({ current: null, update: update({ phone: "042 111" }), refs, products, pricing }).problems.join()).toMatch(/isn't a valid mobile number/);
    expect(applyOrderUpdate({ current: null, update: update({ address: "Lahore" }), refs, products, pricing }).problems.join()).toMatch(/too short/);
  });

  it("places only a complete order whose exact summary the customer has seen", () => {
    const refs = setup();
    const place = update({ action: "place" });
    // Complete, but no summary shown yet.
    expect(applyOrderUpdate({ current: complete, update: place, refs, products, pricing }).problems.join()).toMatch(/hasn't confirmed the latest summary/);
    const shown = { ...complete, summaryFingerprint: orderFingerprint(complete, products, pricing) };
    expect(summaryIsCurrent(shown, products, pricing)).toBe(true);
    const ok = applyOrderUpdate({ current: shown, update: place, refs, products, pricing });
    expect(ok).toMatchObject({ problems: [], place: true, changed: false });
    // Changing anything in the same turn means they haven't seen it yet.
    const changed = applyOrderUpdate({ current: shown, update: { ...place, items: [{ product: "P1", size: "S", quantity: 1 }] }, refs, products, pricing });
    expect(changed.place).toBe(false);
    expect(changed.problems.join()).toMatch(/hasn't confirmed/);
    // Missing details are named.
    const partial = { ...shown, details: { ...shown.details, address: null } };
    expect(applyOrderUpdate({ current: partial, update: place, refs, products, pricing }).problems.join()).toMatch(/still missing address/);
  });

  it("notices a price change after the summary was shown", () => {
    const shown = { ...complete, summaryFingerprint: orderFingerprint(complete, products, pricing) };
    const repriced = new Map(products).set(ruby.id, { ...ruby, pricePkr: 3500 });
    expect(summaryIsCurrent(shown, repriced, pricing)).toBe(false);
  });

  it("revalidates stock for items already in the cart", () => {
    const soldOut = new Map(products).set(ruby.id, { ...ruby, variants: ruby.variants.map((variant) => ({ ...variant, stockQty: 0 })) });
    const check = applyOrderUpdate({ current: complete, update: update({ city: "Lahore" }), refs: setup(), products: soldOut, pricing });
    expect(check.problems.join()).toMatch(/\{\{product:P1\}\} size L is sold out now/);
  });

  it("doesn't start an empty order when nothing usable was asked for", () => {
    // A sold-out size is refused (the model rewrites without it)...
    expect(applyOrderUpdate({ current: null, update: update({ items: [{ product: "P1", size: "M", quantity: 1 }] }), refs: setup(), products, pricing }).problems.join()).toMatch(/sold out/);
    // ...and the rewrite, with no items and no details, starts no order at all.
    expect(applyOrderUpdate({ current: null, update: update({}), refs: setup(), products, pricing })).toMatchObject({ next: null, changed: false, place: false });
  });

  it("discards and ignores", () => {
    const refs = setup();
    expect(applyOrderUpdate({ current: complete, update: update({ action: "discard" }), refs, products, pricing })).toMatchObject({ next: null, changed: true });
    expect(applyOrderUpdate({ current: complete, update: update({ action: "none" }), refs, products, pricing })).toMatchObject({ next: complete, changed: false });
  });
});

describe("rendering", () => {
  it("prices the summary from the catalog with delivery rules", () => {
    const summary = renderOrderSummary(complete, products, "roman_ur", pricing);
    // Says plainly that it isn't an order yet, and how to place it.
    expect(summary).toBe(
      [
        "🧾 *Aap ka order — abhi place nahi hua*",
        "1. Ruby Kurta — L × 1 — Rs 3,200",
        "Items: Rs 3,200",
        "Delivery: Rs 200",
        "*Total: Rs 3,400*",
        "Naam: Ali Khan",
        "Phone: 0300 1234567",
        "Address: House 5, Street 2, Gulberg, Lahore",
        "",
        "Place karne ke liye *confirm* likh dein, ya bata dein kya change karna hai.",
      ].join("\n"),
    );
    expect(renderOrderSummary(complete, products, "en", pricing)).toMatch(/^🧾 \*Your order — not placed yet\*[\s\S]*Reply \*confirm\* to place it/);
    const big = { ...complete, lines: [{ ...complete.lines[0]!, quantity: 3 }, { productId: shawl.id, size: "Free", normalizedSize: "FREE", quantity: 1 }] };
    expect(renderOrderSummary(big, products, "en", pricing)).toContain("Delivery: free\n*Total: Rs 14,100*");
    expect(renderOrderSummary(complete, products, "en", { deliveryFeePkr: null, freeDeliveryFromPkr: null })).toContain("Delivery: our team will confirm the charge");
    expect(renderOrderSummary(complete, products, "en", { deliveryFeePkr: null, freeDeliveryFromPkr: null })).not.toContain("Total");
  });

  it("gives the owner everything needed to confirm", () => {
    const alert = renderOrderAlert({ number: 1024, draft: complete, products, pricing, chatId: "98100000000068@lid", whatsappPhone: "923001112233", adminUrl: "https://shop.example.com/admin/orders/o1" });
    expect(alert).toContain("🛒 New order #1024");
    expect(alert).toContain("WhatsApp +923001112233 (https://wa.me/923001112233)");
    expect(alert).toContain("1. Ruby Kurta (SKU-Ruby) — L × 1 — Rs 3,200");
    expect(alert).toContain("Items Rs 3,200 · Delivery Rs 200 · Total Rs 3,400");
    expect(alert).toContain("Confirm or cancel: https://shop.example.com/admin/orders/o1");
  });

  it("describes the order state for the model", () => {
    const refs = setup();
    const text = orderContext({ state: { available: true, draft: { ...complete, details: { ...complete.details, address: null } }, recent: null }, refs, products, pricing, whatsappPhone: "923001234567" });
    expect(text).toContain("- [P1] Ruby Kurta — size L × 1");
    expect(text).toContain("Still needed: address");
    expect(text).toContain("Their WhatsApp number: 0300 1234567");
    expect(orderContext({ state: { available: true, draft: null, recent: { id: "x", number: 1003, status: "shipped", placedAt: "2026-09-20T10:00:00Z" } }, refs, products, pricing })).toContain(
      "Their last order: #1003 on 2026-09-20 — shipped.",
    );
  });
});

describe("claimsOrderPlaced", () => {
  it("catches claims in every usual wording", () => {
    for (const text of [
      "Your order has been placed!",
      "Your order has been successfully placed!",
      "Order successfully placed ✅",
      "I've placed your order",
      "Order confirm ho gaya ✅",
      "order book kar diya hai",
      "Aap ka order ho gaya hai",
      "order place ho chuka hai",
      "order lag gaya hai",
      "Done! Aapka order confirm hai",
      "S size order note kar liya hai.",
      "آپ کا آرڈر ہو گیا",
      "آپ کا آرڈر لگ گیا ہے",
    ]) {
      expect(claimsOrderPlaced([text]), text).toBe(true);
    }
  });

  it("leaves questions, requests and future steps alone", () => {
    for (const text of [
      "Order confirm kar dein?",
      "Should I place the order?",
      "Order ke liye naam bata dein",
      "Once you confirm, your order will be placed.",
      "Confirm karte hi order place ho jayega.",
      "Place karne ke liye confirm likh dein.",
      "Ye raha aap ka order summary 👇",
    ]) {
      expect(claimsOrderPlaced([text]), text).toBe(false);
    }
  });
});

describe("isAffirmative", () => {
  it("accepts a clear yes and nothing else", () => {
    for (const text of ["confirm", "ji theek hai confirm kar dein", "haan kar do", "ok", "yes please", "جی ٹھیک ہے", "Done 👍"]) expect(isAffirmative(text), text).toBe(true);
    for (const text of ["delivery kab tak?", "confirm?", "Ali Raza, House 12 Street 4", "", "rehne dein"]) expect(isAffirmative(text), text).toBe(false);
  });
});

describe("quantities", () => {
  it("drops an item set to 0 and checks the limit after merging repeats", () => {
    const refs = setup();
    const removed = applyOrderUpdate({
      current: null,
      update: update({ items: [{ product: "P1", size: "S", quantity: 1 }, { product: "P1", size: "L", quantity: 0 }] }),
      refs,
      products,
      pricing,
    });
    expect(removed.next?.lines).toEqual([{ productId: ruby.id, size: "S", normalizedSize: "S", quantity: 1 }]);
    const many = new Map(products).set(ruby.id, { ...ruby, variants: [{ size: "L", normalizedSize: "L", stockQty: 50 }] });
    const merged = applyOrderUpdate({
      current: null,
      update: update({ items: [{ product: "P1", size: "L", quantity: 10 }, { product: "P1", size: "L", quantity: 10 }] }),
      refs,
      products: many,
      pricing,
    });
    expect(merged.problems.join()).toMatch(/quantity must be 1–10/);
  });
});

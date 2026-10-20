import { describe, expect, it } from "vitest";
import type { CatalogItem } from "../catalog/search";
import { asksToSeeProduct, composeReply, createProductRefs, refFor, type ComposeInput } from "./compose";
import { recentCardProductIds, type StoredMessage } from "./memory";

// Lessons from a real chat: a one-product catalog, the customer said no to it several times, and the bot sent the
// same card every turn; and "L hai, XL nahi" lost the whole answer to the size checker.

const kurta: CatalogItem = {
  id: "22222222-2222-4222-8222-222222222222",
  sku: "KRT-1",
  name: "Emerald Lawn Kurta",
  description: "",
  category: "kurta",
  color: "green",
  material: "lawn",
  styleTags: [],
  aliases: [],
  pricePkr: 4500,
  createdAt: "2026-09-01T00:00:00Z",
  variants: [
    { size: "S", normalizedSize: "S", stockQty: 2 },
    { size: "L", normalizedSize: "L", stockQty: 1 },
  ],
  imagePaths: [],
  aiText: "",
};

function compose(input: Partial<ComposeInput> & Pick<ComposeInput, "draft">, sanitize = false) {
  const refs = createProductRefs();
  refFor(refs, kurta);
  return composeReply({ chatId: "c@c.us", refs, products: new Map([[kurta.id, kurta]]), publicUrl: (path) => `https://x/${path}`, ...input }, { sanitize });
}

const texts = (result: ReturnType<typeof compose>) => result.actions.map((action) => (action.type === "text" ? action.text : `[card ${action.caption}]`));

describe("repeated product cards", () => {
  const recentCards = new Set([kurta.id]);

  it("doesn't send a card the customer saw in the last replies, and drops the arrow pointing at it", () => {
    const result = compose({
      draft: { language: "roman_ur", messages: ["Ye green wala kurta hai agar pasand aaye 👇", "Koi aur colour chahiye?"], showProducts: ["P1"] },
      recentCards,
      customerText: "nai chaiye ye wala",
    });
    expect(texts(result)).toEqual(["Ye green wala kurta hai agar pasand aaye", "Koi aur colour chahiye?"]);
    expect(result.shownProductIds).toEqual([]);
    expect(result.issues).toEqual([]);
  });

  it("sends it again when they ask for the photo or price", () => {
    for (const customerText of ["pic bhejo dobara", "price kya hai?", "ye dikhao", "قیمت؟"]) {
      const result = compose({ draft: { language: "roman_ur", messages: ["Ye dekhein 👇"], showProducts: ["P1"] }, recentCards, customerText });
      expect(result.shownProductIds, customerText).toEqual([kurta.id]);
    }
    expect(asksToSeeProduct("Koi bhi nai")).toBe(false);
  });

  it("keeps the card when it would be the whole reply", () => {
    const result = compose({ draft: { language: "roman_ur", messages: [], showProducts: ["P1"] }, recentCards, customerText: "hmm" });
    expect(result.shownProductIds).toEqual([kurta.id]);
  });

  it("finds photo and text cards in the bot's last two replies only", () => {
    const at = (minute: number) => `2026-10-06T10:${String(minute).padStart(2, "0")}:00.000Z`;
    const message = (minute: number, direction: StoredMessage["direction"], text: string, extra: Partial<StoredMessage> = {}): StoredMessage => ({
      id: `m${minute}`,
      direction,
      source: direction === "inbound" ? "customer" : "agent",
      contentType: "text",
      text,
      mediaPath: null,
      occurredAt: at(minute),
      ...extra,
    });
    const older = "33333333-3333-4333-8333-333333333333";
    const photo = "44444444-4444-4444-8444-444444444444";
    const byName = new Map([
      [kurta.name, kurta.id],
      ["Old Shawl", older],
    ]);
    const history = [
      message(1, "inbound", "shawl?"),
      message(2, "outbound", "*Old Shawl*\nQeemat: Rs 2,000\nSizes: Free"),
      message(3, "inbound", "kurta?"),
      message(4, "outbound", "Ye dekhein 👇"),
      message(5, "outbound", "*Emerald Lawn Kurta*\nQeemat: Rs 4,500\nSizes: S, L", {}),
      message(6, "inbound", "aur?"),
      message(7, "outbound", "*Black Abaya*\nQeemat: Rs 6,000", { contentType: "image", mediaPath: `products/${photo}/a.jpg` }),
      message(8, "inbound", "nai chaiye"),
    ];
    expect(recentCardProductIds(history, byName)).toEqual(new Set([photo, kurta.id]));
    expect(recentCardProductIds(history, byName, 3)).toEqual(new Set([photo, kurta.id, older]));
  });
});

describe("untagged size claims", () => {
  it("tells the rewrite which size to tag", () => {
    const result = compose({ draft: { language: "roman_ur", messages: ["{{size:P1:L}}, lekin XL size mein nahi hai."], showProducts: [] } });
    expect(result.issues.join(" | ")).toContain("size XL without a tag: write {{size:P1:XL}}");
  });

  it("keeps the tagged clause when only the untagged one breaks the rule", () => {
    const result = compose({ draft: { language: "roman_ur", messages: ["{{size:P1:L}}, lekin XL size mein nahi hai.", "Order karna hai?"], showProducts: [] } }, true);
    expect(texts(result)).toEqual(["*Emerald Lawn Kurta* mein L size available hai.", "Order karna hai?"]);
  });

  it("never leaves a bare yes behind when the claim it agreed to is cut", () => {
    for (const sentence of ["Ji haan, M size available hai.", "Ji haan, mil jayega, M size available hai.", "Good news, M size available hai!"]) {
      const result = compose({ draft: { language: "roman_ur", messages: [sentence, "Order karna hai?"], showProducts: [] } }, true);
      expect(texts(result), sentence).toEqual(["Order karna hai?"]);
    }
  });

  it("still drops a sentence that invents a price, even next to a size fact", () => {
    const result = compose({ draft: { language: "roman_ur", messages: ["{{size:P1:L}}, aur ye 4500 ka hai.", "Order karna hai?"], showProducts: [] } }, true);
    expect(texts(result)).toEqual(["Order karna hai?"]);
  });
});

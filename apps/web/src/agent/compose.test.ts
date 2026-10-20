import { describe, expect, it } from "vitest";
import { browseCatalog, extractFilters, hasProductIntent, searchCatalog, type CatalogItem } from "../catalog/search";
import { shopStatus, DEFAULT_SHOP_SETTINGS } from "../shop/settings";
import { amountsIn, composeReply, createProductRefs, refFor, stripInventedFacts } from "./compose";
import { clearLanguage, detectLanguage, fallbackDraft } from "./fallback";
import { formatHistory, historyFromMessages, shownProductIds, type StoredMessage } from "./memory";

const kurta: CatalogItem = {
  id: "22222222-2222-4222-8222-222222222222",
  sku: "KRT-1",
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
    { size: "S", normalizedSize: "S", stockQty: 2 },
    { size: "M", normalizedSize: "m", stockQty: 0 },
  ],
  imagePaths: [],
  aiText: "",
};

function compose(messages: string[], showProducts: string[] = [], language: "en" | "ur" | "roman_ur" = "roman_ur", sanitize = false) {
  const refs = createProductRefs();
  refFor(refs, kurta);
  return composeReply(
    { draft: { language, messages, showProducts }, chatId: "c@lid", refs, products: new Map([[kurta.id, kurta]]), publicUrl: (path) => `https://x/${path}` },
    { sanitize },
  );
}

describe("fact checker (review findings)", () => {
  const issuesOf = (text: string, allowed?: string) => {
    const refs = createProductRefs();
    refFor(refs, kurta);
    return composeReply({
      draft: { language: "roman_ur", messages: [text], showProducts: [] },
      chatId: "c",
      refs,
      products: new Map([[kurta.id, kurta]]),
      publicUrl: () => "",
      allowedAmounts: allowed ? amountsIn(allowed) : undefined,
    }).issues.join(" | ");
  };

  it("catches prices and discounts in every wording", () => {
    for (const text of ["Ye 2450 ka hai", "Qeemat sirf 2450 hai", "price only 2,450", "Rs: 2450", "20 percent off hai", "flat 500 off", "قیمت صرف ۲۴۵۰ ہے", "Rs 50 kam kar dunga"]) {
      expect(issuesOf(text), text).toContain("amount");
    }
  });

  it("catches stock counts and untagged size claims", () => {
    expect(issuesOf("M size 3 available hain")).toContain("quantity");
    expect(issuesOf("sirf 2 hi bache hain")).toContain("quantity");
    expect(issuesOf("L available hai")).toContain("size");
    expect(issuesOf("It is available in M")).toContain("size");
    expect(issuesOf("{{product:P1}} ka {{size:P1:S}}, lein?")).toBe("");
  });

  it("catches every common untagged size claim", () => {
    for (const text of ["Size M is available", "M is in stock", "M mein available hai", "We have it in M", "size 32 available hai", "XL sold out hai", "Medium bhi available hai", "M size khatam hai"]) {
      expect(issuesOf(text), text).toContain("size");
    }
    expect(issuesOf("Bas 2 pieces left")).toContain("quantity");
    expect(issuesOf("sirf 2 piece bache hain")).toContain("quantity");
  });

  it("doesn't flag ordinary words, questions or garment styles", () => {
    for (const text of [
      "Yes, it's available in red 👇",
      "It's in stock",
      "That's sold out right now, sorry.",
      "We have it in 10 colours",
      "Aapka size M hai ya L?",
      "Ji, 3 piece suits available hain 👇",
      "Ye 3 piece suit hai",
      "2 piece bhi milta hai",
      "Lahore m delivery hoti hai",
      "I'm the shop's assistant (automated) — I can show you what's in stock, prices and sizes.",
    ]) {
      expect(issuesOf(text), text).toBe("");
    }
  });

  it("only accepts shop amounts in sentences about policies", () => {
    const shop = "Free delivery on orders over Rs 5000";
    expect(issuesOf("Ye suit Rs 5000 ka hai", shop)).toContain("amount");
    expect(issuesOf("Rs 5000 se upar free delivery hai", shop)).toBe("");
  });

  it("lets the customer's address and phone be read back, never as money", () => {
    const refs = createProductRefs();
    refFor(refs, kurta);
    const readBackNumbers = amountsIn("House 1500, Street 700 923217654321 0321 7654321");
    const issues = (text: string) =>
      composeReply({ draft: { language: "roman_ur", messages: [text], showProducts: [] }, chatId: "c", refs, products: new Map([[kurta.id, kurta]]), publicUrl: () => "", readBackNumbers }).issues.join(" | ");
    expect(issues("Address: House 1500, Street 700 note kar liya.")).toBe("");
    expect(issues("Aap ka number 0321 7654321 hai na?")).toBe("");
    for (const text of ["Delivery sirf Rs 1500 hai", "Advance payment Rs 1500 bhej dein", "delivery pe flat 700 off milega", "House 1500 ka total 700 hai"]) {
      expect(issues(text), text).toContain("amount");
    }
  });

  it("treats '2 pieces wala suit' as a style, not a stock count", () => {
    expect(issuesOf("Ye 2 pieces wala suit hai")).toBe("");
    expect(issuesOf("Bas 2 pieces reh gaye")).toContain("quantity");
  });

  it("drops a sentence with a half-closed tag instead of sending its pieces", () => {
    const result = compose(["Ye {{size:P1:M} hai. Aur kuch chahiye?"], [], "roman_ur", true);
    expect(result.actions.map((action) => (action.type === "text" ? action.text : ""))).toEqual(["Aur kuch chahiye?"]);
    expect(result.issues.join()).toContain("broken tag");
  });

  it("drops the Urdu 'ہے' a model repeats after a size fact", () => {
    expect(compose(["جی، {{size:P1:M}} ہے۔"], [], "ur").actions[0]).toMatchObject({ text: "جی، *Ruby Kurta* میں M سائز ابھی ختم ہے۔" });
  });

  it("lets the database's fact win over a predicate the model adds after the tag", () => {
    const text = (messages: string[], language: "en" | "roman_ur" = "roman_ur") => {
      const action = compose(messages, [], language).actions[0];
      return action?.type === "text" ? action.text : "";
    };
    // M is sold out: "nahi hai" after the tag would read "…khatam hai nahi hai".
    expect(text(["{{size:P1:M}} nahi hai, lekin {{sizes:P1}}."])).toBe("*Ruby Kurta* mein M size abhi khatam hai, lekin S size available hai.");
    // S is in stock: a wrong "nahi hai" from the model doesn't survive either.
    expect(text(["{{product:P1}} ka {{size:P1:S}} nahi hai."])).toBe("*Ruby Kurta* ka S size available hai.");
    expect(text(["{{size:P1:S}} bhi mil jayega."])).toBe("*Ruby Kurta* mein S size available hai.");
    expect(text(["Yes, {{size:P1:S}} is available."], "en")).toBe("Yes, *Ruby Kurta*: size S is in stock.");
    // Words that start the next clause stay.
    expect(text(["{{size:P1:S}}, lein?"])).toBe("*Ruby Kurta* mein S size available hai, lein?");
    // Facts on separate lines stay on separate lines.
    expect(text(["{{product:P1}}: {{size:P1:S}}\n{{product:P1}}: {{size:P1:M}}"])).toBe("*Ruby Kurta*: S size available hai\n*Ruby Kurta*: M size abhi khatam hai");
  });

  it("lists every size in stock with {{sizes:P1}}", () => {
    const text = (messages: string[], language: "en" | "ur" | "roman_ur") => {
      const action = compose(messages, [], language).actions[0];
      return action?.type === "text" ? action.text : "";
    };
    expect(text(["Ji, {{sizes:P1}}."], "roman_ur")).toBe("Ji, *Ruby Kurta* mein S size available hai.");
    expect(text(["{{product:P1}} {{sizes:P1}}."], "en")).toBe("*Ruby Kurta* in stock in size S.");
    expect(issuesOf("{{sizes:P1}}, lein?")).toBe("");
  });

  it("rejects long lines copied from the owner's example chats", () => {
    const refs = createProductRefs();
    refFor(refs, kurta);
    const exampleChats = "Customer: salam\nYou: Ji Ali Raza sahab, aap ka parcel kal Gulberg wale ghar pe deliver ho jayega";
    const draft = { language: "roman_ur" as const, messages: ["Ji Ali Raza sahab, aap ka parcel kal Gulberg wale ghar pe deliver ho jayega", "Ji bilkul, ye dekhein 👇"], showProducts: [] };
    const result = composeReply({ draft, chatId: "c", refs, products: new Map([[kurta.id, kurta]]), publicUrl: () => "", exampleChats }, { sanitize: true });
    expect(result.issues.join()).toContain("copied a line from the example chats");
    // Short everyday phrases are fine.
    expect(result.actions.map((action) => (action.type === "text" ? action.text : ""))).toEqual(["Ji bilkul, ye dekhein 👇"]);
  });

  it("never mistakes product names for stock counts", () => {
    const suit: CatalogItem = { ...kurta, id: "33333333-3333-4333-8333-333333333333", name: "Ivory 3 Piece Lawn Suit" };
    const refs = createProductRefs();
    refFor(refs, suit);
    const result = composeReply({ draft: { language: "en", messages: ["The {{product:P1}} is lovely."], showProducts: [] }, chatId: "c", refs, products: new Map([[suit.id, suit]]), publicUrl: () => "" }, { sanitize: true });
    expect(result.issues).toEqual([]);
    expect(result.actions[0]).toMatchObject({ text: "The *Ivory 3 Piece Lawn Suit* is lovely." });
  });

  it("allows shop-published amounts only outside product sentences", () => {
    expect(issuesOf("Delivery Rs 250 hai, 5,000 se upar free.", "Delivery charge Rs 250, free above Rs 5,000")).toBe("");
    expect(issuesOf("{{product:P1}} Rs 250 ka hai", "Delivery charge Rs 250")).toContain("amount");
    // 100% cotton is not a price.
    expect(issuesOf("Ye 100% cotton hai")).toBe("");
  });

  it("names the product in a size fact when the sentence doesn't", () => {
    const result = compose(["Ji, {{size:P1:S}}."]);
    expect(result.actions[0]).toMatchObject({ text: "Ji, *Ruby Kurta* mein S size available hai." });
  });

  it("ends a size fact that runs straight into the next sentence", () => {
    const result = compose(["Zabardast! {{size:P1:S}} Team aap se rabta karegi."]);
    expect(result.actions[0]).toMatchObject({ text: "Zabardast! *Ruby Kurta* mein S size available hai. Team aap se rabta karegi." });
    expect(compose(["{{size:P1:S}}, lein?"]).actions[0]).toMatchObject({ text: "*Ruby Kurta* mein S size available hai, lein?" });
  });

  it("drops the 'hai' a model repeats after a size fact", () => {
    expect(compose(["Ji, {{size:P1:S}} hai."]).actions[0]).toMatchObject({ text: "Ji, *Ruby Kurta* mein S size available hai." });
    expect(compose(["{{size:P1:M}} hain, sorry"]).actions[0]).toMatchObject({ text: "*Ruby Kurta* mein M size abhi khatam hai, sorry" });
    // Only right after the fact: the customer-facing words elsewhere stay as written.
    expect(compose(["Ye hai hai bohat acha"]).actions[0]).toMatchObject({ text: "Ye hai hai bohat acha" });
  });

  it("removes every broken tag fragment", () => {
    const result = compose(["{{Product:P9}} {{size:P1:M} dekhein {{oops}} }}"]);
    const text = result.actions[0]?.type === "text" ? result.actions[0].text : "";
    expect(text).not.toMatch(/\{\{|\}\}/);
    expect(result.issues.join()).toContain("unknown product ref P9");
  });
});

describe("composeReply", () => {
  it("renders product and size tags from the database", () => {
    const result = compose(["{{product:P1}}: {{size:P1:small}}, {{size:p1:M}}, {{size:P1:XL}}"]);
    expect(result.issues).toEqual([]);
    expect(result.actions[0]).toMatchObject({ type: "text", text: "*Ruby Kurta*: S size available hai, M size abhi khatam hai, XL size nahi aata" });
  });

  it("flags typed prices, discounts, quantities and unknown refs", () => {
    expect(compose(["Ye Rs 2,000 ka hai"]).issues.join()).toContain("price");
    expect(compose(["sirf 3000 rupay"]).issues.join()).toContain("price");
    expect(compose(["20% off hai aaj"]).issues.join()).toContain("price");
    expect(compose(["Bas 2 pieces left"]).issues.join()).toContain("quantity");
    expect(compose(["{{product:P7}} dekhein"]).issues.join()).toContain("unknown product ref P7");
    // Fabric percentages are not prices.
    expect(compose(["100% cotton hai"]).issues).toEqual([]);
  });

  it("puts product cards between the first message and the rest; no-photo items become one text card", () => {
    const result = compose(["Ye dekhein 👇", "Size bata dein?"], ["P1"]);
    expect(result.actions.map((action) => (action.type === "text" ? action.text.split("\n")[0] : "image"))).toEqual(["Ye dekhein 👇", "*Ruby Kurta*", "Size bata dein?"]);
    expect(result.shownProductIds).toEqual([kurta.id]);
  });

  it("sends cards right after the message that points at them", () => {
    const firstLines = (messages: string[]) =>
      compose(messages, ["P1"]).actions.map((action) => (action.type === "text" ? action.text.split("\n")[0] : "image"));
    expect(firstLines(["Walaikum assalam bhai!", "Abhi ye available hai, dekhein 👇", "Kya pasand hai?"])).toEqual([
      "Walaikum assalam bhai!",
      "Abhi ye available hai, dekhein 👇",
      "*Ruby Kurta*",
      "Kya pasand hai?",
    ]);
    expect(firstLines(["Walaikum assalam!", "Kya pasand hai?"])).toEqual(["Walaikum assalam!", "*Ruby Kurta*", "Kya pasand hai?"]);
  });

  it("sanitizes by dropping sentences with invented facts", () => {
    expect(stripInventedFacts("Bohat acha hai. Sirf Rs 999 mein! Le lein?")).toBe("Bohat acha hai. Le lein?");
    expect(compose(["Rs 999 only"], [], "en", true).actions).toEqual([]);
  });
});

describe("memory", () => {
  const rows: StoredMessage[] = [
    { id: "1", direction: "inbound", source: "customer", contentType: "text", text: "red kurta?", mediaPath: null, occurredAt: "" },
    { id: "2", direction: "outbound", source: "agent", contentType: "image", text: "*Ruby Kurta*\nQeemat: Rs 3,200", mediaPath: `products/${kurta.id}/a.jpg`, occurredAt: "" },
    { id: "3", direction: "outbound", source: "system", contentType: "text", text: "alert", mediaPath: null, occurredAt: "" },
    { id: "4", direction: "outbound", source: "agent", contentType: "text", text: "Customer wants to talk to a person\nName: x", mediaPath: null, occurredAt: "" },
    { id: "5", direction: "outbound", source: "human", contentType: "text", text: "Ji main call karta hoon", mediaPath: null, occurredAt: "" },
    { id: "6", direction: "inbound", source: "customer", contentType: "image", text: null, mediaPath: "messages/a/b.jpg", occurredAt: "" },
  ];

  it("keeps customer, bot and owner turns; drops alerts and the current message", () => {
    const lines = historyFromMessages(rows, "6");
    expect(formatHistory(lines)).toBe("Customer: red kurta?\nYou: [product photo] *Ruby Kurta* | Qeemat: Rs 3,200\nShop team member: Ji main call karta hoon");
  });

  it("knows which products were already shown", () => {
    expect(shownProductIds(rows)).toEqual([kurta.id]);
  });

  it("keeps the newest lines when the chat is long", () => {
    const long = Array.from({ length: 50 }, (_, index) => ({ role: "customer" as const, text: `message ${index} ${"x".repeat(100)}` }));
    const text = formatHistory(long, 1_000);
    expect(text).toContain("message 49");
    expect(text).not.toContain("message 0 ");
  });
});

describe("detectLanguage", () => {
  it("tells Urdu script, Roman Urdu and English apart", () => {
    expect(detectLanguage("سرخ قمیض ہے؟")).toBe("ur");
    expect(detectLanguage("Yr apke paas red shirt available ha?")).toBe("roman_ur");
    expect(detectLanguage("Do you have red shirts?")).toBe("en");
    expect(detectLanguage("👍", "roman_ur")).toBe("roman_ur");
  });

  it("only names a reply language when the message shows it clearly", () => {
    expect(clearLanguage("کالا عبایا ہے؟")).toBe("ur");
    expect(clearLanguage("theek hai L size wala le lunga")).toBe("roman_ur");
    expect(clearLanguage("M hai?")).toBe("roman_ur");
    expect(clearLanguage("Is the blue shirt available in large?")).toBe("en");
    // Product words must not make a Roman Urdu request look English: then the chat's language decides.
    expect(clearLanguage("maroon kurta dikhao")).toBe("roman_ur");
    expect(clearLanguage("red or maroon kurta dikhao")).toBeUndefined();
    // English chat slang that looks like Urdu ("ya", "hun") doesn't make it Roman Urdu.
    expect(clearLanguage("ok ya sure thanks hun")).toBeUndefined();
    expect(clearLanguage("ya sure, can you show me the red one")).toBe("en");
    // Names and addresses aren't English sentences: the chat's language decides.
    expect(clearLanguage("Ali Raza, 0321 7654321, House 12 Street 4 Gulberg, Lahore")).toBeUndefined();
    expect(clearLanguage("M size wala order kar do")).toBe("roman_ur");
    // Too short to tell: the chat's language decides.
    expect(clearLanguage("ok")).toBeUndefined();
    expect(clearLanguage("Hii brother")).toBeUndefined();
    expect(clearLanguage("👍")).toBeUndefined();
  });
});

describe("rules fallback", () => {
  it("answers a size question about the product already shown", () => {
    const refs = createProductRefs();
    const focusRef = refFor(refs, kurta);
    const text = "M size mein hai?";
    const filters = extractFilters(text);
    const draft = fallbackDraft({
      text,
      language: "roman_ur",
      firstContact: false,
      hasPhoto: false,
      wantsHuman: false,
      handoffAlreadyPending: false,
      status: shopStatus(DEFAULT_SHOP_SETTINGS, new Date("2026-09-28T10:00:00Z")),
      filters,
      search: hasProductIntent(filters) ? searchCatalog([kurta], filters, 5) : null,
      overview: browseCatalog([kurta], undefined, 4),
      refs,
      focusRef,
    });
    const reply = composeReply({ draft, chatId: "c", refs, products: new Map([[kurta.id, kurta]]), publicUrl: () => "" }, { sanitize: true });
    expect(reply.actions.map((action) => (action.type === "text" ? action.text : ""))).toEqual([
      "*Ruby Kurta* mein M size abhi khatam hai.",
      "Koi aur size ya design dekhna ho to bata dein.",
    ]);
  });
});

describe("shopStatus", () => {
  it("uses Pakistan time and says when the team is back", () => {
    // 21:00 UTC = 02:00 in Karachi.
    const night = shopStatus(DEFAULT_SHOP_SETTINGS, new Date("2026-09-28T21:00:00Z"));
    expect(night).toMatchObject({ open: false, nextOpenLabel: "today at 11am" });
    const evening = shopStatus(DEFAULT_SHOP_SETTINGS, new Date("2026-09-28T15:00:00Z"));
    expect(evening.open).toBe(true);
    expect(shopStatus({ ...DEFAULT_SHOP_SETTINGS, closedDays: ["mon"] }, new Date("2026-09-28T08:00:00Z")).open).toBe(false);
  });
});

describe("shop-published amounts", () => {
  it("lets the bot quote numbers from Shop info but not invent others", () => {
    const refs = createProductRefs();
    const run = (text: string) =>
      composeReply({ draft: { language: "en", messages: [text], showProducts: [] }, chatId: "c", refs, products: new Map(), publicUrl: () => "", allowedAmounts: amountsIn("Delivery Rs 250 all over Pakistan, free above Rs 5,000") });
    expect(run("Delivery is Rs 250, free above Rs 5,000.").issues).toEqual([]);
    expect(run("Delivery is Rs 300.").issues.join()).toContain("price");
  });
});

describe("wantsPerson", () => {
  it("catches requests for a person in all three scripts without false alarms", async () => {
    const { wantsPerson } = await import("./orchestrator");
    expect(wantsPerson("muje call pe baat krni ha")).toBe(true);
    expect(wantsPerson("I want to talk to a human")).toBe(true);
    expect(wantsPerson("مجھے کال کریں")).toBe(true);
    // "کالا" (black) contains "کال" (call).
    expect(wantsPerson("کالا عبایا ہے؟")).toBe(false);
    expect(wantsPerson("red kurta hai?")).toBe(false);
  });
});

describe("detectLanguage on agent-style Roman Urdu", () => {
  it("recognises Roman Urdu built from common function words", () => {
    expect(detectLanguage("Main shop ka assistant hoon. Ji, S size available hai")).toBe("roman_ur");
    expect(detectLanguage("I am the shop assistant, the size is available")).toBe("en");
  });
});

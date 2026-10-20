import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InboundMessage, OutboundAction } from "@huzaifa/contracts";
import { resetModelHealth } from "../ai/gemini";
import { OrderError, type AgentRunRecord, type BrainRepository, type ConversationState, type CustomerDetails, type IngestResult, type OpenHandoff, type SavedOrderDraft } from "../catalog/repository";
import type { CatalogItem } from "../catalog/search";
import type { PhotoHit, SemanticHit } from "../catalog/semantic";
import { EMPTY_DETAILS, NO_ORDERS, orderFingerprint, type OrderDraft, type OrderState } from "../orders/cart";
import { DEFAULT_SHOP_SETTINGS } from "../shop/settings";
import type { StoredMessage } from "./memory";
import { processInboundMessage, type OrchestratorDependencies } from "./orchestrator";

const product = (partial: Partial<CatalogItem> & Pick<CatalogItem, "id" | "name" | "category">): CatalogItem => ({
  sku: partial.id.toUpperCase(),
  description: "",
  color: null,
  material: null,
  styleTags: [],
  aliases: [],
  pricePkr: 3000,
  createdAt: "2026-09-01T00:00:00Z",
  variants: [{ size: "M", normalizedSize: "M", stockQty: 3 }],
  imagePaths: [],
  aiText: "",
  ...partial,
});

const blueShirt = product({ id: "11111111-1111-4111-8111-111111111111", name: "Oxford Shirt", category: "shirt", color: "blue", pricePkr: 2800, createdAt: "2026-09-03T00:00:00Z" });
const redKurta = product({
  id: "22222222-2222-4222-8222-222222222222",
  name: "Ruby Kurta",
  category: "kurta",
  color: "red",
  pricePkr: 3200,
  imagePaths: ["products/22222222-2222-4222-8222-222222222222/a.jpg"],
  variants: [
    { size: "S", normalizedSize: "S", stockQty: 1 },
    { size: "M", normalizedSize: "M", stockQty: 0 },
  ],
  createdAt: "2026-09-02T00:00:00Z",
});
const greenKurta = product({ id: "33333333-3333-4333-8333-333333333333", name: "Emerald Lawn Kurta", category: "kurta", color: "green", material: "lawn", pricePkr: 4500 });

class FakeRepository implements BrainRepository {
  state: ConversationState = "bot_active";
  saved: { actions: OutboundAction[]; customerChatId: string }[] = [];
  runs: AgentRunRecord[] = [];
  handoffs: string[][] = [];
  pendingMarked = 0;
  details: CustomerDetails[] = [];
  summaries: string[] = [];
  extras: Partial<IngestResult> = {};
  history: StoredMessage[] = [];
  constructor(readonly catalog: CatalogItem[] = [blueShirt, redKurta, greenKurta]) {}

  async ingestInbound(): Promise<IngestResult> {
    return {
      duplicate: false,
      conversation: { id: "conversation-1", state: this.state, activeProductId: null, summary: null },
      contact: { displayName: "Faizan", customerName: null, location: null, preferredLanguage: null },
      inboundMessageId: "in-current",
      firstContact: false,
      recentInboundCount: 1,
      totalMessages: 5,
      ...this.extras,
    };
  }
  async loadRecentMessages(): Promise<StoredMessage[]> {
    return this.history;
  }
  async loadCatalog(): Promise<CatalogItem[]> {
    return this.catalog;
  }
  async saveActions(_conversationId: string, actions: OutboundAction[], customerChatId: string): Promise<void> {
    this.saved.push({ actions, customerChatId });
  }
  async beginHandoff(_conversationId: string, _reason: string, _actionId: string, productIds: string[]): Promise<void> {
    if (this.failBeginHandoff) throw new Error("rpc down");
    this.handoffs.push(productIds);
  }
  async markHandoffPending(): Promise<void> {
    this.pendingMarked += 1;
  }
  async rememberProduct(): Promise<void> {}
  async saveCustomerDetails(_chatId: string, details: CustomerDetails): Promise<void> {
    this.details.push(details);
  }
  async saveSummary(_conversationId: string, summary: string): Promise<void> {
    this.summaries.push(summary);
  }
  async recordAgentRun(run: AgentRunRecord): Promise<void> {
    this.runs.push(run);
  }
  ownerTyped = false;
  openHandoffInfo: OpenHandoff | null = null;
  replay: OutboundAction[] = [];
  failBeginHandoff = false;
  async ownerRepliedSince(): Promise<boolean> {
    return this.ownerTyped;
  }
  async openHandoff(): Promise<OpenHandoff | null> {
    return this.openHandoffInfo;
  }
  async replayPendingActions(): Promise<OutboundAction[]> {
    return this.replay;
  }
  orders: OrderState = NO_ORDERS;
  savedDrafts: { draft: OrderDraft; options: { deliveryFeePkr: number | null; summaryFingerprint: string | null } }[] = [];
  placed: { orderId: string; fingerprint: string }[] = [];
  discarded = 0;
  placeError: OrderError | null = null;
  semantic: SemanticHit[] = [];
  semanticQueries = 0;
  async loadOrderState(): Promise<OrderState> {
    return this.orders;
  }
  async saveOrderDraft(_conversationId: string, draft: OrderDraft, options: { deliveryFeePkr: number | null; summaryFingerprint: string | null }): Promise<SavedOrderDraft> {
    this.savedDrafts.push({ draft, options });
    return { id: draft.id ?? "order-1", number: draft.number ?? 1024, itemsTotalPkr: 0 };
  }
  async discardOrderDraft(): Promise<void> {
    this.discarded += 1;
  }
  async placeOrder(orderId: string, fingerprint: string): Promise<number> {
    if (this.placeError) throw this.placeError;
    this.placed.push({ orderId, fingerprint });
    return 1024;
  }
  async matchProducts(): Promise<SemanticHit[]> {
    this.semanticQueries += 1;
    return this.semantic;
  }
  photo: PhotoHit[] = [];
  photoQueries: { count: number; minSimilarity: number }[] = [];
  async matchProductImages(_embedding: readonly number[], count: number, minSimilarity: number): Promise<PhotoHit[]> {
    this.photoQueries.push({ count, minSimilarity });
    return this.photo;
  }
}

const message = (text: string, extra: Partial<InboundMessage> = {}): InboundMessage => ({
  eventId: "evt-1",
  messageId: "msg-1",
  chatId: "98100000000068@lid",
  occurredAt: "2026-09-28T16:00:00.000Z",
  type: "text",
  text,
  ...extra,
});

const texts = (actions: OutboundAction[]) => actions.flatMap((action) => (action.type === "text" ? [action.text] : []));
const deps = (repository: FakeRepository, extra: Partial<OrchestratorDependencies> = {}): OrchestratorDependencies => ({
  repository,
  supportChatId: "923249469424@c.us",
  publicUrl: (path) => `https://project.supabase.co/storage/v1/object/public/product-images/${path}`,
  // 16:00 UTC = 21:00 in Karachi: shop open (default hours 11–22).
  now: () => new Date("2026-09-28T16:00:00Z"),
  ...extra,
});

// Gemini generateContent response carrying the agent's JSON.
const gemini = (payload: Record<string, unknown>) =>
  new Response(
    JSON.stringify({
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  language: "roman_ur",
                  tool_calls: [],
                  messages: [],
                  show_products: [],
                  handoff: { requested: false, reason: "" },
                  customer: { name: "", city: "" },
                  ...payload,
                }),
              },
            ],
          },
          finishReason: "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 60 },
    }),
    { status: 200 },
  );

const agentDeps = (fetchImpl: typeof fetch) => ({ apiKey: ["k".repeat(30)], models: ["writer"], budgetMs: 20_000, fetchImpl });

beforeEach(() => resetModelHealth());

describe("rules only (Gemini unavailable) — the four messages from the real chat", () => {
  it('"Hii brother" gets a friendly greeting, not a failed product search', async () => {
    const repository = new FakeRepository();
    const response = await processInboundMessage(message("Hii brother"), deps(repository));
    const reply = texts(response.actions).join(" ");
    expect(reply).toMatch(/what are you looking for|kya dhoond/i);
    expect(reply).not.toMatch(/couldn't find|nahi mili/i);
    expect(response.actions.every((action) => action.type === "text")).toBe(true);
  });

  it('"red shirt available ha?" says it is not available and shows the closest items with photo and DB price', async () => {
    const repository = new FakeRepository();
    const response = await processInboundMessage(message("Yr apke paas red shirt available ha?"), deps(repository));
    expect(texts(response.actions)[0]).toMatch(/red shirt abhi available nahi/i);
    const card = response.actions.find((action) => action.type === "image");
    expect(card).toMatchObject({ type: "image", url: expect.stringContaining("/product-images/products/22222222") });
    expect(card?.type === "image" ? card.caption : "").toContain("Rs 3,200");
    // The wrong-colour shirt is never presented as the answer.
    expect(texts(response.actions)[0]).not.toContain("Oxford Shirt");
  });

  it('"Aap kon ho muje call pe baat krni ha" hands off and alerts the owner, bot keeps helping', async () => {
    const repository = new FakeRepository();
    const response = await processInboundMessage(message("Aap kon ho muje call pe baat krni ha"), deps(repository));
    const alert = response.actions.find((action) => action.recipientChatId === "923249469424@c.us");
    expect(alert?.type === "text" ? alert.text : "").toContain("Customer wants to talk to a person");
    expect(repository.handoffs).toHaveLength(1);
    expect(repository.pendingMarked).toBe(1);
    expect(texts(response.actions)[0]).toMatch(/team/i);
    // saveActions gets the customer's chat id so the alert is stored as a system message, out of chat memory.
    expect(repository.saved[0]?.customerChatId).toBe("98100000000068@lid");
  });

  it('"Apke paas kya available ha abhi" shows an overview with the newest items', async () => {
    const repository = new FakeRepository();
    const response = await processInboundMessage(message("Apke paas kya available ha abhi"), deps(repository));
    expect(texts(response.actions)[0]).toMatch(/hamare paas .*kurta/i);
    expect(response.actions.some((action) => action.type === "image")).toBe(true);
  });
});

describe("pausing and handoff v2", () => {
  it("stays silent while the owner is chatting", async () => {
    const repository = new FakeRepository();
    repository.state = "human_active";
    const response = await processInboundMessage(message("hello?"), deps(repository));
    expect(response.actions).toEqual([]);
  });

  it("keeps helping without a second alert while the team is already notified", async () => {
    const repository = new FakeRepository();
    repository.state = "handoff_requested";
    const response = await processInboundMessage(message("human please"), deps(repository));
    expect(repository.handoffs).toHaveLength(0);
    expect(response.actions.every((action) => action.recipientChatId !== "923249469424@c.us")).toBe(true);
    expect(texts(response.actions)[0]).toMatch(/already/i);
  });

  it("stops replying to a chat that floods messages", async () => {
    const repository = new FakeRepository();
    repository.extras = { recentInboundCount: 12 };
    const response = await processInboundMessage(message("kurta"), deps(repository));
    expect(response.actions).toEqual([]);
    expect(repository.runs[0]?.outcome).toBe("throttled");
  });
});

describe("agent path", () => {
  it("lets the model write the words while code renders name, price and sizes", async () => {
    const repository = new FakeRepository();
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      gemini({ messages: ["Red shirt to abhi nahi hai bhai, lekin {{product:P1}} same rang mein hai 👇", "Kaunsa size chahiye?"], show_products: ["P1"] }),
    );
    const response = await processInboundMessage(message("Yr apke paas red shirt available ha?"), deps(repository, { agent: agentDeps(fetchImpl) }));
    expect(response.actions.map((action) => action.type)).toEqual(["text", "image", "text"]);
    expect(texts(response.actions)[0]).toContain("*Ruby Kurta*");
    const card = response.actions[1];
    expect(card?.type === "image" ? card.caption : "").toMatch(/Qeemat: Rs 3,200\nSizes: S$/);
    expect(repository.runs[0]).toMatchObject({ model: "writer", outcome: "reply_products", candidateProductIds: [redKurta.id] });
  });

  it("gives the model chat history, customer profile and the pre-search results", async () => {
    const repository = new FakeRepository();
    repository.history = [
      { id: "h1", direction: "inbound", source: "customer", contentType: "text", text: "Salam bhai", mediaPath: null, occurredAt: "2026-09-28T15:50:00Z" },
      { id: "h2", direction: "outbound", source: "agent", contentType: "text", text: "Walaikum assalam! Kya dhoond rahe hain?", mediaPath: null, occurredAt: "2026-09-28T15:50:05Z" },
      { id: "h3", direction: "outbound", source: "system", contentType: "text", text: "Customer wants to talk to a person", mediaPath: null, occurredAt: "2026-09-28T15:51:00Z" },
    ];
    const fetchImpl = vi.fn<typeof fetch>(async () => gemini({ messages: ["Ji bilkul!"] }));
    await processInboundMessage(message("red kurta hai?"), deps(repository, { agent: agentDeps(fetchImpl) }));
    const body = JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body));
    const context = body.contents[0].parts[0].text as string;
    expect(context).toContain("Customer: Salam bhai");
    expect(context).toContain("You: Walaikum assalam!");
    expect(context).not.toContain("Customer wants to talk to a person");
    expect(context).toContain('WhatsApp name "Faizan"');
    expect(context).toMatch(/Matches:\n\[P1\] Ruby Kurta/);
    expect(body.systemInstruction.parts[0].text).toContain("Never type prices");
  });

  it("runs a tool round when the model asks for one", async () => {
    const repository = new FakeRepository();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(gemini({ tool_calls: [{ name: "search_products", category: "kurta", color: "green", size: "", max_price: 0, text: "", product_id: "" }] }))
      .mockResolvedValueOnce(gemini({ messages: ["Ye dekhein 👇"], show_products: ["P1"] }));
    const response = await processInboundMessage(message("aur koi colour?"), deps(repository, { agent: agentDeps(fetchImpl) }));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(String(fetchImpl.mock.calls[1]![1]?.body));
    const toolTurn = secondBody.contents.at(-1).parts[0].text as string;
    expect(toolTurn).toContain("TOOL RESULTS");
    expect(toolTurn).toContain("Emerald Lawn Kurta");
    const ref = toolTurn.match(/\[(P\d+)\] Emerald Lawn Kurta/)![1];
    expect(repository.runs[0]?.diagnostics).toMatchObject({ calls: 2, tools: ["search_products"] });
    expect(ref).toBeTruthy();
    expect(response.actions.length).toBeGreaterThan(0);
  });

  it("rejects typed prices, asks for one rewrite, and uses the clean version", async () => {
    const repository = new FakeRepository();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(gemini({ messages: ["{{product:P1}} sirf Rs 2,000 ka hai!"], show_products: ["P1"] }))
      .mockResolvedValueOnce(gemini({ messages: ["{{product:P1}} bohat acha hai 👇"], show_products: ["P1"] }));
    const response = await processInboundMessage(message("red kurta"), deps(repository, { agent: agentDeps(fetchImpl) }));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(String(fetchImpl.mock.calls[1]![1]?.body));
    expect(secondBody.contents.at(-1).parts[0].text).toContain('Your reply was rejected: typed a price, discount or other amount; product prices come only from the product cards (in "{{product:P1}} sirf Rs 2,000 ka hai!")');
    expect(texts(response.actions).join(" ")).not.toContain("2,000");
  });

  it("strips invented facts if the rewrite is still wrong", async () => {
    const repository = new FakeRepository();
    const fetchImpl = vi.fn<typeof fetch>(async () => gemini({ messages: ["Ye lijiye. Sirf 2 pieces left hain, Rs 1500 mein!"], show_products: ["P1"] }));
    const response = await processInboundMessage(message("red kurta"), deps(repository, { agent: agentDeps(fetchImpl) }));
    const reply = texts(response.actions).join(" ");
    expect(reply).toContain("Ye lijiye.");
    expect(reply).not.toMatch(/1500|pieces left/);
    expect(repository.runs[0]?.diagnostics).toMatchObject({ issues: expect.arrayContaining([expect.stringContaining("price")]) });
  });

  it("falls back to rules when every model fails, and records why", async () => {
    const repository = new FakeRepository();
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 503 }));
    const response = await processInboundMessage(message("Hii brother"), deps(repository, { agent: agentDeps(fetchImpl) }));
    expect(texts(response.actions)[0]).toMatch(/kya dhoond|looking for/i);
    expect(repository.runs[0]).toMatchObject({ outcome: "fallback", errorCode: "agent_http_503" });
  });

  it("alerts the owner when the model decides a person is needed", async () => {
    const repository = new FakeRepository();
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      gemini({
        messages: ["Bulk order ke liye main team ko bata deta hoon, wo jald rabta karenge."],
        handoff: { requested: true, reason: "Wholesale order" },
        customer: { name: "Ali", city: "Lahore" },
      }),
    );
    const response = await processInboundMessage(message("mujhe 50 kurtay chahiye shop ke liye, main Ali Lahore se"), deps(repository, { agent: agentDeps(fetchImpl) }));
    const alert = response.actions.find((action) => action.recipientChatId === "923249469424@c.us");
    expect(alert?.type === "text" ? alert.text : "").toContain("Reason: Wholesale order");
    expect(repository.details.at(-1)).toMatchObject({ name: "Ali", location: "Lahore" });
  });

  it("refreshes the conversation summary after the reply", async () => {
    const repository = new FakeRepository();
    // Refreshed every 4th customer message once there are 7+.
    repository.extras = { inboundTotal: 8 };
    const tasks: (() => Promise<void>)[] = [];
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(gemini({ messages: ["Ji!"] }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ summary: "Ali from Lahore wants a red kurta, size S." }) }] } }] }), { status: 200 }),
      );
    await processInboundMessage(message("ok"), deps(repository, { agent: agentDeps(fetchImpl), defer: (task) => tasks.push(task) }));
    expect(repository.summaries).toEqual([]);
    await Promise.all(tasks.map((task) => task()));
    expect(repository.summaries).toEqual(["Ali from Lahore wants a red kurta, size S."]);
  });
});

describe("review fixes", () => {
  it("ignores messages from the support number (the owner replying to an alert)", async () => {
    const repository = new FakeRepository();
    const response = await processInboundMessage(message("ok", { chatId: "923249469424@c.us" }), deps(repository));
    expect(response.actions).toEqual([]);
    const viaLid = await processInboundMessage(message("call me", { chatId: "555@lid", phoneNumber: "923249469424" }), deps(repository));
    expect(viaLid.actions).toEqual([]);
    expect(repository.handoffs).toHaveLength(0);
  });

  it("drops its reply and never flips the takeover when the owner typed during the turn", async () => {
    const repository = new FakeRepository();
    repository.ownerTyped = true;
    const response = await processInboundMessage(message("human please"), deps(repository));
    expect(response.actions).toEqual([]);
    expect(repository.handoffs).toHaveLength(0);
    expect(repository.pendingMarked).toBe(0);
    expect(repository.runs[0]?.outcome).toBe("owner_took_over");
  });

  it("replays undelivered actions when the gateway retries a processed message", async () => {
    const repository = new FakeRepository();
    repository.extras = { duplicate: true };
    repository.replay = [{ actionId: "7c3a4f0e-8f7b-4a3e-9f58-7bb1d0a4a111", recipientChatId: "98100000000068@lid", type: "text", text: "Ji bilkul!" }];
    const response = await processInboundMessage(message("red kurta"), deps(repository));
    expect(response).toMatchObject({ duplicate: true, actions: repository.replay });
  });

  it("still alerts the owner and replies when the handoff bookkeeping fails", async () => {
    const repository = new FakeRepository();
    repository.failBeginHandoff = true;
    const response = await processInboundMessage(message("mujhe insaan se baat karni hai"), deps(repository));
    expect(response.actions.some((action) => action.recipientChatId === "923249469424@c.us")).toBe(true);
    expect(response.actions.some((action) => action.recipientChatId !== "923249469424@c.us")).toBe(true);
    expect(repository.runs[0]?.errorCode).toBe("handoff_db_failed");
  });

  it("re-alerts only when the first alert failed or went unanswered for hours", async () => {
    const repository = new FakeRepository();
    repository.state = "handoff_requested";
    repository.openHandoffInfo = { requestedAt: new Date().toISOString(), notificationError: null };
    let response = await processInboundMessage(message("human please"), deps(repository));
    expect(response.actions.some((action) => action.recipientChatId === "923249469424@c.us")).toBe(false);
    repository.openHandoffInfo = { requestedAt: new Date().toISOString(), notificationError: "send_failed" };
    response = await processInboundMessage(message("human please"), deps(repository));
    expect(response.actions.some((action) => action.recipientChatId === "923249469424@c.us")).toBe(true);
  });

  it("only treats explicit phrases as a request for a person", async () => {
    const { wantsPerson } = await import("./orchestrator");
    for (const text of ["what do you call this colour?", "can I pick up in person?", "phone pe order ho sakta?", "staff uniform bulk", "banda 2 suit le sakta?", "فون نمبر"]) {
      expect(wantsPerson(text), text).toBe(false);
    }
    for (const text of ["mujhe insaan se baat karni hai", "call me please", "I want to talk to the owner", "manager se baat karwao", "مجھے کال کریں", "human"]) {
      expect(wantsPerson(text), text).toBe(true);
    }
  });

  it("gives the product under discussion the first ref", async () => {
    const repository = new FakeRepository();
    repository.history = [{ id: "h1", direction: "outbound", source: "agent", contentType: "image", text: "*Emerald Lawn Kurta*", mediaPath: `products/${greenKurta.id}/a.jpg`, occurredAt: "" }];
    const fetchImpl = vi.fn<typeof fetch>(async () => gemini({ messages: ["Ji, {{size:P1:M}}."] }));
    const response = await processInboundMessage(message("M hai is mein?"), deps(repository, { agent: agentDeps(fetchImpl) }));
    expect(texts(response.actions)[0]).toBe("Ji, *Emerald Lawn Kurta* mein M size available hai.");
  });
});

describe("review fixes (second pass)", () => {
  it("doesn't page the owner when a customer asks whether the bot is human", async () => {
    const { wantsPerson } = await import("./orchestrator");
    for (const text of ["are you human?", "Are you a real person or a bot?", "is this a bot", "aap insaan ho?"]) expect(wantsPerson(text), text).toBe(false);
    expect(wantsPerson("are you human? I want to talk to a human")).toBe(true);
  });

  it("after the owner took over, a retried turn replays only the alert to the owner", async () => {
    const repository = new FakeRepository();
    repository.state = "human_active";
    repository.extras = { duplicate: true };
    repository.replay = [
      { actionId: "a1", recipientChatId: "98100000000068@lid", type: "text", text: "Old bot reply" },
      { actionId: "a2", recipientChatId: "923249469424@c.us", type: "text", text: "Customer wants to talk to a person" },
    ];
    const response = await processInboundMessage(message("hello?"), deps(repository));
    expect(response.actions.map((action) => action.actionId)).toEqual(["a2"]);
  });

  it("still alerts the owner when every draft was rejected but the model asked for a handoff", async () => {
    const repository = new FakeRepository();
    const fetchImpl = vi.fn<typeof fetch>(async () => gemini({ messages: ["Ye Rs 5000 ka hai"], handoff: { requested: true, reason: "Complaint about a late parcel" } }));
    const response = await processInboundMessage(message("mera parcel abhi tak nahi aya, bohat bura hai"), deps(repository, { agent: agentDeps(fetchImpl) }));
    const alert = response.actions.find((action) => action.recipientChatId === "923249469424@c.us");
    expect(alert?.type === "text" ? alert.text : "").toContain("Reason: Complaint about a late parcel");
    expect(repository.runs[0]?.errorCode).toBe("agent_fact_check");
  });

  it("hands a buyer to the team when the AI is down", async () => {
    const repository = new FakeRepository();
    const response = await processInboundMessage(message("ye kurta order karna hai"), deps(repository));
    const alert = response.actions.find((action) => action.recipientChatId === "923249469424@c.us");
    expect(alert?.type === "text" ? alert.text : "").toContain("Reason: Wants to order");
    expect(texts(response.actions)[0]).toMatch(/team/i);
  });
});

// Orders: the model says what the customer wants, code checks it against the catalog and renders prices.
const kurtaShown: StoredMessage[] = [{ id: "h1", direction: "outbound", source: "agent", contentType: "image", text: "*Ruby Kurta*", mediaPath: `products/${redKurta.id}/a.jpg`, occurredAt: "" }];
const orderShop = { ...DEFAULT_SHOP_SETTINGS, deliveryFeePkr: 200 };
const pricing = { deliveryFeePkr: 200, freeDeliveryFromPkr: null };
const noOrder = { action: "none", items: [], name: "", phone: "", address: "", city: "", note: "" };
const cartDraft: OrderDraft = { id: "order-1", number: 1024, lines: [{ productId: redKurta.id, size: "S", normalizedSize: "S", quantity: 1 }], details: EMPTY_DETAILS, summaryFingerprint: null };
const completeDraft: OrderDraft = { ...cartDraft, details: { ...EMPTY_DETAILS, name: "Ali Khan", phone: "923001234567", address: "House 5, Street 2, Gulberg", city: "Lahore" } };
const catalogMap = () => new Map([blueShirt, redKurta, greenKurta].map((item) => [item.id, item]));

describe("orders", () => {
  function orderSetup(draft: OrderDraft | null) {
    const repository = new FakeRepository();
    repository.history = kurtaShown;
    repository.orders = { available: true, draft, recent: null };
    return repository;
  }

  it("adds the item to the order and asks for details, telling the model it can take orders", async () => {
    const repository = orderSetup(null);
    const bodies: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      bodies.push(String(init?.body));
      return gemini({ messages: ["Zabardast! Order ke liye naam, number aur address bata dein."], order: { ...noOrder, action: "update", items: [{ product: "P1", size: "S", quantity: 1 }] } });
    });
    const response = await processInboundMessage(message("S wala le lunga"), deps(repository, { shop: orderShop, agent: agentDeps(fetchImpl) }));
    expect(bodies[0]).toContain("ORDERS (you take orders in this chat)");
    expect(bodies[0]).toContain("No open order.");
    expect(repository.savedDrafts).toHaveLength(1);
    expect(repository.savedDrafts[0]?.draft.lines).toEqual([{ productId: redKurta.id, size: "S", normalizedSize: "S", quantity: 1 }]);
    expect(repository.savedDrafts[0]?.options).toEqual({ deliveryFeePkr: 200, summaryFingerprint: null });
    expect(texts(response.actions)).toEqual(["Zabardast! Order ke liye naam, number aur address bata dein."]);
    expect(repository.runs[0]?.outcome).toBe("order_updated");
  });

  it("sends the priced summary right after the message pointing at it once the order is complete", async () => {
    const repository = orderSetup(cartDraft);
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      gemini({
        messages: ["Shukriya Ali bhai! Ye raha aap ka order summary 👇", "Sab theek hai to confirm kar dein?"],
        order: { ...noOrder, action: "update", name: "Ali Khan", phone: "0300 1234567", address: "House 5, Street 2, Gulberg", city: "Lahore" },
      }),
    );
    const response = await processInboundMessage(message("Ali Khan, 0300 1234567, House 5 Street 2 Gulberg Lahore"), deps(repository, { shop: orderShop, agent: agentDeps(fetchImpl) }));
    const replies = texts(response.actions);
    expect(replies[0]).toBe("Shukriya Ali bhai! Ye raha aap ka order summary 👇");
    expect(replies[1]).toContain("🧾 *Aap ka order — abhi place nahi hua*\n1. Ruby Kurta — S × 1 — Rs 3,200");
    expect(replies[1]).toContain("Delivery: Rs 200\n*Total: Rs 3,400*");
    expect(replies[1]).toContain("Phone: 0300 1234567");
    expect(replies[2]).toBe("Sab theek hai to confirm kar dein?");
    expect(repository.savedDrafts[0]?.options.summaryFingerprint).toBe(orderFingerprint(completeDraft, catalogMap(), pricing));
  });

  it("places a confirmed order, thanks the customer with the number and alerts the owner", async () => {
    const shown = { ...completeDraft, summaryFingerprint: orderFingerprint(completeDraft, catalogMap(), pricing) };
    const repository = orderSetup(shown);
    const fetchImpl = vi.fn<typeof fetch>(async () => gemini({ messages: ["Bohat shukriya! 🙏"], order: { ...noOrder, action: "place" } }));
    const response = await processInboundMessage(message("ji confirm"), deps(repository, { shop: orderShop, agent: agentDeps(fetchImpl), adminBaseUrl: "https://shop.example.com/" }));
    expect(repository.placed).toEqual([{ orderId: "order-1", fingerprint: shown.summaryFingerprint }]);
    const customer = response.actions.filter((action) => action.recipientChatId === "98100000000068@lid");
    expect(texts(customer)).toEqual(["Bohat shukriya! 🙏", "✅ Order #1024 mil gaya! Team confirm karke dispatch ki details yahin bhej degi."]);
    const alert = response.actions.find((action) => action.recipientChatId === "923249469424@c.us");
    expect(alert?.type === "text" ? alert.text : "").toContain("🛒 New order #1024");
    expect(alert?.type === "text" ? alert.text : "").toContain("Confirm or cancel: https://shop.example.com/admin/orders/order-1");
    expect(repository.runs[0]?.outcome).toBe("order_placed");
  });

  it("replaces the reply with an apology when the database refuses the order", async () => {
    const shown = { ...completeDraft, summaryFingerprint: orderFingerprint(completeDraft, catalogMap(), pricing) };
    const repository = orderSetup(shown);
    repository.placeError = new OrderError("out_of_stock", "out_of_stock: Ruby Kurta (S)");
    const fetchImpl = vi.fn<typeof fetch>(async () => gemini({ messages: ["Bohat shukriya!"], order: { ...noOrder, action: "place" } }));
    const response = await processInboundMessage(message("confirm"), deps(repository, { shop: orderShop, agent: agentDeps(fetchImpl) }));
    expect(texts(response.actions)).toEqual(["Maazrat, order ki ek item abhi stock se khatam ho gayi, is liye order place nahi ho saka. Kuch milta julta dikhaun?"]);
    expect(repository.runs[0]?.errorCode).toBe("order_out_of_stock");
  });

  it("sends the model back when it claims an order it didn't place", async () => {
    const repository = orderSetup(null);
    const bodies: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      bodies.push(String(init?.body));
      return bodies.length === 1
        ? gemini({ messages: ["Aap ka order confirm ho gaya ✅"], order: { ...noOrder, action: "update", items: [{ product: "P1", size: "S", quantity: 1 }] } })
        : gemini({ messages: ["Ji zaroor! Order ke liye apna naam bata dein."], order: { ...noOrder, action: "update", items: [{ product: "P1", size: "S", quantity: 1 }] } });
    });
    const response = await processInboundMessage(message("order kar do"), deps(repository, { shop: orderShop, agent: agentDeps(fetchImpl) }));
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toContain("says the order is placed or confirmed, but it isn't");
    expect(texts(response.actions)).toEqual(["Ji zaroor! Order ke liye apna naam bata dein."]);
  });

  it("doesn't place an order when the customer's message isn't a yes", async () => {
    const shown = { ...completeDraft, summaryFingerprint: orderFingerprint(completeDraft, catalogMap(), pricing) };
    const repository = orderSetup(shown);
    const bodies: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      bodies.push(String(init?.body));
      return bodies.length === 1
        ? gemini({ messages: ["Bohat shukriya!"], order: { ...noOrder, action: "place" } })
        : gemini({ messages: ["Delivery 3-5 din mein hoti hai. Order confirm kar dein?"], order: { ...noOrder, action: "none" } });
    });
    await processInboundMessage(message("delivery kab tak hogi?"), deps(repository, { shop: orderShop, agent: agentDeps(fetchImpl) }));
    expect(bodies[1]).toContain("isn't a clear yes to the summary");
    expect(repository.placed).toEqual([]);
  });

  it("never sends more than 8 actions, keeping the order messages and alerts", async () => {
    const shown = { ...completeDraft, summaryFingerprint: orderFingerprint(completeDraft, catalogMap(), pricing) };
    const repository = orderSetup(shown);
    const many = [blueShirt, redKurta, greenKurta].map((item) => ({ ...item, imagePaths: [`products/${item.id}/a.jpg`] }));
    repository.catalog.splice(0, repository.catalog.length, ...many);
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      gemini({
        messages: ["Bohat shukriya! 🙏", "Aur ye bhi dekhein 👇", "Koi aur cheez?"],
        show_products: ["P1", "P2", "P3"],
        handoff: { requested: true, reason: "Wants a call about delivery" },
        order: { ...noOrder, action: "place" },
      }),
    );
    const response = await processInboundMessage(message("ji confirm, call me please"), deps(repository, { shop: orderShop, agent: agentDeps(fetchImpl) }));
    expect(response.actions.length).toBeLessThanOrEqual(8);
    const all = texts(response.actions).join("\n");
    expect(all).toContain("✅ Order #1024 mil gaya!");
    expect(all).toContain("🛒 New order #1024");
    expect(all).toContain("Customer wants to talk to a person");
  });

  it("hands a cart in progress to the team when the AI is down", async () => {
    const repository = orderSetup(completeDraft);
    const response = await processInboundMessage(message("ji theek hai confirm"), deps(repository, { shop: orderShop }));
    const alert = response.actions.find((action) => action.recipientChatId === "923249469424@c.us");
    expect(alert?.type === "text" ? alert.text : "").toContain("Reason: Wants to order");
    expect(texts(response.actions)[0]).toMatch(/team/i);
    expect(repository.placed).toEqual([]);
  });

  it("keeps handing buyers to the team until the orders migration is applied", async () => {
    const repository = new FakeRepository();
    repository.history = kurtaShown;
    const bodies: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      bodies.push(String(init?.body));
      return gemini({
        messages: ["Ji, team aap se order confirm karegi."],
        handoff: { requested: true, reason: "Wants to order: Ruby Kurta, size S" },
        order: { ...noOrder, action: "update", items: [{ product: "P1", size: "S", quantity: 1 }] },
      });
    });
    const response = await processInboundMessage(message("S wala le lunga"), deps(repository, { shop: orderShop, agent: agentDeps(fetchImpl) }));
    expect(bodies[0]).toContain("You can't take orders, payments or addresses here");
    expect(repository.savedDrafts).toEqual([]);
    expect(response.actions.some((action) => action.recipientChatId === "923249469424@c.us")).toBe(true);
  });
});

describe("meaning-based search", () => {
  const embedding = () => new Response(JSON.stringify({ embedding: { values: Array.from({ length: 768 }, () => 0.01) } }), { status: 200 });

  it("shows a clear best match for an unknown word even without the AI", async () => {
    const repository = new FakeRepository();
    repository.semantic = [{ id: greenKurta.id, similarity: 0.71 }];
    const embed = vi.fn<typeof fetch>(async () => embedding());
    const response = await processInboundMessage(message("pishwas dikhao"), deps(repository, { embeddings: { apiKey: ["e".repeat(30)], model: "embed", fetchImpl: embed } }));
    expect(embed).toHaveBeenCalledOnce();
    expect(texts(response.actions)[0]).toBe("Shayad aap ye dhoond rahe hain 👇");
    expect(texts(response.actions).join("\n")).toContain("*Emerald Lawn Kurta*");
    expect(repository.runs[0]?.diagnostics).toMatchObject({ semantic: { query: "pishwas dikhao", hits: ["Emerald Lawn Kurta 0.71"] } });
  });

  it("gives the model meaning matches as guesses, and skips the search when keywords were enough", async () => {
    const repository = new FakeRepository();
    repository.semantic = [{ id: greenKurta.id, similarity: 0.62 }];
    const bodies: string[] = [];
    const agentFetch = vi.fn<typeof fetch>(async (_url, init) => {
      bodies.push(String(init?.body));
      return gemini({ messages: ["Ye dekhein 👇"], show_products: ["P1"] });
    });
    const embed = vi.fn<typeof fetch>(async () => embedding());
    const embeddings = { apiKey: ["e".repeat(30)], model: "embed", fetchImpl: embed };
    await processInboundMessage(message("pishwas hai?"), deps(repository, { agent: agentDeps(agentFetch), embeddings }));
    expect(bodies[0]).toContain("Similar in meaning (guesses for words the search didn");
    expect(bodies[0]).toContain("Emerald Lawn Kurta");
    // "red kurta" is fully understood by the keyword search: no embedding call.
    await processInboundMessage(message("red kurta hai?"), deps(repository, { agent: agentDeps(agentFetch), embeddings }));
    expect(embed).toHaveBeenCalledOnce();
  });
});

describe("photo search", () => {
  const embedding = () => new Response(JSON.stringify({ embedding: { values: Array.from({ length: 768 }, () => 0.01) } }), { status: 200 });
  const photoMessage = (caption = "ye available hai?") =>
    message(caption, { type: "image", media: { objectPath: `messages/${"a".repeat(24)}/${"b".repeat(32)}.jpg`, mimeType: "image/jpeg", sizeBytes: 2048 } });
  const photoDeps = (repository: FakeRepository, embed: typeof fetch, extra: Partial<OrchestratorDependencies> = {}) =>
    deps(repository, {
      loadImage: async () => ({ base64: "Q1VTVE9NRVI=", mimeType: "image/jpeg" }),
      photoSearch: { apiKey: ["e".repeat(30)], model: "gemini-embedding-2", fetchImpl: embed },
      loadProductImage: vi.fn(async () => ({ base64: "U0hPUA==", mimeType: "image/jpeg" })),
      ...extra,
    });
  const kurtaPhoto = "products/22222222-2222-4222-8222-222222222222/a.jpg";

  it("shows the model the products the photo looks like, with their shop photos to compare", async () => {
    const repository = new FakeRepository();
    repository.photo = [{ id: redKurta.id, similarity: 0.72, imagePath: kurtaPhoto }];
    const embed = vi.fn<typeof fetch>(async () => embedding());
    const bodies: string[] = [];
    const agentFetch = vi.fn<typeof fetch>(async (_url, init) => {
      bodies.push(String(init?.body));
      return gemini({ messages: ["Ji, ye wahi hai 👇"], show_products: ["P1"] });
    });
    const dependencies = photoDeps(repository, embed, { agent: agentDeps(agentFetch) });
    const response = await processInboundMessage(photoMessage(), dependencies);

    // The customer's photo is embedded on its own and matched against the shop's photos.
    expect(JSON.parse(String(embed.mock.calls[0]![1]?.body)).content.parts).toEqual([{ inline_data: { mime_type: "image/jpeg", data: "Q1VTVE9NRVI=" } }]);
    expect(repository.photoQueries).toEqual([{ count: 5, minSimilarity: 0.6 }]);
    expect(dependencies.loadProductImage).toHaveBeenCalledWith(kurtaPhoto);
    const parts = JSON.parse(bodies[0]!).contents[0].parts;
    expect(parts[0].text).toMatch(/Looks like the customer's photo \(image similarity, best first — guesses: compare before saying it's the same\):\n\[P1\] Ruby Kurta/);
    expect(parts[0].text).toContain("The shop photos after it show [P1], to compare with it.");
    expect(parts.slice(1)).toEqual([
      { text: "Customer's photo:" },
      { inline_data: { mime_type: "image/jpeg", data: "Q1VTVE9NRVI=" } },
      { text: "Shop photo of [P1]:" },
      { inline_data: { mime_type: "image/jpeg", data: "U0hPUA==" } },
    ]);
    expect(JSON.parse(bodies[0]!).systemInstruction.parts[0].text).toContain("Never say it's the same item unless it clearly looks the same");
    expect(response.actions.map((action) => action.type)).toEqual(["text", "image"]);
    expect(repository.runs[0]?.diagnostics).toMatchObject({ photo: { hits: ["Ruby Kurta 0.72"], compared: 1 } });
    expect(repository.runs[0]?.promptVersion).toBe("agent-v6");
  });

  it("leaves the photo to the model alone when nothing looks like it", async () => {
    const repository = new FakeRepository();
    const embed = vi.fn<typeof fetch>(async () => embedding());
    const bodies: string[] = [];
    const agentFetch = vi.fn<typeof fetch>(async (_url, init) => {
      bodies.push(String(init?.body));
      return gemini({ messages: ["Ye exact abhi nahi hai, rang bata dein?"] });
    });
    const dependencies = photoDeps(repository, embed, { agent: agentDeps(agentFetch) });
    await processInboundMessage(photoMessage(), dependencies);
    const parts = JSON.parse(bodies[0]!).contents[0].parts;
    expect(parts[0].text).not.toContain("Looks like the customer's photo");
    expect(parts[0].text).toContain("Describe what you see only to find similar products.");
    expect(parts.slice(1)).toEqual([{ inline_data: { mime_type: "image/jpeg", data: "Q1VTVE9NRVI=" } }]);
    expect(dependencies.loadProductImage).not.toHaveBeenCalled();
    expect(repository.runs[0]?.diagnostics).toMatchObject({ photo: { hits: [] } });
  });

  it("still answers when the photo can't be embedded", async () => {
    const repository = new FakeRepository();
    repository.photo = [{ id: redKurta.id, similarity: 0.95, imagePath: kurtaPhoto }];
    const embed = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 503 }));
    const agentFetch = vi.fn<typeof fetch>(async () => gemini({ messages: ["Kaunsa rang chahiye?"] }));
    const response = await processInboundMessage(photoMessage(), photoDeps(repository, embed, { agent: agentDeps(agentFetch) }));
    expect(texts(response.actions)).toEqual(["Kaunsa rang chahiye?"]);
    expect(repository.photoQueries).toEqual([]);
    expect(repository.runs[0]?.diagnostics).toMatchObject({ photo: { hits: [], error: "http_503" } });
  });

  it("without the AI, offers a near-identical match as a question", async () => {
    const repository = new FakeRepository();
    repository.photo = [
      { id: redKurta.id, similarity: 0.96, imagePath: kurtaPhoto },
      { id: greenKurta.id, similarity: 0.81, imagePath: null },
    ];
    const response = await processInboundMessage(photoMessage(), photoDeps(repository, vi.fn<typeof fetch>(async () => embedding())));
    expect(texts(response.actions)[0]).toBe("Kya ye wala hai? 👇");
    const cards = response.actions.filter((action) => action.type === "image");
    expect(cards).toHaveLength(1);
    expect(cards[0]?.type === "image" ? cards[0].caption : "").toContain("*Ruby Kurta*");
  });

  it("without the AI, a merely similar photo gets the usual photo reply", async () => {
    const repository = new FakeRepository();
    repository.photo = [{ id: redKurta.id, similarity: 0.74, imagePath: kurtaPhoto }];
    const response = await processInboundMessage(photoMessage(), photoDeps(repository, vi.fn<typeof fetch>(async () => embedding())));
    expect(texts(response.actions)[0]).toMatch(/^Photo ka shukriya!/);
  });

  it("doesn't embed photos while the catalog has none to match", async () => {
    const repository = new FakeRepository([blueShirt, greenKurta]);
    const embed = vi.fn<typeof fetch>(async () => embedding());
    await processInboundMessage(photoMessage(), photoDeps(repository, embed));
    expect(embed).not.toHaveBeenCalled();
    expect(repository.runs[0]?.diagnostics).not.toHaveProperty("photo");
  });
});

describe("late replies", () => {
  // Re-delivered after the gateway was down: written two hours before this turn runs.
  const lateMessage = (text: string) => message(text, { occurredAt: "2026-09-28T14:00:00.000Z" });

  it("asks the model to open with an apology for the wait", async () => {
    const repository = new FakeRepository();
    const bodies: string[] = [];
    const agentFetch = vi.fn<typeof fetch>(async (_url, init) => {
      bodies.push(String(init?.body));
      return gemini({ messages: ["Maazrat, der se jawab de raha hoon! Ji bataen?"] });
    });
    await processInboundMessage(lateMessage("red kurta hai?"), deps(repository, { agent: agentDeps(agentFetch) }));
    expect(JSON.parse(bodies[0]!).contents[0].parts[0].text).toContain(
      "SYSTEM NOTE: They sent this about 2 hours ago and are only now getting an answer (the assistant was offline): start your first message with a short apology for the late reply, in their language.",
    );
    expect(repository.runs[0]?.diagnostics).toMatchObject({ lateMinutes: 120 });
  });

  it("apologises once per backlog, and not for a fresh message", async () => {
    const repository = new FakeRepository();
    // The bot already answered (and apologised to) an earlier message of the same backlog.
    repository.history = [{ id: "h1", direction: "outbound", source: "agent", contentType: "text", text: "Sorry for the late reply!", mediaPath: null, occurredAt: "2026-09-28T15:59:00Z" }];
    const bodies: string[] = [];
    const agentFetch = vi.fn<typeof fetch>(async (_url, init) => {
      bodies.push(String(init?.body));
      return gemini({ messages: ["Ji bataen?"] });
    });
    await processInboundMessage(lateMessage("aur?"), deps(repository, { agent: agentDeps(agentFetch) }));
    await processInboundMessage(message("aur?"), deps(new FakeRepository(), { agent: agentDeps(agentFetch) }));
    expect(bodies).toHaveLength(2);
    expect(bodies.every((body) => !body.includes("apology for the late reply"))).toBe(true);
  });

  it("has the rules apologise too when the AI is down", async () => {
    const response = await processInboundMessage(lateMessage("Salam"), deps(new FakeRepository()));
    expect(texts(response.actions)[0]).toMatch(/^Maazrat, jawab mein der ho gayi\. Walaikum assalam!/);
  });
});

describe("repeated product cards (from a real chat)", () => {
  // The customer saw the Emerald kurta (no photo, so a text card) in the last reply and said they don't want it.
  const sawEmerald: StoredMessage[] = [
    { id: "h1", direction: "inbound", source: "customer", contentType: "text", text: "dark colour kurta", mediaPath: null, occurredAt: "2026-09-28T15:58:00Z" },
    { id: "h2", direction: "outbound", source: "agent", contentType: "text", text: "Ye dekhein 👇", mediaPath: null, occurredAt: "2026-09-28T15:58:10Z" },
    { id: "h3", direction: "outbound", source: "agent", contentType: "text", text: "*Emerald Lawn Kurta*\nQeemat: Rs 4,500\nSizes: S", mediaPath: null, occurredAt: "2026-09-28T15:58:11Z" },
  ];

  it("tells the model the card was just sent and drops it when the model sends it again unasked", async () => {
    const repository = new FakeRepository();
    repository.history = sawEmerald;
    const bodies: string[] = [];
    const agentFetch = vi.fn<typeof fetch>(async (_url, init) => {
      bodies.push(String(init?.body));
      return gemini({ messages: ["Koi baat nahi! Ye green wala hi hai abhi 👇", "Kaunsa colour chahiye?"], show_products: ["P1"] });
    });
    const response = await processInboundMessage(message("nai chaiye ye wala"), deps(repository, { agent: agentDeps(agentFetch) }));
    expect(JSON.parse(bodies[0]!).contents[0].parts[0].text).toContain("Emerald Lawn Kurta — kurta, green, lawn — Rs 4,500 — in stock: M [no photo] — card just sent");
    expect(texts(response.actions)).toEqual(["Koi baat nahi! Ye green wala hi hai abhi", "Kaunsa colour chahiye?"]);
  });

  it("sends it again when the customer asks for the price", async () => {
    const repository = new FakeRepository();
    repository.history = sawEmerald;
    const agentFetch = vi.fn<typeof fetch>(async () => gemini({ messages: ["Ye rahi details 👇"], show_products: ["P1"] }));
    const response = await processInboundMessage(message("iski price dobara batao"), deps(repository, { agent: agentDeps(agentFetch) }));
    expect(texts(response.actions)[1]).toContain("*Emerald Lawn Kurta*");
  });
});

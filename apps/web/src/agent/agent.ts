import type { Language } from "@huzaifa/contracts";
import { z } from "zod";
import { GeminiError, generateGeminiJson, type GeminiAttempt, type GeminiPart, type GeminiTurn } from "../ai/gemini";
import { browseCatalog, searchCatalog, type CatalogItem } from "../catalog/search";
import { applyOrderUpdate, claimsOrderPlaced, formatPhone, isAffirmative, type DeliveryPricing, type OrderCheck, type OrderDraft, type OrderUpdate } from "../orders/cart";
import { amountsIn, composeReply, refFor, type ComposeResult, type ProductRefs } from "./compose";
import { agentResponseSchema, buildSystemInstruction, describeFilters, productLine } from "./prompt";
import type { ShopSettings } from "../shop/settings";

export type InboundImage = { base64: string; mimeType: string };

const ToolCallSchema = z.object({
  name: z.enum(["search_products", "get_product", "browse_catalog"]),
  category: z.string().catch(""),
  color: z.string().catch(""),
  size: z.string().catch(""),
  max_price: z.number().catch(0),
  text: z.string().catch(""),
  product_id: z.string().catch(""),
});
type ToolCall = z.infer<typeof ToolCallSchema>;

const AgentOutputSchema = z.object({
  language: z.enum(["en", "ur", "roman_ur"]).catch("en"),
  tool_calls: z.array(z.unknown()).catch([]),
  messages: z.array(z.string()).catch([]),
  show_products: z.array(z.string()).catch([]),
  handoff: z.object({ requested: z.boolean().catch(false), reason: z.string().catch("") }).catch({ requested: false, reason: "" }),
  customer: z.object({ name: z.string().catch(""), city: z.string().catch("") }).catch({ name: "", city: "" }),
  order: z
    .object({
      action: z.enum(["none", "update", "place", "discard"]).catch("none"),
      items: z.array(z.object({ product: z.string().catch(""), size: z.string().catch(""), quantity: z.number().catch(1) })).catch([]),
      name: z.string().catch(""),
      phone: z.string().catch(""),
      address: z.string().catch(""),
      city: z.string().catch(""),
      note: z.string().catch(""),
    })
    .catch({ action: "none", items: [], name: "", phone: "", address: "", city: "", note: "" }),
});

export type AgentInput = {
  apiKey: string | readonly string[];
  // Writer models, preferred first; later ones are fallbacks when earlier ones are slow or overloaded.
  models: readonly string[];
  shop: ShopSettings;
  contextText: string;
  image?: InboundImage | null;
  // Shop photos of the products that look like the customer's photo, labelled with their refs so the model can
  // compare them by eye.
  referencePhotos?: readonly { ref: string; image: InboundImage }[];
  catalog: readonly CatalogItem[];
  // Shared with the context builder so the refs the model saw ("P1") resolve to the same products.
  refs: ProductRefs;
  products: Map<string, CatalogItem>;
  chatId: string;
  publicUrl: (storagePath: string) => string;
  budgetMs?: number;
  // Set when the bot may take orders: the chat's open order, how delivery is charged, and the customer's message
  // (an order is only placed on a clear yes).
  orders?: { current: OrderDraft | null; pricing: DeliveryPricing; customerMessage: string };
  // Meaning-based search for the search_products tool when keywords find nothing.
  semanticSearch?: (text: string) => Promise<CatalogItem[]>;
  // Products whose card went out in the last replies, and what the customer just wrote: a card is only sent
  // again when they ask for it (compose.ts).
  recentCards?: ReadonlySet<string>;
  customerText?: string;
  onAttempt?: (attempt: GeminiAttempt) => void;
  fetchImpl?: typeof fetch;
};

export type AgentResult = {
  compose: ComposeResult;
  language: Language;
  handoff: { requested: boolean; reason: string };
  customer: { name?: string; city?: string };
  // The checked order change to save (null when the bot can't take orders).
  order: OrderCheck | null;
  model: string;
  calls: number;
  toolCalls: string[];
  // Rule breaks still present after the rewrite (then stripped by the sanitizer).
  issues: string[];
  inputTokens: number;
  outputTokens: number;
};

const MAX_TOOL_ROUNDS = 2;
const MAX_CALLS = 4;

// Every draft broke the fact rules and nothing safe was left after dropping the bad sentences. Carries what
// the model decided about the customer anyway (a handoff for a complaint or bulk order must still reach the owner).
export class AgentRejectedError extends Error {
  constructor(
    readonly issues: string[],
    readonly handoff: { requested: boolean; reason: string } = { requested: false, reason: "" },
    readonly customer: { name?: string; city?: string } = {},
  ) {
    super(`Every draft broke the fact rules: ${issues.join("; ")}`);
    this.name = "AgentRejectedError";
  }
}

async function runTool(call: ToolCall, input: AgentInput): Promise<string> {
  if (call.name === "get_product") {
    const product = input.refs.byRef.get(call.product_id.trim().toUpperCase());
    if (!product) return `get_product(${call.product_id}): no such product ref.`;
    const sizes = product.variants.map((variant) => `${variant.size}: ${variant.stockQty > 0 ? "available" : "sold out"}`).join(", ") || "no sizes listed";
    return `get_product(${call.product_id}):\n${productLine(call.product_id.toUpperCase(), product)}\nDescription: ${product.description || "-"}\nFabric: ${product.material || "-"}\nTags: ${[...product.styleTags, ...product.aliases].join(", ") || "-"}\nSizes: ${sizes}`;
  }
  if (call.name === "browse_catalog") {
    const overview = browseCatalog(input.catalog, call.category || undefined, 6);
    const list = call.category ? overview.inCategory : overview.newest;
    const lines = list.map((product) => productLine(refFor(input.refs, product), product));
    return `browse_catalog(${call.category || "all"}): ${overview.totalProducts} items in stock; categories: ${overview.categories.map((entry) => `${entry.name} (${entry.count})`).join(", ") || "none"}\n${lines.join("\n") || "No items."}`;
  }
  const result = searchCatalog(
    input.catalog,
    { category: call.category || undefined, color: call.color || undefined, size: call.size || undefined, maxPrice: call.max_price || undefined, text: call.text || undefined },
    5,
  );
  const matches = result.matches.map((hit) => productLine(refFor(input.refs, hit.product), hit.product, hit));
  const alternatives = result.alternatives.map((hit) => productLine(refFor(input.refs, hit.product), hit.product, hit));
  // Words the vocabulary doesn't know ("frock", "pishwas"): look for items with that meaning.
  let similar: string[] = [];
  if (!result.matches.length && call.text.trim() && input.semanticSearch) {
    const seen = new Set(result.alternatives.map((hit) => hit.product.id));
    const found = await input.semanticSearch(call.text).catch(() => []);
    similar = found.filter((product) => !seen.has(product.id)).slice(0, 3).map((product) => productLine(refFor(input.refs, product), product));
  }
  return `search_products(${describeFilters(result)}):\nMatches:\n${matches.join("\n") || "none"}${alternatives.length ? `\nClosest alternatives:\n${alternatives.join("\n")}` : ""}${
    similar.length ? `\nSimilar in meaning (guesses — check they fit):\n${similar.join("\n")}` : ""
  }`;
}

// Order problems the model must fix in a rewrite: a change the catalog can't honour, or a claim that the
// order went through when it didn't.
function checkOrder(input: AgentInput, update: OrderUpdate, messages: readonly string[]): { check: OrderCheck | null; problems: string[] } {
  if (!input.orders) {
    const problems = claimsOrderPlaced(messages) ? ["you can't place orders here; don't say an order is placed or booked"] : [];
    return { check: null, problems };
  }
  let check = applyOrderUpdate({ current: input.orders.current, update, refs: input.refs, products: input.products, pricing: input.orders.pricing });
  const problems = [...check.problems];
  // The model decides when to place, but only a clear yes from the customer counts ("delivery kab tak?" isn't one).
  if (check.place && !isAffirmative(input.orders.customerMessage)) {
    problems.push('the customer\'s message isn\'t a clear yes to the summary: set order.action = "update", answer what they said and ask them to confirm');
    check = { ...check, place: false };
  }
  if (claimsOrderPlaced(messages) && !check.place) problems.push("your message says the order is placed or confirmed, but it isn't; don't claim that");
  return { check, problems };
}

export async function runAgent(input: AgentInput): Promise<AgentResult> {
  const deadline = Date.now() + (input.budgetMs ?? 30_000);
  const [model, ...fallbackModels] = input.models;
  if (!model) throw new GeminiError("No Gemini model configured", "http", 404);
  const systemInstruction = buildSystemInstruction(input.shop, { ordersEnabled: Boolean(input.orders) });
  const { shop } = input;
  // Money the shop published (delivery charge, free-delivery threshold, advance…) may be quoted in policy
  // sentences; numbers from its address or "about" text only as what they are (a plot number, a year).
  const policyAmounts = amountsIn([shop.delivery, shop.payment, shop.returns, shop.otherFaq, String(shop.deliveryFeePkr ?? ""), String(shop.freeDeliveryFromPkr ?? "")].join(" "));
  const shopPlaceText = [shop.about, shop.address].join(" ");
  const firstParts: GeminiPart[] = [{ text: input.contextText }];
  const photo = (image: InboundImage): GeminiPart => ({ inline_data: { mime_type: image.mimeType, data: image.base64 } });
  if (input.image) {
    const references = input.referencePhotos ?? [];
    // Labelled, so the customer's photo can't be mistaken for one of the shop's.
    if (references.length) firstParts.push({ text: "Customer's photo:" });
    firstParts.push(photo(input.image));
    for (const reference of references) firstParts.push({ text: `Shop photo of [${reference.ref}]:` }, photo(reference.image));
  }
  const contents: GeminiTurn[] = [{ role: "user", parts: firstParts }];

  let calls = 0;
  let toolRounds = 0;
  let repaired = false;
  let usedModel = model;
  let inputTokens = 0;
  let outputTokens = 0;
  const toolLog: string[] = [];

  while (calls < MAX_CALLS) {
    const remaining = deadline - Date.now();
    if (remaining < 2_500) break;
    const result = await generateGeminiJson({
      apiKey: input.apiKey,
      model,
      fallbackModels,
      systemInstruction,
      contents,
      responseJsonSchema: agentResponseSchema,
      // Room for long Urdu replies: a cut-off JSON reply is a wasted call.
      maxOutputTokens: 1_400,
      temperature: 0.5,
      thinkingLevel: "low",
      timeoutMs: Math.min(15_000, remaining),
      budgetMs: remaining,
      // The stronger models get ~6.5s; then the last (lite) model answers, so a Gemini overload costs seconds, not tens.
      lastResortAfterMs: 6_500,
      onAttempt: input.onAttempt,
      fetchImpl: input.fetchImpl,
    });
    calls += 1;
    usedModel = result.model;
    inputTokens += result.inputTokens ?? 0;
    outputTokens += result.outputTokens ?? 0;
    const output = AgentOutputSchema.parse(result.json);
    contents.push({ role: "model", parts: [{ text: JSON.stringify(result.json) }] });

    const toolCalls = output.tool_calls.map((call) => ToolCallSchema.safeParse(call)).filter((parsed) => parsed.success).map((parsed) => parsed.data);
    const hasReply = output.messages.some((message) => message.trim()) || output.show_products.length > 0;
    // A reply plus tool calls means the model already answered: take the answer, skip the extra round trip.
    if (toolCalls.length && !hasReply && toolRounds < MAX_TOOL_ROUNDS && deadline - Date.now() > 6_000) {
      toolRounds += 1;
      const results = await Promise.all(
        toolCalls.slice(0, 3).map((call) => {
          toolLog.push(call.name);
          return runTool(call, input);
        }),
      );
      const last = toolRounds >= MAX_TOOL_ROUNDS;
      contents.push({
        role: "user",
        parts: [{ text: `TOOL RESULTS\n${results.join("\n\n")}\n\n${last ? "No more tools are available. Write your reply to the customer now." : "Now write your reply to the customer, or call a tool again only if you truly need to."}` }],
      });
      continue;
    }

    if (!hasReply) {
      contents.push({ role: "user", parts: [{ text: "Tools are no longer available. Write your reply to the customer now (messages must not be empty)." }] });
      continue;
    }

    const draft = { language: output.language, messages: output.messages, showProducts: output.show_products };
    const order = checkOrder(input, output.order, output.messages);
    // The customer's own address and phone digits may only be read back (never as a price or charge).
    const details = order.check?.next?.details;
    const phone = details?.phone ? `${details.phone} ${formatPhone(details.phone)}` : "";
    const composeInput = {
      draft,
      chatId: input.chatId,
      refs: input.refs,
      products: input.products,
      publicUrl: input.publicUrl,
      allowedAmounts: policyAmounts,
      readBackNumbers: amountsIn(`${shopPlaceText} ${details?.address ?? ""} ${phone}`),
      exampleChats: shop.exampleChats || undefined,
      recentCards: input.recentCards,
      customerText: input.customerText,
    };
    const composed = composeReply(composeInput);
    const customer = { name: output.customer.name.trim() || undefined, city: output.customer.city.trim() || undefined };
    const finish = (compose: ComposeResult, issues: string[]): AgentResult => ({
      compose,
      language: output.language,
      handoff: output.handoff,
      customer,
      order: order.check,
      model: usedModel,
      calls,
      toolCalls: toolLog,
      issues,
      inputTokens,
      outputTokens,
    });
    const issues = [...composed.issues, ...order.problems.map((problem) => `order: ${problem}`)];
    if (issues.length === 0) return finish(composed, []);
    // A rewrite needs a call left; otherwise sanitize now rather than lose a usable reply.
    if (!repaired && calls < MAX_CALLS && deadline - Date.now() > 5_000) {
      repaired = true;
      contents.push({
        role: "user",
        parts: [
          {
            text: `Your reply was rejected: ${issues.join("; ")}. Rewrite it following the FACTS${input.orders ? " and ORDERS" : ""} rules (tags for products and sizes, no typed prices or quantities, refs only from the data).`,
          },
        ],
      });
      continue;
    }
    // An order change that still doesn't hold can't be sanitized: the rules fallback hands the chat to the team.
    if (order.problems.length) throw new AgentRejectedError(issues, output.handoff, customer);
    // Out of rewrites: keep what's safe and drop invented facts.
    const sanitized = composeReply(composeInput, { sanitize: true });
    if (sanitized.actions.length === 0) throw new AgentRejectedError(issues, output.handoff, customer);
    return finish(sanitized, issues);
  }
  throw new GeminiError("Agent could not produce a reply in time", "timeout");
}

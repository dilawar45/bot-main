import { randomUUID } from "node:crypto";
import type { BrainResponse, InboundMessage, Language, OutboundAction } from "@huzaifa/contracts";
import { embedImage, embedText, GeminiError } from "../ai/gemini";
import { OrderError, type AgentRunRecord, type BrainRepository } from "../catalog/repository";
import { browseCatalog, extractFilters, hasProductIntent, searchCatalog, type CatalogItem } from "../catalog/search";
import {
  confidentHit,
  confidentPhotoHit,
  MIN_PHOTO_SIMILARITY,
  MIN_SEMANTIC_SIMILARITY,
  photoCandidates,
  semanticQueryFor,
  type PhotoHit,
  type SemanticHit,
} from "../catalog/semantic";
import {
  deliveryFeeFor,
  isAffirmative,
  itemsTotal,
  missingForOrder,
  NO_ORDERS,
  orderContext,
  orderFingerprint,
  renderOrderAlert,
  renderOrderFailed,
  renderOrderPlaced,
  renderOrderSummary,
  type DeliveryPricing,
  type OrderCheck,
} from "../orders/cart";
import { DEFAULT_SHOP_SETTINGS, shopStatus, type ShopSettings, type ShopStatus } from "../shop/settings";
import { AgentRejectedError, runAgent, type AgentResult, type InboundImage } from "./agent";
import { composeReply, createProductRefs, refFor, type ComposeResult } from "./compose";
import { clearLanguage, detectLanguage, fallbackDraft } from "./fallback";
import { formatHistory, historyFromMessages, recentCardProductIds, shownProductIds } from "./memory";
import { AGENT_PROMPT_VERSION, buildTurnContext, describeFilters, productLine } from "./prompt";
import { shouldRefreshSummary, summarizeConversation } from "./summary";

export { AGENT_PROMPT_VERSION };

// Explicit requests for a person, caught without AI so a Gemini outage can't hide them. Phrases, not
// single words: "what do you call this colour?" or "pick up in person" must not page the owner.
// Urdu script has no \b; "کالا" (black) must not match "کال" (call).
const HANDOFF_PHRASES = [
  /\b(?:human|real person|insaan|insan)\b/i,
  /\b(?:talk|speak|chat)\s+(?:to|with)\s+(?:a\s+|an\s+|the\s+)?(?:person|someone|some one|owner|manager|staff|agent|representative|team|shopkeeper)\b/i,
  /\b(?:call|ring)\s+me\b|\bgive\s+me\s+a\s+call\b|\bcan\s+(?:you|someone|somebody)\s+call\b|\b(?:want|need)\s+(?:a\s+)?(?:call|phone call)\b/i,
  /\b(?:banday|bande|banda|kisi|owner|malik|manager|staff|shopkeeper)\s+(?:se|say|sy)\s+baat\b/i,
  /\bcall\s+(?:karo|kro|karein|karen|kar\s*do|kr\s*do|kardo|krdo|kijiye|pe|par|mein|me)\b|\bphone\s+(?:karo|kro|karein|karen|kar\s*do|kijiye)\b/i,
  /\bbaat\s+(?:karni|krni|karna|krna|karwa|krwa|karwao|krwao)\s+(?:hai|ha|he|hy|thi)\b/i,
  /(?:انسان|مالک|کسی)\s*سے\s*بات|(?<!\p{L})(?:کال|فون)\s*(?:کریں|کرو|کر\s*دیں|کیجیے)|بات\s*کرنی\s*ہے/u,
];

// "Are you a real person or a bot?" asks what the bot is; it isn't a request for a person.
const ASKS_WHAT_BOT_IS =
  /\b(?:are|r)\s+(?:you|u)\s+(?:a\s+|an\s+)?(?:real\s+)?(?:human|person|insaan|insan|bot|robot|machine)\b(?:\s+or\s+(?:a\s+|an\s+)?(?:real\s+)?(?:bot|robot|human|person|machine))?|\bis\s+(?:this|it)\s+(?:a\s+)?(?:real\s+)?(?:human|person|bot|robot)\b(?:\s+or\s+(?:a\s+)?(?:bot|robot|human|person))?|\b(?:aap|ap|tum)\s+(?:insaan|insan|bot|robot|human)\s+(?:ho|hain|hai|hy)\b/gi;

export function wantsPerson(text: string): boolean {
  const request = text.replace(ASKS_WHAT_BOT_IS, " ");
  return HANDOFF_PHRASES.some((pattern) => pattern.test(request));
}

// Wanting to buy, for when the AI is down and the rules can't take the order: the team takes it instead.
const ORDER_INTENT = /\b(?:order|buy|purchase|checkout)\b|\b(?:le\s+lunga|le\s+lungi|le\s+lenge|lena\s+hai|leni\s+hai|khareed\w*|mangwa\w*|mangana)\b|آرڈر|خرید|منگوا/iu;

export function wantsToOrder(text: string): boolean {
  return ORDER_INTENT.test(text);
}

// More than this many messages from one chat within 60s skips automation (spam or a stuck client).
export const MAX_MESSAGES_PER_MINUTE = 8;
const HISTORY_LIMIT = 16;
// The whole turn must answer well inside the gateway's 45 s wait, cold starts and slow DB included.
const TURN_DEADLINE_MS = 38_000;
// An alert that failed or went unanswered this long is sent again when the customer asks again.
const REALERT_AFTER_MS = 3 * 60 * 60 * 1_000;
// The gateway re-delivers messages it missed while it was down, with their original time; older than this, the
// reply apologises for the wait.
const LATE_REPLY_AFTER_MS = 10 * 60_000;
// Photo search may delay the reply this long at most (embedding the customer's photo, then matching it).
const PHOTO_SEARCH_MS = 6_000;
// Shop photos attached next to the customer's photo for the model to compare (each costs a few hundred tokens).
const REFERENCE_PHOTOS = 2;

export type OrchestratorDependencies = {
  repository: BrainRepository;
  supportChatId: string;
  shop?: ShopSettings;
  // Public URL of a product photo (product-images bucket); cards fall back to text without it.
  publicUrl?: (storagePath: string) => string;
  // Omit to run on rules only (no Gemini key configured).
  agent?: {
    apiKey: string | readonly string[];
    // Reply writers, preferred first.
    models: readonly string[];
    // Cheaper models for background summaries.
    summaryModels?: readonly string[];
    budgetMs?: number;
    fetchImpl?: typeof fetch;
  };
  // Meaning-based product search (Gemini embeddings + match_products). Omit to use keywords only.
  embeddings?: { apiKey: string | readonly string[]; model: string; fetchImpl?: typeof fetch };
  // Photo search (multimodal Gemini embeddings + match_product_images): finds the products a customer's photo looks
  // like. Omit to leave photos to the reply model alone.
  photoSearch?: { apiKey: string | readonly string[]; model: string; fetchImpl?: typeof fetch };
  // A shop photo (product-images path) for the reply model to compare with the customer's; null to skip it.
  loadProductImage?: (storagePath: string) => Promise<InboundImage | null>;
  // Where the admin lives (e.g. https://shop.example.com), for links in the owner's order alerts.
  adminBaseUrl?: string;
  loadImage?: (objectPath: string) => Promise<InboundImage | null>;
  now?: () => Date;
  // Work to run after the reply is returned (Next's after()); defaults to fire-and-forget.
  defer?: (task: () => Promise<void>) => void;
};

export function renderSupportAlert(input: {
  chatId: string;
  phoneNumber?: string;
  displayName?: string;
  customerName?: string;
  reason?: string;
  product: CatalogItem | null;
  lastMessage: string;
}): string {
  const digits = input.phoneNumber ?? (input.chatId.endsWith("@c.us") ? input.chatId.slice(0, -5) : null);
  const lines = [
    "Customer wants to talk to a person",
    `Name: ${input.customerName ?? input.displayName ?? "unknown"}`,
    digits ? `WhatsApp: +${digits} (https://wa.me/${digits})` : "WhatsApp: number hidden by WhatsApp (reply from the bot phone's chat list)",
  ];
  if (input.reason) lines.push(`Reason: ${input.reason.slice(0, 160)}`);
  if (input.product) lines.push(`Interested in: ${input.product.name} (${input.product.sku})`);
  if (input.lastMessage) lines.push(`Message: "${input.lastMessage.slice(0, 200)}"`);
  lines.push("The bot keeps helping until you reply in that chat; once you reply it steps back. Resume it from the admin when done.");
  return lines.join("\n");
}

function textAction(recipientChatId: string, text: string): OutboundAction {
  return { actionId: randomUUID(), recipientChatId, type: "text", text };
}

function describeError(error: unknown): string {
  if (error instanceof GeminiError) return `agent_${error.kind}${error.status ? `_${error.status}` : ""}`;
  if (error instanceof AgentRejectedError) return "agent_fact_check";
  return "agent_failed";
}

// The task's result, or a timeout error once `ms` have passed (the task is then left to finish unobserved).
function withTimeout<T>(ms: number, task: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new GeminiError(`Timed out after ${ms}ms`, "timeout")), ms);
  });
  return Promise.race([task(), timeout]).finally(() => clearTimeout(timer));
}

// "35 minutes", "about 5 hours", "about 2 days": how long a re-delivered message waited.
function describeWait(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 90) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return hours < 36 ? `about ${hours} hours` : `about ${Math.round(hours / 24)} days`;
}

type PhotoLookup = {
  // Every product found (best photo each), for the rules fallback's "is it this one?".
  hits: PhotoHit[];
  // The ones the model is asked to compare.
  candidates: PhotoHit[];
  // Shop photos of the best candidates that loaded in time.
  references: { productId: string; image: InboundImage }[];
  ms: number;
  error?: string;
};

// The owner (or the support phone) writing to the bot is not a customer conversation.
function isSupportChat(message: InboundMessage, supportChatId: string): boolean {
  if (message.chatId === supportChatId) return true;
  return Boolean(message.phoneNumber && `${message.phoneNumber}@c.us` === supportChatId);
}

// The gateway accepts at most 8 actions a turn (packages/contracts BrainResponseSchema), and more would flood
// the chat. Alerts and the order's own messages always stay; the model's extra cards, then texts, go first.
const MAX_ACTIONS = 8;
function capActions(actions: OutboundAction[], chatId: string, keep: ReadonlySet<string>): OutboundAction[] {
  const result = [...actions];
  const lastDroppable = (type: OutboundAction["type"]) => result.findLastIndex((action) => action.recipientChatId === chatId && action.type === type && !keep.has(action.actionId));
  while (result.length > MAX_ACTIONS) {
    const index = lastDroppable("image") === -1 ? lastDroppable("text") : lastDroppable("image");
    if (index === -1) break;
    result.splice(index, 1);
  }
  return result;
}

// Code-rendered order messages (summary, confirmation) go right after the model's message that points at
// them ("ye raha summary 👇"), otherwise at the end of the customer's messages.
function insertOrderMessages(actions: OutboundAction[], chatId: string, inserts: OutboundAction[]): OutboundAction[] {
  if (!inserts.length) return actions;
  let index = -1;
  actions.forEach((action, position) => {
    if (action.recipientChatId === chatId && action.type === "text" && action.text.includes("👇")) index = position;
  });
  if (index === -1) return [...actions, ...inserts];
  return [...actions.slice(0, index + 1), ...inserts, ...actions.slice(index + 1)];
}

type OrderTurn = {
  // Code-rendered messages for the customer (summary, confirmation or an apology).
  texts: string[];
  // The model's reply must not go out (it may claim an order that didn't happen).
  replaceReply: boolean;
  alert: string | null;
  handoffReason: string | null;
  outcome: "order_placed" | "order_updated" | null;
  errorCode: string | null;
};

// Saves what the model decided about the order and says what the customer and the owner get to see.
async function saveOrderTurn(input: {
  check: OrderCheck;
  repository: BrainRepository;
  conversationId: string;
  chatId: string;
  products: Map<string, CatalogItem>;
  pricing: DeliveryPricing;
  language: Language;
  status: ShopStatus;
  whatsappPhone: string | null;
  adminBaseUrl?: string;
}): Promise<OrderTurn> {
  const { check, repository, products, pricing, language } = input;
  const turn: OrderTurn = { texts: [], replaceReply: false, alert: null, handoffReason: null, outcome: null, errorCode: null };
  const next = check.next;

  if (next === null) {
    if (check.changed) await repository.discardOrderDraft(input.conversationId);
    return turn;
  }

  const fingerprint = orderFingerprint(next, products, pricing);
  const deliveryFeePkr = deliveryFeeFor(itemsTotal(next.lines, products), pricing);

  if (check.place && next.id) {
    try {
      const number = await repository.placeOrder(next.id, fingerprint);
      turn.texts.push(renderOrderPlaced(number, language, input.status.open));
      turn.alert = renderOrderAlert({
        number,
        draft: next,
        products,
        pricing,
        chatId: input.chatId,
        whatsappPhone: input.whatsappPhone,
        adminUrl: input.adminBaseUrl ? `${input.adminBaseUrl.replace(/\/$/, "")}/admin/orders/${next.id}` : null,
      });
      turn.outcome = "order_placed";
    } catch (error) {
      const code = error instanceof OrderError ? error.code : "unknown";
      turn.errorCode = `order_${code}`;
      turn.replaceReply = true;
      if (code === "summary_outdated" || code === "details_missing") {
        // Something changed since the summary: show the current one and ask again.
        await repository.saveOrderDraft(input.conversationId, next, { deliveryFeePkr, summaryFingerprint: fingerprint }).catch(() => null);
        turn.texts.push(renderOrderFailed("outdated", language), renderOrderSummary(next, products, language, pricing));
      } else if (code === "out_of_stock") {
        turn.texts.push(renderOrderFailed("out_of_stock", language));
      } else {
        turn.texts.push(renderOrderFailed("error", language));
        turn.handoffReason = `Order couldn't be placed automatically (${code}); please confirm it with the customer`;
      }
    }
    return turn;
  }

  const complete = missingForOrder(next).length === 0;
  const showSummary = complete && next.summaryFingerprint !== fingerprint;
  if (!check.changed && !showSummary) return turn;
  await repository.saveOrderDraft(input.conversationId, next, { deliveryFeePkr, summaryFingerprint: complete ? fingerprint : null });
  if (showSummary) turn.texts.push(renderOrderSummary(next, products, language, pricing));
  turn.outcome = "order_updated";
  return turn;
}

export async function processInboundMessage(message: InboundMessage, deps: OrchestratorDependencies): Promise<BrainResponse> {
  const startedAt = Date.now();
  const now = deps.now?.() ?? new Date();
  const { repository } = deps;
  const shop = deps.shop ?? DEFAULT_SHOP_SETTINGS;
  const publicUrl = deps.publicUrl ?? (() => "");

  if (isSupportChat(message, deps.supportChatId)) return { eventId: message.eventId, duplicate: false, actions: [] };

  const ingested = await repository.ingestInbound(message);
  if (ingested.duplicate) {
    // Retried after a lost response: resend what this event produced but never got delivered.
    const replay = await repository
      .replayPendingActions(message.eventId, { customerChatId: message.chatId, supportChatId: deps.supportChatId, publicUrl })
      .catch(() => []);
    // If the owner took over since, only the alert to them may still go out, never the bot's reply.
    const actions = ingested.conversation.state === "human_active" ? replay.filter((action) => action.recipientChatId !== message.chatId) : replay;
    return { eventId: message.eventId, duplicate: true, actions };
  }
  // Paused: the owner is chatting with this customer.
  if (ingested.conversation.state === "human_active") return { eventId: message.eventId, duplicate: false, actions: [] };

  const conversation = ingested.conversation;
  const turnStart = new Date(startedAt - 2_000).toISOString();
  const run: AgentRunRecord = {
    conversationId: conversation.id,
    inboundMessageId: ingested.inboundMessageId,
    promptVersion: AGENT_PROMPT_VERSION,
    model: "rules",
    candidateProductIds: [],
    outcome: "unknown",
    latencyMs: 0,
    diagnostics: {},
  };
  const finish = async (actions: OutboundAction[]): Promise<BrainResponse> => {
    try {
      await repository.saveActions(conversation.id, actions, message.chatId);
    } catch (error) {
      // Still reply: losing the delivery record is better than losing the customer's answer.
      console.error("Saving outbound actions failed", { conversationId: conversation.id, error });
    }
    run.diagnostics = { ...run.diagnostics, actionIds: actions.map((action) => action.actionId) };
    // Diagnostics only; a failed insert must never block the customer's reply.
    await repository.recordAgentRun({ ...run, latencyMs: Date.now() - startedAt }).catch(() => undefined);
    return { eventId: message.eventId, duplicate: false, actions };
  };
  // The owner may start typing while this turn is being prepared; then the bot must step back.
  const ownerTookOver = () => repository.ownerRepliedSince(conversation.id, turnStart).catch(() => false);

  if ((ingested.recentInboundCount ?? 0) > MAX_MESSAGES_PER_MINUTE) {
    run.outcome = "throttled";
    return finish([]);
  }

  const text = message.text?.trim() ?? "";
  const [rows, catalog, orderState] = await Promise.all([
    repository.loadRecentMessages(conversation.id, HISTORY_LIMIT),
    repository.loadCatalog(),
    repository.loadOrderState(conversation.id).catch((error: unknown) => {
      console.error("Loading the order failed; taking no orders this turn", { conversationId: conversation.id, error });
      return NO_ORDERS;
    }),
  ]);
  const products = new Map(catalog.map((product) => [product.id, product]));
  const history = historyFromMessages(rows, ingested.inboundMessageId);
  const contact = ingested.contact;
  const status = shopStatus(shop, now);
  // A message that doesn't show its language (a name and address, "ok") is answered in the chat's language.
  const recentCustomerText = history
    .filter((line) => line.role === "customer")
    .slice(-3)
    .map((line) => line.text)
    .join(" ");
  const detectedLanguage: Language = clearLanguage(text) ?? contact?.preferredLanguage ?? clearLanguage(recentCustomerText) ?? detectLanguage(text, "en");
  const wantsHuman = wantsPerson(text);
  const handoffPending = conversation.state === "handoff_requested";
  const hasPhoto = message.type === "image" && Boolean(message.media);
  const ordersOn = orderState.available && shop.ordersEnabled;
  const pricing: DeliveryPricing = { deliveryFeePkr: shop.deliveryFeePkr, freeDeliveryFromPkr: shop.freeDeliveryFromPkr };
  const whatsappPhone = message.phoneNumber ?? contact?.phoneNumber ?? (message.chatId.endsWith("@c.us") ? message.chatId.slice(0, -5) : null);
  // Re-delivered after an outage: say sorry for the wait, once — not when a reply already went out after they wrote
  // this (an earlier message of the same backlog got the apology).
  const sentAt = Date.parse(message.occurredAt);
  const waitedMs = now.getTime() - sentAt;
  const late = waitedMs > LATE_REPLY_AFTER_MS && !rows.some((row) => row.direction === "outbound" && row.source !== "system" && Date.parse(row.occurredAt) > sentAt);
  if (late) run.diagnostics = { ...run.diagnostics, lateMinutes: Math.round(waitedMs / 60_000) };

  // Deterministic retrieval first: most turns need no tool call at all.
  const filters = extractFilters(text);
  const search = hasProductIntent(filters) ? searchCatalog(catalog, filters, 5) : null;
  const overview = browseCatalog(catalog, undefined, 4);

  // Words the keyword vocabulary didn't know get a meaning-based search, in parallel with the photo download.
  const embeddings = deps.embeddings;
  const searchByMeaning = async (query: string): Promise<SemanticHit[]> => {
    if (!embeddings) return [];
    const vector = await embedText({ apiKey: embeddings.apiKey, model: embeddings.model, text: query, taskType: "RETRIEVAL_QUERY", timeoutMs: 4_000, fetchImpl: embeddings.fetchImpl });
    return repository.matchProducts(vector, 4, MIN_SEMANTIC_SIMILARITY);
  };
  const semanticQuery = embeddings ? semanticQueryFor(text, filters, search) : null;
  const semanticStarted = Date.now();
  // The customer's photo: for the model to look at, and for photo search (which also works without the model).
  // A catalog without photos has nothing to match: no embedding call until the shop adds some.
  // Nor while the photo-search migration is known to be missing (the repository rechecks every 10 minutes).
  const photoSearch = hasPhoto && catalog.some((product) => product.imagePaths.length > 0) && (repository.photoSearchReady?.() ?? true) ? deps.photoSearch : undefined;
  const imageLoad = hasPhoto && deps.loadImage && (deps.agent || photoSearch) ? deps.loadImage(message.media!.objectPath).catch(() => null) : Promise.resolve(null);
  // Which products the photo looks like (often it's a screenshot of the shop's own post). Similarity only ranks
  // candidates; the model compares their shop photos with the customer's before calling anything the same item.
  const findByPhoto = async (search: NonNullable<OrchestratorDependencies["photoSearch"]>): Promise<PhotoLookup> => {
    const started = Date.now();
    try {
      const hits = await withTimeout(PHOTO_SEARCH_MS, async () => {
        const loaded = await imageLoad;
        if (!loaded) throw new Error("photo not loaded");
        const vector = await embedImage({ apiKey: search.apiKey, model: search.model, image: loaded, timeoutMs: 5_000, fetchImpl: search.fetchImpl });
        return repository.matchProductImages(vector, 5, MIN_PHOTO_SIMILARITY);
      });
      const known = hits.filter((hit) => products.has(hit.id));
      const candidates = photoCandidates(known);
      const loadProductImage = deps.agent ? deps.loadProductImage : undefined;
      // Slow or big shop photos come back null and are skipped: the model then compares by description.
      const references = loadProductImage
        ? (
            await Promise.all(
              candidates.slice(0, REFERENCE_PHOTOS).map(async (hit) => {
                const path = hit.imagePath ?? products.get(hit.id)?.imagePaths[0];
                const loaded = path ? await loadProductImage(path).catch(() => null) : null;
                return loaded ? { productId: hit.id, image: loaded } : null;
              }),
            )
          ).filter((reference) => reference !== null)
        : [];
      return { hits: known, candidates, references, ms: Date.now() - started };
    } catch (error) {
      const reason = error instanceof GeminiError ? `${error.kind}${error.status ? `_${error.status}` : ""}` : error instanceof Error ? error.message : String(error);
      console.warn("Photo search failed; the model looks at the photo alone", { conversationId: conversation.id, error: reason });
      return { hits: [], candidates: [], references: [], ms: Date.now() - started, error: reason };
    }
  };
  const [semanticHits, image, photo] = await Promise.all([
    semanticQuery
      ? searchByMeaning(semanticQuery).catch((error: unknown) => {
          console.warn("Meaning search failed; keywords only", { conversationId: conversation.id, error: error instanceof Error ? error.message : String(error) });
          return [] as SemanticHit[];
        })
      : Promise.resolve([] as SemanticHit[]),
    imageLoad,
    photoSearch ? findByPhoto(photoSearch) : Promise.resolve(null),
  ]);
  if (semanticQuery) {
    run.diagnostics = {
      ...run.diagnostics,
      semantic: { query: semanticQuery, ms: Date.now() - semanticStarted, hits: semanticHits.map((hit) => `${products.get(hit.id)?.name ?? hit.id} ${hit.similarity.toFixed(2)}`) },
    };
  }
  if (photo) {
    run.diagnostics = {
      ...run.diagnostics,
      photo: {
        ms: photo.ms,
        hits: photo.hits.map((hit) => `${products.get(hit.id)?.name ?? hit.id} ${hit.similarity.toFixed(2)}`),
        ...(photo.references.length ? { compared: photo.references.length } : {}),
        ...(photo.error ? { error: photo.error } : {}),
      },
    };
  }

  const refs = createProductRefs();
  // The product under discussion gets P1, so "M hai is mein?" can't be pinned on a search result; items in
  // the open order come next.
  // Every item in the open order keeps a ref (order.items replaces the whole cart, so an item without one would be lost).
  const orderIds = [...new Set((orderState.draft?.lines ?? []).map((line) => line.productId))].filter((id) => products.has(id));
  // Cards (with or without a photo) the customer got in the last two replies: listed, and marked so the model
  // doesn't send the same card again unasked.
  const recentCards = recentCardProductIds(rows, new Map(catalog.map((product) => [product.name, product.id])));
  const ordered = [
    ...new Set([...(conversation.activeProductId ? [conversation.activeProductId] : []), ...orderIds, ...recentCards, ...shownProductIds(rows).reverse()]),
  ].filter((id) => products.has(id));
  const shownIds = ordered.slice(0, Math.max(6, orderIds.length + 1));
  const shownLines = shownIds.map((id) => `${productLine(refFor(refs, products.get(id)!), products.get(id)!)}${recentCards.has(id) ? " — card just sent" : ""}`);
  // What the customer's photo looks like: this message is about them, so they come right after the shown items.
  const photoItems = (photo?.candidates ?? []).map((hit) => products.get(hit.id)!);
  const photoLines = photoItems.map((product) => productLine(refFor(refs, product), product));
  const referencePhotos = image ? (photo?.references ?? []).map((reference) => ({ ref: refFor(refs, products.get(reference.productId)!), image: reference.image })) : [];
  const matchLines = search?.matches.map((hit) => productLine(refFor(refs, hit.product), hit.product, hit)) ?? [];
  const alternativeLines = search?.alternatives.map((hit) => productLine(refFor(refs, hit.product), hit.product, hit)) ?? [];
  const alreadyListed = new Set([
    ...shownIds,
    ...photoItems.map((product) => product.id),
    ...(search?.matches ?? []).map((hit) => hit.product.id),
    ...(search?.alternatives ?? []).map((hit) => hit.product.id),
  ]);
  const semanticItems = semanticHits
    .map((hit) => products.get(hit.id))
    .filter((product): product is CatalogItem => product !== undefined && !alreadyListed.has(product.id))
    .slice(0, 3);
  const semanticLines = semanticItems.map((product) => productLine(refFor(refs, product), product));
  const overviewLines = overview.newest.map((product) => productLine(refFor(refs, product), product));

  let agentResult: AgentResult | undefined;
  let rejected: AgentRejectedError | undefined;
  if (deps.agent) {
    const notes: string[] = [];
    if (ingested.firstContact) notes.push("This is the customer's very first message: briefly mention you're the shop's automated assistant and that they can ask for a person anytime.");
    if (wantsHuman && !handoffPending) notes.push("The customer is asking for a person or a call. The team is being notified automatically: set handoff.requested=true, acknowledge it naturally, and still answer anything else they asked.");
    if (late) notes.push(`They sent this ${describeWait(waitedMs)} ago and are only now getting an answer (the assistant was offline): start your first message with a short apology for the late reply, in their language.`);
    const stateNote = handoffPending
      ? "The team was already notified that this customer wants a person; nobody has replied yet. Keep helping and reassure them; do not request again."
      : "You are answering this customer.";
    const customerLine = [
      contact?.displayName ? `WhatsApp name "${contact.displayName}"` : null,
      contact?.customerName ? `name they gave: ${contact.customerName}` : null,
      contact?.location ? `city: ${contact.location}` : null,
      contact?.preferredLanguage ? `usually writes: ${contact.preferredLanguage}` : null,
    ]
      .filter(Boolean)
      .join(" | ");
    const contextText = buildTurnContext({
      status,
      stateNote,
      systemNote: notes.join(" ") || undefined,
      customerLine: customerLine || "unknown",
      summary: conversation.summary,
      history: formatHistory(history),
      overview,
      overviewLines,
      shownLines,
      searchLabel: search ? describeFilters(search) : "no product words in the message",
      matchLines,
      alternativeLines,
      semanticLines,
      photoLines,
      photoRefs: referencePhotos.map((reference) => reference.ref),
      orderSection: ordersOn ? orderContext({ state: orderState, refs, products, pricing, whatsappPhone }) : undefined,
      shop,
      message: text,
      replyLanguage: clearLanguage(text),
      hasPhoto: Boolean(image),
    });
    // Budget counted from when the request arrived, leaving room for the database writes after.
    const budgetMs = Math.min(deps.agent.budgetMs ?? 30_000, TURN_DEADLINE_MS - (Date.now() - startedAt) - 3_000);
    // Every model call, e.g. "gemini-flash-latest 429 daily quota 612ms": explains slow or rules-only replies.
    const attempts: string[] = [];
    run.diagnostics = { ...run.diagnostics, attempts };
    try {
      agentResult = await runAgent({
        apiKey: deps.agent.apiKey,
        models: deps.agent.models,
        shop,
        contextText,
        image,
        referencePhotos,
        catalog,
        refs,
        products,
        chatId: message.chatId,
        publicUrl,
        budgetMs,
        orders: ordersOn ? { current: orderState.draft, pricing, customerMessage: text } : undefined,
        semanticSearch: embeddings
          ? async (query) => (await searchByMeaning(query)).map((hit) => products.get(hit.id)).filter((product): product is CatalogItem => product !== undefined)
          : undefined,
        recentCards,
        customerText: text,
        onAttempt: (attempt) => void attempts.push(`${attempt.model} ${attempt.outcome} ${attempt.ms}ms`),
        fetchImpl: deps.agent.fetchImpl,
      });
      run.model = agentResult.model;
      run.inputTokens = agentResult.inputTokens;
      run.outputTokens = agentResult.outputTokens;
      run.diagnostics = {
        ...run.diagnostics,
        calls: agentResult.calls,
        tools: agentResult.toolCalls,
        issues: agentResult.issues,
        search: search ? describeFilters(search) : null,
        attempts,
        ...(agentResult.order && agentResult.order.changed ? { order: agentResult.order.place ? "place" : agentResult.order.next ? "update" : "discard" } : {}),
      };
    } catch (error) {
      run.errorCode = describeError(error);
      if (error instanceof AgentRejectedError) {
        rejected = error;
        run.diagnostics = { ...run.diagnostics, issues: error.issues };
      }
      console.error("Agent failed; using rules", { conversationId: conversation.id, error: error instanceof Error ? error.message : String(error) });
    }
  }

  // Without the model the rules can't take an order: the team takes it. That includes a "confirm" to a complete
  // cart (never answered with small talk), but not a "hi" from a chat with an old, half-filled cart.
  const confirmsCart = Boolean(ordersOn && orderState.draft && missingForOrder(orderState.draft).length === 0 && isAffirmative(text));
  const orderForTeam = !agentResult && (wantsToOrder(text) || confirmsCart);
  let composed: ComposeResult;
  let language: Language;
  if (agentResult) {
    composed = agentResult.compose;
    language = agentResult.language;
    run.outcome = composed.shownProductIds.length ? "reply_products" : "reply";
  } else {
    language = detectedLanguage;
    const focusRef = shownIds.length ? refFor(refs, products.get(shownIds[0]!)!) : undefined;
    const similar = confidentHit(semanticHits);
    const similarProduct = similar ? products.get(similar.id) : undefined;
    const photoMatch = confidentPhotoHit(photo?.hits ?? []);
    const photoProduct = photoMatch ? products.get(photoMatch.id) : undefined;
    const draft = fallbackDraft({
      text,
      language,
      firstContact: Boolean(ingested.firstContact),
      hasPhoto,
      wantsHuman: wantsHuman || orderForTeam,
      handoffAlreadyPending: handoffPending,
      status,
      filters,
      search,
      overview,
      refs,
      focusRef,
      similarRef: similarProduct ? refFor(refs, similarProduct) : undefined,
      photoRef: photoProduct ? refFor(refs, photoProduct) : undefined,
      late,
    });
    composed = composeReply({ draft, chatId: message.chatId, refs, products, publicUrl, recentCards, customerText: text }, { sanitize: true });
    run.outcome = "fallback";
  }

  if (await ownerTookOver()) {
    // Built before the owner started typing: sending it now would talk over them.
    run.outcome = "owner_took_over";
    return finish([]);
  }
  let actions = [...composed.actions];
  // Never dropped when a turn has more messages than the gateway takes: alerts and the order's own messages.
  const mustSend = new Set<string>();

  // Orders: save what the model decided; code renders the summary, the confirmation and the owner's alert.
  let orderHandoffReason: string | null = null;
  const orderAlerts: OutboundAction[] = [];
  if (agentResult?.order && ordersOn) {
    try {
      const turn = await saveOrderTurn({
        check: agentResult.order,
        repository,
        conversationId: conversation.id,
        chatId: message.chatId,
        products,
        pricing,
        language,
        status,
        whatsappPhone,
        adminBaseUrl: deps.adminBaseUrl,
      });
      if (turn.replaceReply) actions = actions.filter((action) => action.recipientChatId !== message.chatId);
      const orderMessages = turn.texts.map((orderText) => textAction(message.chatId, orderText));
      for (const orderMessage of orderMessages) mustSend.add(orderMessage.actionId);
      actions = insertOrderMessages(actions, message.chatId, orderMessages);
      if (turn.alert) orderAlerts.push(textAction(deps.supportChatId, turn.alert));
      if (turn.outcome) run.outcome = turn.outcome;
      if (turn.errorCode) run.errorCode ??= turn.errorCode;
      orderHandoffReason = turn.handoffReason;
    } catch (error) {
      // The reply may talk about the order as if it were saved: the team takes the order over instead.
      console.error("Saving the order failed", { conversationId: conversation.id, error });
      run.errorCode ??= "order_save_failed";
      orderHandoffReason = "Wants to order, but saving the order failed; please take the order over";
    }
  }

  const handoffRequested = wantsHuman || orderForTeam || Boolean(orderHandoffReason) || Boolean(agentResult?.handoff.requested) || Boolean(rejected?.handoff.requested);
  let alertDue = handoffRequested && conversation.state === "bot_active";
  if (handoffRequested && handoffPending) {
    // Already notified; page again only if that alert failed or has gone unanswered for hours
    // (never just because the lookup failed — that would spam the owner).
    const open = await repository.openHandoff(conversation.id).catch(() => null);
    alertDue = Boolean(open && (open.notificationError || Date.now() - new Date(open.requestedAt).getTime() > REALERT_AFTER_MS));
  }
  if (alertDue) {
    // What they're looking at now: this turn's cards, then the product under discussion, then recent ones.
    const interested = [...new Set([...composed.shownProductIds, ...shownIds])].slice(0, 5);
    const reason =
      orderHandoffReason ??
      (agentResult?.handoff.reason.trim() || rejected?.handoff.reason.trim() || (orderForTeam && !wantsHuman ? "Wants to order (the bot couldn't take it: AI unavailable)" : "Customer asked for a person"));
    const alert = textAction(
      deps.supportChatId,
      renderSupportAlert({
        chatId: message.chatId,
        phoneNumber: message.phoneNumber,
        displayName: message.displayName,
        customerName: agentResult?.customer.name ?? rejected?.customer.name ?? contact?.customerName ?? undefined,
        reason,
        product: interested[0] ? (products.get(interested[0]) ?? null) : null,
        lastMessage: text,
      }),
    );
    // The alert and the reply go out even if a database step fails; the owner must hear about it.
    try {
      // Atomic pause + lead, then back to "requested": the bot keeps helping until the owner types.
      await repository.beginHandoff(conversation.id, reason, alert.actionId, interested);
      if (!(await ownerTookOver())) await repository.markHandoffPending(conversation.id);
    } catch (error) {
      console.error("Handoff bookkeeping failed; alert still sent", { conversationId: conversation.id, error });
      run.errorCode ??= "handoff_db_failed";
    }
    actions.push(alert);
    run.outcome = "handoff";
  }
  actions.push(...orderAlerts);

  // Lead capture and memory. Never block the reply on these.
  const orderDetails = agentResult?.order?.next?.details;
  await repository
    .saveCustomerDetails(message.chatId, {
      name: agentResult?.customer.name ?? orderDetails?.name ?? rejected?.customer.name ?? undefined,
      location: agentResult?.customer.city ?? orderDetails?.city ?? rejected?.customer.city ?? undefined,
      language,
    })
    .catch(() => undefined);
  const firstShown = composed.shownProductIds[0];
  if (firstShown && firstShown !== conversation.activeProductId) await repository.rememberProduct(conversation.id, firstShown).catch(() => undefined);
  run.candidateProductIds = composed.shownProductIds;

  if (deps.agent && shouldRefreshSummary(ingested.inboundTotal)) {
    const agent = deps.agent;
    const defer = deps.defer ?? ((task: () => Promise<void>) => void task().catch(() => undefined));
    defer(async () => {
      const recent = await repository.loadRecentMessages(conversation.id, 30);
      const summary = await summarizeConversation({
        apiKey: agent.apiKey,
        models: agent.summaryModels ?? agent.models,
        previousSummary: conversation.summary,
        lines: historyFromMessages(recent),
        fetchImpl: agent.fetchImpl,
      });
      if (summary) await repository.saveSummary(conversation.id, summary);
    });
  }

  return finish(capActions(actions, message.chatId, mustSend));
}

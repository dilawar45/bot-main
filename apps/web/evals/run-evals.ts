// Scores the WhatsApp agent on a fixed set of customer messages, using the real Gemini models.
//
//   pnpm eval                  all cases
//   pnpm eval --only=real-,policy-   cases whose id starts with any of these prefixes
//   pnpm eval --rules          rules only (no Gemini), as a baseline
//   pnpm eval --no-semantic    skip meaning-based search (no embedding calls)
//
// Nothing touches Supabase: an in-memory repository and a fixed catalog stand in for the database.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { InboundMessage, OutboundAction } from "@huzaifa/contracts";
import { embedText, parseGeminiKeys, parseModelList } from "../src/ai/gemini";
import { detectLanguage } from "../src/agent/fallback";
import type { StoredMessage } from "../src/agent/memory";
import { processInboundMessage } from "../src/agent/orchestrator";
import type { AgentRunRecord, BrainRepository, IngestResult, SavedOrderDraft } from "../src/catalog/repository";
import type { CatalogItem } from "../src/catalog/search";
import { cosineSimilarity, DEFAULT_EMBEDDING_MODEL, embeddingSourceHash, productEmbeddingText, type PhotoHit, type SemanticHit } from "../src/catalog/semantic";
import { EMPTY_DETAILS, orderFingerprint, type OrderDraft, type OrderState } from "../src/orders/cart";
import { EVAL_CASES, EVAL_CATALOG, EVAL_SHOP, ROBOTIC, type EvalCase } from "./cases";

const SUPPORT = "923000000000@c.us";
const CUSTOMER = "920000000001@c.us";

function loadEnv(): Record<string, string | undefined> {
  const file = resolve(import.meta.dirname, "../.env.local");
  const fromFile = existsSync(file)
    ? Object.fromEntries(
        readFileSync(file, "utf8")
          .split(/\r?\n/)
          .filter((line) => /^[A-Z_]+=/.test(line))
          .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
      )
    : {};
  return { ...fromFile, ...process.env };
}

const EVAL_PRICING = { deliveryFeePkr: EVAL_SHOP.deliveryFeePkr, freeDeliveryFromPkr: EVAL_SHOP.freeDeliveryFromPkr };

// The open order a case starts with (see EvalCase.order).
function presetOrder(kind: EvalCase["order"]): OrderDraft | null {
  if (!kind) return null;
  const cart: OrderDraft = {
    id: "eval-order",
    number: 1042,
    lines: [{ productId: "a1000000-0000-4000-8000-000000000002", size: "L", normalizedSize: "L", quantity: 1 }],
    details: EMPTY_DETAILS,
    summaryFingerprint: null,
  };
  if (kind === "cart") return cart;
  const complete: OrderDraft = { ...cart, details: { ...EMPTY_DETAILS, name: "Ali Raza", phone: "923217654321", address: "House 12 Street 4 Gulberg", city: "Lahore" } };
  if (kind === "complete") return complete;
  return { ...complete, summaryFingerprint: orderFingerprint(complete, new Map(EVAL_CATALOG.map((item) => [item.id, item])), EVAL_PRICING) };
}

class EvalRepository implements BrainRepository {
  run: AgentRunRecord | undefined;
  handoffs = 0;
  // "update" | "place" | "discard", in the order they happened.
  orderEvents: string[] = [];
  constructor(
    private readonly testCase: EvalCase,
    private readonly catalog: CatalogItem[],
    // Catalog embeddings for meaning-based search, computed once per run with the real model.
    private readonly vectors: Map<string, number[]>,
  ) {}
  async loadOrderState(): Promise<OrderState> {
    return { available: true, draft: presetOrder(this.testCase.order), recent: null };
  }
  async saveOrderDraft(_conversationId: string, draft: OrderDraft): Promise<SavedOrderDraft> {
    this.orderEvents.push("update");
    return { id: draft.id ?? "eval-order", number: draft.number ?? 1042, itemsTotalPkr: 0 };
  }
  async discardOrderDraft(): Promise<void> {
    this.orderEvents.push("discard");
  }
  async placeOrder(): Promise<number> {
    this.orderEvents.push("place");
    return 1042;
  }
  async matchProducts(embedding: readonly number[], count: number, minSimilarity: number): Promise<SemanticHit[]> {
    return [...this.vectors]
      .map(([id, vector]) => ({ id, similarity: cosineSimilarity(embedding, vector) }))
      .filter((hit) => hit.similarity >= minSimilarity)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, count);
  }
  // The eval catalog has no real photos (and eval messages are text), so photo search never finds anything.
  async matchProductImages(): Promise<PhotoHit[]> {
    return [];
  }
  async ingestInbound(): Promise<IngestResult> {
    const history = this.testCase.history ?? [];
    return {
      duplicate: false,
      conversation: { id: "eval", state: this.testCase.state ?? "bot_active", activeProductId: null, summary: null },
      contact: { displayName: "Test Customer", customerName: null, location: null, preferredLanguage: null },
      inboundMessageId: "current",
      firstContact: this.testCase.firstContact ?? false,
      recentInboundCount: 1,
      totalMessages: history.length + 1,
    };
  }
  async loadRecentMessages(): Promise<StoredMessage[]> {
    return (this.testCase.history ?? []).map((turn, index) => ({
      id: `h${index}`,
      direction: turn.from === "customer" ? "inbound" : "outbound",
      source: turn.from === "customer" ? "customer" : "agent",
      contentType: turn.productPhoto ? "image" : "text",
      text: turn.text,
      mediaPath: turn.productPhoto ? `products/${turn.productPhoto}/1.jpg` : null,
      occurredAt: new Date(Date.now() - (60 - index) * 60_000).toISOString(),
    }));
  }
  async loadCatalog(): Promise<CatalogItem[]> {
    return this.catalog;
  }
  async saveActions(): Promise<void> {}
  async beginHandoff(): Promise<void> {
    this.handoffs += 1;
  }
  async markHandoffPending(): Promise<void> {}
  async rememberProduct(): Promise<void> {}
  async saveCustomerDetails(): Promise<void> {}
  async saveSummary(): Promise<void> {}
  async recordAgentRun(run: AgentRunRecord): Promise<void> {
    this.run = run;
  }
  async ownerRepliedSince(): Promise<boolean> {
    return false;
  }
  async openHandoff(): Promise<null> {
    return null;
  }
  async replayPendingActions(): Promise<OutboundAction[]> {
    return [];
  }
}

type Check = { name: string; ok: boolean; detail?: string };

function customerText(actions: OutboundAction[]): { texts: string[]; captions: string[]; cardIds: string[] } {
  const mine = actions.filter((action) => action.recipientChatId === CUSTOMER);
  return {
    texts: mine.flatMap((action) => (action.type === "text" && !/^\*[^*]+\*\n(?:Price|Qeemat|قیمت):/.test(action.text) ? [action.text] : [])),
    captions: mine.flatMap((action) => (action.type === "image" ? [action.caption ?? ""] : action.type === "text" && /^\*[^*]+\*\n(?:Price|Qeemat|قیمت):/.test(action.text) ? [action.text] : [])),
    cardIds: mine.flatMap((action) => (action.type === "image" ? [action.objectPath.split("/")[1] ?? ""] : [])),
  };
}

function score(testCase: EvalCase, actions: OutboundAction[], run: AgentRunRecord | undefined, orderEvents: string[]): Check[] {
  const { texts, captions, cardIds } = customerText(actions);
  const shownIds = new Set([...cardIds, ...(run?.candidateProductIds ?? [])]);
  const all = [...texts, ...captions].join("\n");
  // The code-rendered order summary is data, not the bot's own words.
  const prose = texts.filter((text) => !text.startsWith("🧾")).join("\n");
  // A "please talk to this customer" alert; new-order alerts to the owner are not handoffs.
  const alert = actions.some((action) => action.recipientChatId === SUPPORT && action.type === "text" && action.text.startsWith("Customer wants to talk to a person"));
  const checks: Check[] = [
    { name: "replied", ok: texts.length + captions.length > 0 },
    { name: "brief", ok: texts.length <= 3 && texts.every((text) => text.length <= 500), detail: `${texts.length} msgs` },
    { name: "not robotic", ok: !ROBOTIC.test(all) },
  ];
  const detected = detectLanguage(prose.replace(/\*[^*]+\*/g, ""), "en");
  checks.push({ name: `language=${testCase.language}`, ok: testCase.language === "ur" ? /[؀-ۿ]/.test(prose) : detected === testCase.language, detail: detected });
  if (testCase.expectHandoff !== undefined) checks.push({ name: testCase.expectHandoff ? "handoff" : "no handoff", ok: alert === testCase.expectHandoff });
  if (testCase.expectCards === "some") checks.push({ name: "shows products", ok: shownIds.size > 0 });
  if (testCase.expectCards === "none") checks.push({ name: "no product dump", ok: cardIds.length === 0 });
  for (const id of testCase.mustShow ?? []) checks.push({ name: `shows ${id.slice(-2)}`, ok: shownIds.has(id) });
  for (const id of testCase.mustNotShow ?? []) checks.push({ name: `hides ${id.slice(-2)}`, ok: !shownIds.has(id) });
  for (const pattern of testCase.mustMatch ?? []) checks.push({ name: `has ${pattern.source.slice(0, 24)}`, ok: pattern.test(all) });
  for (const pattern of testCase.mustNotMatch ?? []) checks.push({ name: `lacks ${pattern.source.slice(0, 24)}`, ok: !pattern.test(all) });
  if (testCase.expectOrder) {
    const ok = testCase.expectOrder === "none" ? orderEvents.length === 0 : orderEvents.includes(testCase.expectOrder);
    checks.push({ name: `order ${testCase.expectOrder}`, ok, detail: orderEvents.join(",") || "none" });
  }
  if (testCase.expectSummary !== undefined) {
    checks.push({ name: testCase.expectSummary ? "summary" : "no summary", ok: texts.some((text) => text.startsWith("🧾")) === testCase.expectSummary });
  }
  return checks;
}

type Embeddings = Parameters<typeof processInboundMessage>[1]["embeddings"];

async function runCase(testCase: EvalCase, agent: Parameters<typeof processInboundMessage>[1]["agent"], embeddings: Embeddings, vectors: Map<string, number[]>) {
  const repository = new EvalRepository(testCase, EVAL_CATALOG, vectors);
  const message: InboundMessage = {
    eventId: `eval-${testCase.id}`,
    messageId: `eval-${testCase.id}`,
    chatId: CUSTOMER,
    displayName: "Test Customer",
    occurredAt: new Date().toISOString(),
    type: "text",
    text: testCase.message,
  };
  const started = Date.now();
  const response = await processInboundMessage(message, {
    repository,
    supportChatId: SUPPORT,
    shop: EVAL_SHOP,
    publicUrl: (path) => `https://example.supabase.co/storage/v1/object/public/product-images/${path}`,
    agent,
    embeddings,
    // 09:00 UTC = 14:00 in Karachi: shop open.
    now: () => new Date("2026-09-29T09:00:00Z"),
    defer: () => undefined,
  });
  const ms = Date.now() - started;
  const checks = score(testCase, response.actions, repository.run, repository.orderEvents);
  return { testCase, response, run: repository.run, checks, ms };
}

async function main() {
  const args = process.argv.slice(2);
  const only = args.find((arg) => arg.startsWith("--only="))?.slice("--only=".length);
  const rulesOnly = args.includes("--rules");
  const env = loadEnv();
  const keys = parseGeminiKeys(env.GEMINI_API_KEY);
  if (!rulesOnly && keys.length === 0) throw new Error("GEMINI_API_KEY missing (apps/web/.env.local). Use --rules for a rules-only baseline.");
  const pro = env.GEMINI_MODEL_PRO || "gemini-flash-latest";
  const fast = env.GEMINI_MODEL_FAST || "gemini-flash-lite-latest";
  const agent = rulesOnly ? undefined : { apiKey: keys, models: [...new Set([pro, ...parseModelList(env.GEMINI_MODEL_FALLBACKS), fast])], budgetMs: 30_000 };
  const prefixes = only ? only.split(",").filter(Boolean) : [];
  const cases = EVAL_CASES.filter((testCase) => prefixes.length === 0 || prefixes.some((prefix) => testCase.id.startsWith(prefix)));

  // Meaning-based search: embed the eval catalog once, then search it in memory like match_products would.
  const embeddingModel = env.GEMINI_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL;
  const embeddings: Embeddings = keys.length && !args.includes("--no-semantic") ? { apiKey: keys, model: embeddingModel } : undefined;
  const vectors = new Map<string, number[]>();
  if (embeddings) {
    // Cached between runs (results/ is git-ignored): the catalog rarely changes and free-tier quotas are per minute.
    const cacheFile = resolve(import.meta.dirname, "results", `embeddings-${embeddingModel}.json`);
    const cache: Record<string, { hash: string; vector: number[] }> = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, "utf8")) : {};
    for (const product of EVAL_CATALOG) {
      const text = productEmbeddingText(product);
      const hash = embeddingSourceHash(text, embeddingModel);
      if (cache[product.id]?.hash !== hash) {
        cache[product.id] = { hash, vector: await embedText({ apiKey: keys, model: embeddingModel, text, taskType: "RETRIEVAL_DOCUMENT", title: product.name }) };
      }
      vectors.set(product.id, cache[product.id]!.vector);
    }
    mkdirSync(resolve(import.meta.dirname, "results"), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify(cache));
  }

  console.log(`${cases.length} cases, ${rulesOnly ? "rules only" : `models ${agent!.models.join(" → ")}`}${embeddings ? `, meaning search ${embeddingModel}` : ""}\n`);
  const results: Awaited<ReturnType<typeof runCase>>[] = [];
  // Low by default: bursts trip Gemini's per-minute limits and would score the rules fallback instead.
  const concurrency = Number(args.find((arg) => arg.startsWith("--concurrency="))?.slice("--concurrency=".length) ?? 2);
  for (let index = 0; index < cases.length; index += concurrency) {
    const batch = await Promise.all(cases.slice(index, index + concurrency).map((testCase) => runCase(testCase, agent, embeddings, vectors)));
    for (const result of batch) {
      results.push(result);
      const passed = result.checks.filter((check) => check.ok).length;
      const failed = result.checks.filter((check) => !check.ok).map((check) => `${check.name}${check.detail ? ` (${check.detail})` : ""}`);
      const via = result.run?.outcome === "fallback" ? `rules[${result.run.errorCode ?? "no agent"}]` : `${result.run?.model} ×${(result.run?.diagnostics as { calls?: number } | undefined)?.calls ?? "?"}`;
      console.log(`${passed === result.checks.length ? "PASS" : "FAIL"} ${result.testCase.id.padEnd(24)} ${String(passed).padStart(2)}/${result.checks.length}  ${String(result.ms).padStart(6)}ms  ${via}${failed.length ? `  ✗ ${failed.join("; ")}` : ""}`);
      const reply = result.response.actions.filter((action) => action.recipientChatId === CUSTOMER).map((action) => (action.type === "text" ? action.text : `[photo] ${action.caption?.split("\n")[0]}`));
      console.log(`     > ${result.testCase.message}\n     < ${reply.join("\n       ").replace(/\n/g, "\n       ")}`);
      // Slow turns: show where the time went (model attempts in order).
      const attempts = (result.run?.diagnostics as { attempts?: string[] } | undefined)?.attempts ?? [];
      console.log(result.ms > 5_000 && attempts.length ? `     ⏱ ${attempts.join(" → ")}\n` : "");
    }
  }

  const checks = results.flatMap((result) => result.checks);
  const latencies = results.map((result) => result.ms).sort((a, b) => a - b);
  const summary = {
    at: new Date().toISOString(),
    mode: rulesOnly ? "rules" : "agent",
    models: agent?.models ?? [],
    cases: results.length,
    casesPassed: results.filter((result) => result.checks.every((check) => check.ok)).length,
    checksPassed: checks.filter((check) => check.ok).length,
    checks: checks.length,
    fallbacks: results.filter((result) => result.run?.outcome === "fallback").length,
    factIssuesFirstTry: results.filter((result) => ((result.run?.diagnostics as { issues?: string[] } | undefined)?.issues ?? []).length > 0).length,
    medianMs: latencies[Math.floor(latencies.length / 2)] ?? 0,
    p90Ms: latencies[Math.floor(latencies.length * 0.9)] ?? 0,
  };
  console.log(
    `Score: ${summary.checksPassed}/${summary.checks} checks (${Math.round((100 * summary.checksPassed) / Math.max(1, summary.checks))}%), ${summary.casesPassed}/${summary.cases} cases fully passed. ` +
      `Rules fallback: ${summary.fallbacks}. Replies needing fact-fixes: ${summary.factIssuesFirstTry}. Latency median ${summary.medianMs}ms, p90 ${summary.p90Ms}ms.`,
  );
  const dir = resolve(import.meta.dirname, "results");
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `${summary.at.replace(/[:.]/g, "-")}-${summary.mode}.json`);
  writeFileSync(file, JSON.stringify({ summary, results: results.map((result) => ({ id: result.testCase.id, message: result.testCase.message, ms: result.ms, run: result.run, checks: result.checks, actions: result.response.actions })) }, null, 2));
  console.log(`Saved ${file}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

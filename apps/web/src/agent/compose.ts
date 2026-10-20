import { randomUUID } from "node:crypto";
import type { Language, OutboundAction } from "@huzaifa/contracts";
import { normalizeSize } from "../catalog/admin/validation";
import { inStockSizes, type CatalogItem } from "../catalog/search";

// The model writes the words; code writes the facts. Products are referenced by short per-turn refs
// ("P1") because models copy those reliably, unlike 36-character UUIDs.
export type ProductRefs = {
  byRef: Map<string, CatalogItem>;
  refOf: Map<string, string>;
};

export function createProductRefs(): ProductRefs {
  return { byRef: new Map(), refOf: new Map() };
}

export function refFor(refs: ProductRefs, product: CatalogItem): string {
  const existing = refs.refOf.get(product.id);
  if (existing) return existing;
  const ref = `P${refs.byRef.size + 1}`;
  refs.byRef.set(ref, product);
  refs.refOf.set(product.id, ref);
  return ref;
}

export type DraftReply = {
  language: Language;
  // 1–3 short WhatsApp messages. Product cards go right after the one pointing at them (👇), else after the first.
  messages: string[];
  // Product refs to send as photo cards (name, price and in-stock sizes are added by code).
  showProducts: string[];
};

const pkr = new Intl.NumberFormat("en-PK", { style: "currency", currency: "PKR", maximumFractionDigits: 0 });
// Plain spaces: some WhatsApp clients render the formatter's non-breaking space oddly.
export const formatPrice = (value: number) => pkr.format(value).replace(/ /g, " ");

// ---- Fact checks. They run on the model's own words with tags masked, so product names inserted by
// code ("3 Piece Lawn Suit") can never look like an invented stock count.

const DIGITS = "0-9٠-٩۰-۹";
const NUMBER = `[${DIGITS}][${DIGITS},]*`;
// "Rs 2,450", "Rs: 2450", "2450 rupay", "PKR2450", "2450/-", "۲۴۵۰ روپے"
const CURRENCY_AMOUNT = new RegExp(String.raw`(?:\brs\.?|\bpkr|₨|روپے)\s*[:.]?\s*(${NUMBER})|(${NUMBER})\s*(?:\brs\b|\bpkr\b|rupees?|rupay|rupaye|روپے|\/-)`, "gi");
// "20% off", "20 percent off", "flat 500 off", "500 ka discount"
const DISCOUNT = new RegExp(String.raw`(${NUMBER})\s*(?:%|percent|fisad|فیصد)\s*(?:off|discount|kam|chhoot|sale|رعایت)|\bflat\s*(${NUMBER})\s*off\b|(${NUMBER})\s*(?:ka|ki|ke)?\s*discount`, "gi");
// Any other 3+ digit number could be a price ("Ye 2450 ka hai", "qeemat sirf 2450"); "100% cotton" is not.
const BARE_NUMBER = new RegExp(String.raw`(?<![${DIGITS},.])(${NUMBER})(?![${DIGITS}])(?!\s*%)`, "g");
// Stock counts: "sirf 2 bache hain", "5 pieces left", "M size 3 available hain". "3 piece suit" and
// "2 pieces wala suit" are garment styles, not counts.
const GARMENT_AFTER = String.raw`(?!\s+(?:suit|suits|wala|wali|wale|set|sets|dress|jora|jore|ka|ki|ke|lawn|kurta)\b)`;
const QUANTITY = new RegExp(
  String.raw`(?<![${DIGITS}])${NUMBER}\s*(?:hi\s+)?(?:pcs|pieces${GARMENT_AFTER}|units?|bache|bachay|bachy|baqi|remaining|left|in stock|stock mein|available|mojood|maujood|عدد|باقی)\b|(?<![${DIGITS}])${NUMBER}\s*(?:pc|piece)\s+(?:hi\s+)?(?:left|bache|bachay|baqi|remaining)\b`,
  "i",
);

// Size availability stated without a {{size}} tag. Size mentions are marked first: only uppercase letters count
// ("it's", "I m", Roman Urdu "m" for "mein" are not sizes), numbers only as "size 32" / "32 number".
const SIZE_MARK = " ⟪sz⟫ ";
function markSizes(text: string): string {
  return text
    .replace(/\bsize\s+(?:no\.?\s*)?(?:\d{1,2}|xxxl|xxl|xl|xxs|xs|s|m|l)\b/gi, SIZE_MARK)
    .replace(/\b(?:\d{1,2}|xxxl|xxl|xl|xxs|xs|s|m|l)\s+(?:size|number|no\.?)(?![\p{L}])/giu, SIZE_MARK)
    .replace(/(?<![\p{L}\p{N}'’])(?:[2-5]XL|XXXL|XXL|XL|XXS|XS|S|M|L)(?![\p{L}\p{N}'’])/gu, SIZE_MARK)
    .replace(/\b(?:extra[\s-]*large|small|medium|large|free[\s-]*size)\b/gi, SIZE_MARK);
}
const AVAILABILITY = String.raw`(?:available|availab\w*|in\s+stock|stock\s+mein|khatam|sold\s+out|out\s+of\s+stock|mil\s+(?:jayega|jaye\s*ga|jayegi|sakta|sakti|jata|jati)|mojood|maujood|aata|aati|hai|hain|nahi|nhi)`;
const SIZE_CLAIM = new RegExp(
  String.raw`⟪sz⟫\s*(?:(?:is|are|bhi|mein|me|main|abhi|size)\s+){0,2}${AVAILABILITY}\b|\b(?:available|in\s+stock|comes?|have\s+(?:it|this|them|these)?|got\s+(?:it|this)?)\s*in\s+⟪sz⟫|⟪sz⟫\s*سائز\s*(?:دستیاب|موجود|ختم)`,
  "i",
);
// Case-insensitive: models sometimes write {{Product:P1}}. {{sizes:P1}} lists every size in stock.
const TAG = /\{\{\s*(product|sizes|size)\s*:\s*([A-Za-z0-9]+)\s*(?::\s*([^}]{1,20}))?\}\}/gi;
// Leftover brace fragments (bad or half-closed tags like "{{size:P1:M}") are removed whole, never sent.
const BRACES = /\{\{[^{}]*\}{1,2}|\{[^{}]*\}\}|\{\{|\}\}/g;
// Amounts from Shop info are only accepted in sentences about delivery, payment, returns, timings or the address.
const POLICY_CONTEXT =
  /\b(?:deliver\w*|shipping|ship|courier|charges?|fee|free|cod|cash|payment|pay|advance|jazz\s*cash|easypaisa|bank|transfer|returns?|exchange|refund|address|street|block|road|plot|sector|phase|house|market|floor|phone|call|whatsapp|number|timings?|days?|din|hours?)\b|ڈیلیوری|واپسی|ادائیگی|پتہ|فون/iu;

const toAsciiDigits = (value: string) =>
  value.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0)).replace(/,/g, "");

// Amounts written in Shop info (a delivery charge, the shop's phone) may be quoted in policy sentences.
// They are never accepted in a sentence that mentions a product or isn't about a policy, so they can't
// pass for a price ("Ye suit Rs 5000 ka hai" is rejected even when 5000 is the free-delivery threshold).
export function amountsIn(text: string): Set<string> {
  return new Set((text.match(/\d[\d,]*/g) ?? []).map(toAsciiDigits).filter((value) => value.length >= 2));
}

// The customer's own address or phone read back to them ("House 1500, Street 7" / "0321 7654321"): only in a
// sentence about the address or number, and never next to money words.
const READ_BACK_CONTEXT = /\b(?:address|house|street|block|road|plot|sector|phase|flat|apartment|floor|phone|mobile|number|nambar|contact|gali|makan|mohalla)\b|پتہ|فون|نمبر|مکان|گلی/iu;
const MONEY_WORDS = /\b(?:rs|pkr|rupees?|rupay|rupaye|price|prices|qeemat|keemat|charges?|fee|off|discount|advance|payment|pay|total|cod|cash|free)\b|روپے|قیمت|₨/iu;

function inventedAmounts(masked: string, allowed: ReadonlySet<string>, readBack: ReadonlySet<string>): boolean {
  // Money amounts (with a currency or a discount) may only be the shop's own published numbers.
  const money: string[] = [];
  for (const match of masked.matchAll(CURRENCY_AMOUNT)) money.push(match[1] ?? match[2] ?? "");
  for (const match of masked.matchAll(DISCOUNT)) money.push(match[1] ?? match[2] ?? match[3] ?? "");
  if (money.some((amount) => !allowed.has(toAsciiDigits(amount)))) return true;
  const bare: string[] = [];
  for (const match of masked.matchAll(BARE_NUMBER)) if (toAsciiDigits(match[1] ?? "").length >= 3) bare.push(match[1] ?? "");
  return bare.some((amount) => !allowed.has(toAsciiDigits(amount)) && !readBack.has(toAsciiDigits(amount)));
}

type Violation = "price" | "quantity" | "size" | "tag" | "copied";

function normalizeForCopyCheck(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function maskTags(sentence: string): string {
  return sentence.replace(TAG, (_match, kind: string) => (kind.toLowerCase().startsWith("size") ? " ⟪size⟫ " : " ⟪item⟫ "));
}

// Keeps the clauses of a sentence that state a database fact (a tag) and pass `isClean`, without a dangling
// "lekin"/"but" or comma. Untagged clauses go with the claim: "Ji haan, M size available hai." must not shrink
// to a bare "Ji haan." when M is sold out.
function cleanClauses(sentence: string, isClean: (clause: string) => boolean): string {
  const clauses = sentence.split(CLAUSE_SPLIT).filter((clause) => /\{\{/.test(clause) && isClean(clause));
  if (!clauses.length) return "";
  const text = clauses.join(" ").replace(LEADING_JOINER, "").replace(/[\s,،;]+$/, "").trim();
  const end = sentence.trim().match(/[.!?۔]$/)?.[0] ?? "";
  return /[.!?۔]$/.test(text) ? text : `${text}${end}`;
}

function violations(sentence: string, allowed: ReadonlySet<string>, examples?: string, readBack: ReadonlySet<string> = new Set()): Violation[] {
  const hasProduct = /\{\{\s*product\s*:/i.test(sentence);
  const masked = maskTags(sentence);
  const found: Violation[] = [];
  // A shop-published number is fine in a policy sentence, never in a sentence about a product.
  const policyAmounts = hasProduct || !POLICY_CONTEXT.test(masked) ? new Set<string>() : allowed;
  const customerNumbers = hasProduct || !READ_BACK_CONTEXT.test(masked) || MONEY_WORDS.test(masked) ? new Set<string>() : readBack;
  if (inventedAmounts(masked, policyAmounts, customerNumbers)) found.push("price");
  if (QUANTITY.test(masked)) found.push("quantity");
  // Questions ("Aapka size M hai ya L?") state nothing.
  if (!/[?؟]\s*$/.test(masked.trim()) && SIZE_CLAIM.test(markSizes(masked))) found.push("size");
  if (/\{\{|\}\}|\{\s*(?:product|size)\s*:/i.test(masked)) found.push("tag");
  // Owner-pasted example chats hold real customers' words: long verbatim copies could leak them.
  const normalized = normalizeForCopyCheck(masked);
  if (examples && normalized.length >= 30 && examples.includes(normalized)) found.push("copied");
  return found;
}

const VIOLATION_MESSAGES: Record<Violation, string> = {
  price: "typed a price, discount or other amount; product prices come only from the product cards",
  quantity: "typed a stock quantity; never say how many are left",
  size: "stated a size's availability without a tag; use {{size:P1:L}} for one size or {{sizes:P1}} for every size in stock, and no words like 'available hai' after them",
  tag: "wrote a broken tag; use exactly {{product:P1}} or {{size:P1:M}}",
  copied: "copied a line from the example chats; write your own words and never repeat other customers' details",
};

// Same reading as markSizes: single letters only in capitals, numbers only as "size 32" / "32 number".
const UPPER_SIZE = /(?<![\p{L}\p{N}'’])(?:[2-5]XL|XXXL|XXL|XL|XXS|XS|S|M|L)(?![\p{L}\p{N}'’])/gu;
const WORD_SIZE = /\bsize\s+(\d{1,2}|xxxl|xxl|xl|xs)\b|\b(\d{1,2}|xxxl|xxl|xl|xs)\s+(?:size|number)\b|\b(extra[\s-]*large|small|medium|large)\b/gi;
const SIZE_WORDS: Record<string, string> = { "extra large": "XL", small: "S", medium: "M", large: "L" };

// The rewrite fixes what it's told precisely: which size was claimed untagged, and the tag to write instead.
function sizeViolationMessage(sentence: string, masked: string): string {
  const ref = sentence.match(/\{\{\s*(?:product|sizes?)\s*:\s*([A-Za-z0-9]+)/i)?.[1]?.toUpperCase() ?? "P1";
  const sizes = new Set<string>();
  // Tagged sizes are masked already, so only the untagged ones are found here.
  for (const match of masked.matchAll(UPPER_SIZE)) sizes.add(match[0]);
  for (const match of masked.matchAll(WORD_SIZE)) {
    const word = match[3]?.toLowerCase().replace(/[\s-]+/g, " ");
    const size = match[1] ?? match[2] ?? (word ? SIZE_WORDS[word] : undefined);
    if (size) sizes.add(size.toUpperCase());
  }
  if (!sizes.size) return VIOLATION_MESSAGES.size;
  const tags = [...sizes].map((size) => `{{size:${ref}:${size}}}`).join(" and ");
  return `stated availability of size ${[...sizes].join(", ")} without a tag: write ${tags} in its place (each becomes a whole clause, e.g. "XL size abhi khatam hai" or "XL size nahi aata"), never "${[...sizes][0]} nahi hai" or "available" yourself`;
}

// A sentence whose only problem is an untagged size claim keeps its clean clauses: "{{size:P1:L}}, lekin XL nahi
// hai." still tells the customer L is in stock instead of losing the whole answer.
const CLAUSE_SPLIT = /(?<=[,،;])\s*|\s+(?=(?:lekin|magar|but|however)\b)/i;
const LEADING_JOINER = /^(?:lekin|magar|but|however|aur|and)\s+/i;

export const MAX_MESSAGES = 3;
const MAX_MESSAGE_CHARS = 700;

type SizeFacts = { yes: (size: string, name?: string) => string; no: (size: string, name?: string) => string; never: (size: string, name?: string) => string };
// Plain phrases the model writes around (no emoji: the model adds its own tone, and doubles looked odd).
// The product name is included when the sentence doesn't already name it, so a size fact is never ambiguous.
const sizeLabels: Record<Language, SizeFacts> = {
  en: {
    yes: (s, name) => (name ? `*${name}*: size ${s} is in stock` : `size ${s} is in stock`),
    no: (s, name) => (name ? `*${name}*: size ${s} is sold out right now` : `size ${s} is sold out right now`),
    never: (s, name) => (name ? `*${name}* doesn't come in size ${s}` : `it doesn't come in size ${s}`),
  },
  roman_ur: {
    yes: (s, name) => (name ? `*${name}* mein ${s} size available hai` : `${s} size available hai`),
    no: (s, name) => (name ? `*${name}* mein ${s} size abhi khatam hai` : `${s} size abhi khatam hai`),
    never: (s, name) => (name ? `*${name}* ${s} size mein nahi aata` : `${s} size nahi aata`),
  },
  ur: {
    yes: (s, name) => (name ? `*${name}* میں ${s} سائز دستیاب ہے` : `${s} سائز دستیاب ہے`),
    no: (s, name) => (name ? `*${name}* میں ${s} سائز ابھی ختم ہے` : `${s} سائز ابھی ختم ہے`),
    never: (s, name) => (name ? `*${name}* ${s} سائز میں نہیں آتا` : `${s} سائز نہیں آتا`),
  },
};

function sizeFact(product: CatalogItem, rawSize: string, language: Language, withName: boolean): string {
  const wanted = normalizeSize(rawSize);
  const variant = product.variants.find((candidate) => normalizeSize(candidate.normalizedSize) === wanted);
  const labels = sizeLabels[language];
  const name = withName ? product.name : undefined;
  if (!variant) return labels.never(wanted, name);
  return variant.stockQty > 0 ? labels.yes(variant.size, name) : labels.no(variant.size, name);
}

// {{sizes:P1}}: every size in stock right now, from the database.
function stockSizesFact(product: CatalogItem, language: Language, withName: boolean): string {
  const sizes = inStockSizes(product);
  const name = withName ? `*${product.name}* ` : "";
  const join = (and: string) => (sizes.length > 1 ? `${sizes.slice(0, -1).join(", ")} ${and} ${sizes.at(-1)}` : (sizes[0] ?? ""));
  if (language === "ur") return sizes.length ? `${name ? `${name}میں ` : ""}${join("اور")} سائز دستیاب ${sizes.length > 1 ? "ہیں" : "ہے"}` : `${name}ابھی ہر سائز میں ختم ہے`;
  if (language === "roman_ur") return sizes.length ? `${name ? `${name}mein ` : ""}${join("aur")} size available ${sizes.length > 1 ? "hain" : "hai"}` : `${name}abhi har size mein khatam hai`;
  return sizes.length ? `${name ? `${name}comes in ` : "in stock in "}${sizes.length > 1 ? "sizes" : "size"} ${join("and")}` : `${name ? `${name}is ` : ""}sold out in every size right now`;
}

export function productCaption(product: CatalogItem, language: Language): string {
  const sizes = inStockSizes(product);
  const price = formatPrice(product.pricePkr);
  if (language === "ur") return `*${product.name}*\nقیمت: ${price}\n${sizes.length ? `سائز: ${sizes.join(", ")}` : "فی الحال دستیاب نہیں"}`;
  if (language === "roman_ur") return `*${product.name}*\nQeemat: ${price}\n${sizes.length ? `Sizes: ${sizes.join(", ")}` : "Filhal stock mein nahi"}`;
  return `*${product.name}*\nPrice: ${price}\n${sizes.length ? `Sizes: ${sizes.join(", ")}` : "Currently out of stock"}`;
}

export type ComposeInput = {
  draft: DraftReply;
  chatId: string;
  refs: ProductRefs;
  // Fresh rows for this turn, keyed by product id. Anything not here is not shown.
  products: Map<string, CatalogItem>;
  publicUrl: (storagePath: string) => string;
  // Numbers the shop itself published in its policies (Shop info); quoting them is not inventing a price.
  allowedAmounts?: ReadonlySet<string>;
  // The customer's own address and phone digits, which may be read back (never as money).
  readBackNumbers?: ReadonlySet<string>;
  // The owner's pasted example chats: long lines copied from them are rejected (they hold real customers' words).
  exampleChats?: string;
  // Products whose card went out in the bot's last replies (memory.ts recentCardProductIds). Sent again only when
  // the customer asks for it (photo, price, details), so someone who said no isn't shown the same item every turn.
  recentCards?: ReadonlySet<string>;
  customerText?: string;
};

// The customer asks to see a product (again): its photo, price or details.
const ASKS_TO_SEE =
  /\b(?:pics?|pictures?|photos?|images?|tasveer\w*|tasweer\w*|dikha\w*|dekha\w*|show|send|bhej\w*|check|chk|price|prices|qeemat|keemat|kitne|kitna|kitni|rate|cost|details?|dobara|again|wapis|wapas)\b|تصویر|دکھا|قیمت|کتنے/iu;

export function asksToSeeProduct(text: string): boolean {
  return ASKS_TO_SEE.test(text);
}

export type ComposeResult = {
  actions: OutboundAction[];
  // Rule breaks worth one rewrite by the model (empty when the draft was clean).
  issues: string[];
  shownProductIds: string[];
};

const SENTENCE_SPLIT = /(?<=[.!?۔\n])\s*/;

// Marks where a rendered size fact ends. The fact is a whole clause ("M size abhi khatam hai"); models often
// add their own predicate after the tag ("{{size:P1:M}} nahi hai", "… available hai", "… is available"),
// which would garble it or contradict the database. That predicate is dropped; the database's fact stands.
const FACT_END = "\u0001";
// Same line only ([ \t], never a line break): the next line is the model's next sentence or fact.
const AVAILABLE_WORD = String.raw`(?:available|in[ \t]+stock|khatam|sold[ \t]+out|mojood|maujood|mil[ \t]+jay?e?[ \t]?ga)`;
const PREDICATE_AFTER_FACT = new RegExp(
  String.raw`${FACT_END}(?:` +
    // English: "is available", "are not in stock"
    String.raw`[ \t]*(?:is|are)[ \t]+(?:not[ \t]+)?(?:available|in[ \t]+stock|sold[ \t]+out)(?![\p{L}\p{N}])` +
    // Urdu: "دستیاب ہے", "نہیں ہے"
    String.raw`|[ \t]*(?:دستیاب[ \t]*|موجود[ \t]*)?(?:نہیں[ \t]*)?(?:ہے|ہیں)(?!\p{L})` +
    // Roman Urdu with a copula: "hai", "nahi hai", "bhi available hai"
    String.raw`|[ \t]*(?:(?:abhi|bhi|to|toh)[ \t]+)*(?:${AVAILABLE_WORD}[ \t]*)?(?:(?:nahi|nhi)[ \t]*)?(?:hai|hain|he|hy)(?![\p{L}\p{N}])` +
    // ...or without one: "available", "bhi mil jayega", "nahi"
    String.raw`|[ \t]*(?:(?:abhi|bhi|to|toh)[ \t]+)*${AVAILABLE_WORD}(?:[ \t]+(?:nahi|nhi))?(?![\p{L}\p{N}])` +
    String.raw`|[ \t]+(?:nahi|nhi)(?![\p{L}\p{N}])` +
    ")?",
  "giu",
);

function renderMessage(text: string, input: ComposeInput, issues: Set<string>, sanitize: boolean): string {
  const allowed = input.allowedAmounts ?? new Set<string>();
  const examples = input.exampleChats ? normalizeForCopyCheck(input.exampleChats) : undefined;
  // Checked sentence by sentence on the raw model text, so a bad sentence can be dropped on its own.
  const kept: string[] = [];
  for (const sentence of text.split(SENTENCE_SPLIT)) {
    const found = violations(sentence, allowed, examples, input.readBackNumbers);
    // Quoting the sentence tells the rewrite exactly what to fix.
    for (const violation of found) {
      const message = violation === "size" ? sizeViolationMessage(sentence, maskTags(sentence)) : VIOLATION_MESSAGES[violation];
      issues.add(`${message} (in "${sentence.trim().slice(0, 90)}")`);
    }
    if (!found.length || !sanitize) kept.push(sentence);
    else if (found.every((violation) => violation === "size")) {
      const clean = cleanClauses(sentence, (clause) => violations(clause, allowed, examples, input.readBackNumbers).length === 0);
      if (clean) kept.push(clean);
    }
  }
  const raw = kept.join(" ");

  const named = new Set<string>();
  for (const match of raw.matchAll(TAG)) if (match[1]!.toLowerCase() === "product") named.add(match[2]!.toUpperCase());
  const rendered = raw.replace(TAG, (match: string, kind: string, ref: string, size: string | undefined, offset: number) => {
    const product = input.refs.byRef.get(ref.toUpperCase());
    const fresh = product ? input.products.get(product.id) : undefined;
    if (!fresh) {
      issues.add(`unknown product ref ${ref}`);
      return "";
    }
    if (kind.toLowerCase().startsWith("size")) {
      const withName = !named.has(ref.toUpperCase());
      // Named once per message: "*Ruby Kurta* mein M size khatam hai, lekin S size available hai".
      named.add(ref.toUpperCase());
      let fact: string;
      if (kind.toLowerCase() === "sizes") fact = stockSizesFact(fresh, input.draft.language, withName);
      else if (size) fact = sizeFact(fresh, size, input.draft.language, withName);
      else {
        issues.add(`size tag for ${ref} without a size`);
        return `*${fresh.name}*`;
      }
      // Models often run straight on after the fact ("...available hai Team aap se..."): end the sentence for them.
      if (/^\s+\p{Lu}/u.test(raw.slice(offset + match.length))) return `${fact}.`;
      return `${fact}${FACT_END}`;
    }
    return `*${fresh.name}*`;
  });
  if (/\{\{|\}\}/.test(rendered)) issues.add("malformed tag");
  return rendered
    .replace(PREDICATE_AFTER_FACT, "")
    .replace(BRACES, "")
    // Sentences are rejoined with spaces; a line break keeps no space around it.
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.!?۔])/g, "$1")
    .trim();
}

// Kept for callers that only need the sanitizing step.
export function stripInventedFacts(text: string, allowedAmounts?: ReadonlySet<string>): string {
  return text
    .split(SENTENCE_SPLIT)
    .filter((sentence) => violations(sentence, allowedAmounts ?? new Set()).length === 0)
    .join(" ")
    .replace(BRACES, "")
    .trim();
}

export function composeReply(input: ComposeInput, options: { sanitize?: boolean } = {}): ComposeResult {
  const issues = new Set<string>();
  const { draft } = input;
  if (draft.messages.length > MAX_MESSAGES) issues.add(`more than ${MAX_MESSAGES} messages`);

  const texts = draft.messages
    .slice(0, MAX_MESSAGES)
    .map((message) => renderMessage(message, input, issues, Boolean(options.sanitize)))
    .map((message) => {
      if (message.length <= MAX_MESSAGE_CHARS) return message;
      issues.add("a message is too long; keep each under 300 characters");
      return `${message.slice(0, MAX_MESSAGE_CHARS - 1).replace(/\s+\S*$/, "")}…`;
    })
    .filter(Boolean);

  const wanted: CatalogItem[] = [];
  for (const ref of draft.showProducts) {
    const product = input.refs.byRef.get(ref.trim().toUpperCase());
    const fresh = product ? input.products.get(product.id) : undefined;
    if (!fresh) {
      issues.add(`unknown product ref ${ref} in show_products`);
      continue;
    }
    if (!wanted.some((card) => card.id === fresh.id) && wanted.length < 3) wanted.push(fresh);
  }
  // The same card again and again reads like a broken bot; it's sent again only when asked for. A reply that
  // would be left with nothing at all keeps it.
  const repeatAllowed = asksToSeeProduct(input.customerText ?? "");
  const notRepeated = wanted.filter((card) => repeatAllowed || !input.recentCards?.has(card.id));
  const cards = notRepeated.length || texts.length ? notRepeated : wanted;
  let messages = texts;
  // "ye dekhein 👇" with nothing below it: the arrow goes, the words stay.
  if (wanted.length && !cards.length) messages = texts.map((message) => message.replace(/\s*👇/gu, "").trim()).filter(Boolean);

  if (messages.length === 0 && cards.length === 0) issues.add("empty reply");

  const text = (value: string): OutboundAction => ({ actionId: randomUUID(), recipientChatId: input.chatId, type: "text", text: value });
  const cardActions: OutboundAction[] = [];
  const withoutPhotos: CatalogItem[] = [];
  for (const card of cards) {
    const photo = card.imagePaths[0];
    if (photo) {
      cardActions.push({
        actionId: randomUUID(),
        recipientChatId: input.chatId,
        type: "image",
        objectPath: photo,
        url: input.publicUrl(photo),
        caption: productCaption(card, draft.language),
      });
    } else {
      withoutPhotos.push(card);
    }
  }
  // Products without a photo are listed together in one message instead of several bare cards.
  if (withoutPhotos.length) cardActions.push(text(withoutPhotos.map((card) => productCaption(card, draft.language)).join("\n\n")));

  // Cards follow the message that points at them ("ye dekhein 👇"); without one, they follow the first message.
  const pointer = messages.findIndex((message) => /👇|:$/u.test(message));
  const split = pointer >= 0 ? pointer + 1 : Math.min(1, messages.length);
  const actions = [...messages.slice(0, split).map(text), ...cardActions, ...messages.slice(split).map(text)];
  return { actions, issues: [...issues], shownProductIds: cards.map((card) => card.id) };
}

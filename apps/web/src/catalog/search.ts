import { compareSizes, normalizeSize } from "./admin/validation";
import {
  CATEGORY_FAMILIES,
  COLOR_FAMILIES,
  canonicalToken,
  categoryOf,
  colorOf,
  fabricOf,
  isStopWord,
  sameFamily,
  tokenize,
} from "./vocabulary";

// One active product with everything the agent may talk about. Loaded fresh per turn, so prices and
// stock are never older than the message being answered.
export type CatalogItem = {
  id: string;
  sku: string;
  name: string;
  description: string;
  category: string;
  color: string | null;
  material: string | null;
  styleTags: string[];
  aliases: string[];
  pricePkr: number;
  createdAt: string;
  variants: { size: string; normalizedSize: string; stockQty: number }[];
  imagePaths: string[];
  aiText: string;
};

export type SearchFilters = {
  text?: string;
  category?: string;
  color?: string;
  size?: string;
  maxPrice?: number;
};

export type MatchKind = "exact" | "near" | "none";

export type SearchHit = {
  product: CatalogItem;
  score: number;
  category: MatchKind | null;
  color: MatchKind | null;
  // null when no size was asked for.
  sizeInStock: boolean | null;
  withinBudget: boolean | null;
  // Free-text words shared with the product.
  wordOverlap: number;
};

export type SearchResult = {
  filters: SearchFilters;
  // Every requested attribute satisfied exactly (right garment, right colour, within budget).
  matches: SearchHit[];
  // Closest other items, for "we don't have that, but here's something close".
  alternatives: SearchHit[];
};

type Profile = { colors: Set<string>; categories: Set<string>; words: Set<string> };

const profiles = new WeakMap<CatalogItem, Profile>();

function profileOf(item: CatalogItem): Profile {
  const cached = profiles.get(item);
  if (cached) return cached;
  const colorText = [item.color ?? "", item.name, ...item.styleTags, ...item.aliases, item.aiText].join(" ");
  const categoryText = [item.category, item.name, ...item.aliases, ...item.styleTags].join(" ");
  const allText = [item.name, item.description, item.category, item.color ?? "", item.material ?? "", ...item.styleTags, ...item.aliases, item.aiText, item.sku].join(" ");
  const profile: Profile = {
    colors: new Set(tokenize(colorText).map(colorOf).filter((value): value is string => Boolean(value))),
    categories: new Set(tokenize(categoryText).map(categoryOf).filter((value): value is string => Boolean(value))),
    words: new Set(tokenize(allText).filter((token) => !isStopWord(token)).map(canonicalToken)),
  };
  // The admin's own category label counts even when it isn't in our vocabulary ("co-ords", "kaftan").
  for (const token of tokenize(item.category)) profile.categories.add(categoryOf(token) ?? canonicalToken(token));
  // ...and as a whole label, so a multi-word category ("co-ords") matches its own name.
  profile.categories.add(tokenize(item.category).map(canonicalToken).join(" "));
  profiles.set(item, profile);
  return profile;
}

export function inStockSizes(item: CatalogItem): string[] {
  return item.variants
    .filter((variant) => variant.stockQty > 0)
    .sort((a, b) => compareSizes(normalizeSize(a.normalizedSize), normalizeSize(b.normalizedSize)))
    .map((variant) => variant.size);
}

export function hasSizeInStock(item: CatalogItem, size: string): boolean {
  const wanted = normalizeSize(size);
  return item.variants.some((variant) => normalizeSize(variant.normalizedSize) === wanted && variant.stockQty > 0);
}

function matchKind(wanted: string | undefined, have: Set<string>, families: readonly (readonly string[])[]): MatchKind | null {
  if (!wanted) return null;
  if (have.has(wanted)) return "exact";
  for (const value of have) if (sameFamily(families, wanted, value)) return "near";
  return "none";
}

function normalizeConcept(value: string | undefined, resolve: (token: string) => string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const tokens = tokenize(value);
  for (const token of tokens) {
    const concept = resolve(token);
    if (concept) return concept;
  }
  return tokens.map(canonicalToken).join(" ") || undefined;
}

export function scoreProduct(item: CatalogItem, filters: SearchFilters): SearchHit {
  const profile = profileOf(item);
  const category = matchKind(normalizeConcept(filters.category, categoryOf), profile.categories, CATEGORY_FAMILIES);
  const color = matchKind(normalizeConcept(filters.color, colorOf), profile.colors, COLOR_FAMILIES);
  const sizeInStock = filters.size ? hasSizeInStock(item, filters.size) : null;
  const withinBudget = filters.maxPrice && filters.maxPrice > 0 ? item.pricePkr <= filters.maxPrice : null;
  const textTokens = [...new Set(tokenize(filters.text ?? "").filter((token) => !isStopWord(token)).map(canonicalToken))];
  const overlap = textTokens.filter((token) => profile.words.has(token)).length;

  let score = 0;
  if (category === "exact") score += 3;
  else if (category === "near") score += 1.2;
  if (color === "exact") score += 3;
  else if (color === "near") score += 1.2;
  else if (color === "none" && profile.colors.size === 0) score += 0.3;
  if (sizeInStock === true) score += 1.5;
  if (withinBudget === true) score += 1;
  else if (withinBudget === false) score -= 2;
  score += Math.min(overlap, 4) * 0.8;
  score += inStockSizes(item).length > 0 ? 0.5 : -1;

  return { product: item, score, category, color, sizeInStock, withinBudget, wordOverlap: overlap };
}

function isMatch(hit: SearchHit, filters: SearchFilters): boolean {
  const asked = [filters.category, filters.color].filter((value) => value?.trim()).length;
  // A related garment (kurta for "shirt") or colour (maroon for "red") is an honest alternative, not a match.
  if (hit.category === "near" || hit.category === "none" || hit.color === "near" || hit.color === "none") return false;
  if (hit.withinBudget === false) return false;
  // Free-text only: needs real word overlap, not just "it's in stock".
  if (asked === 0) return hit.score >= 1.3;
  return true;
}

export function searchCatalog(items: readonly CatalogItem[], filters: SearchFilters, limit = 5): SearchResult {
  const hits = items.map((item) => scoreProduct(item, filters)).sort((a, b) => b.score - a.score || a.product.name.localeCompare(b.product.name));
  const matches = hits.filter((hit) => isMatch(hit, filters)).slice(0, limit);
  const matchIds = new Set(matches.map((hit) => hit.product.id));
  // Alternatives must share something real with the request (a colour or garment family, or words);
  // "in stock" or "cheap" alone doesn't make shoes a close alternative to a red kurta.
  const askedForLooks = Boolean(filters.category?.trim() || filters.color?.trim() || filters.text?.trim());
  const related = (hit: SearchHit) =>
    hit.category === "exact" ||
    hit.category === "near" ||
    hit.color === "exact" ||
    hit.color === "near" ||
    hit.wordOverlap > 0 ||
    (!askedForLooks && (hit.withinBudget === true || hit.sizeInStock === true));
  const alternatives = hits
    .filter((hit) => !matchIds.has(hit.product.id) && related(hit) && inStockSizes(hit.product).length > 0)
    .slice(0, Math.max(0, Math.min(3, limit)));
  return { filters, matches, alternatives };
}

export type CatalogOverview = {
  totalProducts: number;
  categories: { name: string; count: number }[];
  newest: CatalogItem[];
};

export function browseCatalog(items: readonly CatalogItem[], category?: string, limit = 5): CatalogOverview & { inCategory: CatalogItem[] } {
  const available = items.filter((item) => inStockSizes(item).length > 0);
  const counts = new Map<string, number>();
  for (const item of available) counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
  const newest = [...available].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  const inCategory = category ? searchCatalog(available, { category }, limit).matches.map((hit) => hit.product) : [];
  return {
    totalProducts: available.length,
    categories: [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
    newest,
    inCategory,
  };
}

// A budget needs a qualifier ("under 3000", "3000 tak", "Rs 3000 se kam"); a bare "Rs 100" or "100%" is not one.
const PRICE_PATTERN =
  /\b(?:under|below|less than|max|upto|up to|within|budget)\s*(?:of\s*)?(?:rs\.?|pkr)?\s*(\d[\d,]{2,})|\b(?:rs\.?|pkr)\s*(\d[\d,]{2,})\s*(?:tak|se kam|ke andar|ke under|under|max)\b|\b(\d[\d,]{2,})\s*(?:rs|pkr|rupees?|rupay|rupaye)?\s*(?:tak|se kam|ke andar|ke under|under|max)\b/i;

// Size mentions, most explicit first. A lone lowercase "m" is Roman Urdu for "in" ("Lahore m delivery"),
// so single letters count only in capitals ("L hai?") or next to the word "size".
const SIZE_PATTERNS = [
  /\bsize\s*[:\-]?\s*(xxs|xs|s|m|l|xl|xxl|xxxl|\d{1,2})\b/i,
  /\b(xxs|xs|s|m|l|xl|xxl|xxxl)\s*size\b/i,
  /(?<![\p{L}\p{N}'’])(xxs|xs|xl|xxl|xxxl|small|medium|large|extra large|free size)(?![\p{L}\p{N}'’])/iu,
  /(?<![\p{L}\p{N}'’])(S|M|L)(?![\p{L}\p{N}'’])/u,
  /\b(\d{2})\s*(?:no|number)\b/i,
];

function findSize(text: string): string | undefined {
  for (const pattern of SIZE_PATTERNS) {
    const value = text.match(pattern)?.[1];
    if (value) return value;
  }
  return undefined;
}

// Deterministic first pass over the customer's words: no AI needed to know "laal kameez M" means
// colour=red, category=shirt, size=M. The agent can refine with its own search if this misses.
export function extractFilters(text: string): SearchFilters {
  const tokens = tokenize(text);
  const filters: SearchFilters = {};
  for (const token of tokens) {
    filters.color ??= colorOf(token);
    // The garment is usually the last noun ("dress shirt", "lawn ka jora", "red kurta").
    filters.category = categoryOf(token) ?? filters.category;
  }
  const sizeValue = findSize(text);
  if (sizeValue) filters.size = normalizeSize(sizeValue);
  const price = text.match(PRICE_PATTERN);
  const priceValue = price?.[1] ?? price?.[2] ?? price?.[3];
  if (priceValue) filters.maxPrice = Number(priceValue.replace(/,/g, ""));
  const words = tokens.filter((token) => !isStopWord(token) && !colorOf(token) && !categoryOf(token) && !/^\d+$/.test(token));
  if (words.length) filters.text = words.join(" ");
  // Fabric words are useful free text too ("lawn", "khaddar").
  if (!filters.text) {
    const fabrics = tokens.filter((token) => fabricOf(token));
    if (fabrics.length) filters.text = fabrics.join(" ");
  }
  return filters;
}

export function hasProductIntent(filters: SearchFilters): boolean {
  return Boolean(filters.category || filters.color || filters.size || filters.maxPrice || filters.text);
}

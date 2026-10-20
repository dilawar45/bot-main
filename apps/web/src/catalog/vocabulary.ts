// Shop vocabulary: how Pakistani customers write colours and garments (English, Roman Urdu, Urdu script).
// Every surface word maps to one English concept so "laal kameez", "سرخ قمیض" and "red shirt" search alike.

type ConceptTable = Record<string, readonly string[]>;

export const COLOR_CONCEPTS: ConceptTable = {
  red: ["red", "laal", "lal", "surkh", "لال", "سرخ"],
  maroon: ["maroon", "burgundy", "wine", "crimson", "mehroon"],
  black: ["black", "kala", "kaala", "kali", "kaali", "siyah", "کالا", "کالی", "سیاہ"],
  white: ["white", "safaid", "safed", "sufaid", "sufed", "سفید"],
  offwhite: ["offwhite", "cream", "ivory", "beige", "fawn", "skin"],
  blue: ["blue", "neela", "nila", "neeli", "nili", "نیلا", "نیلی"],
  navy: ["navy", "navyblue"],
  skyblue: ["sky", "skyblue", "aasmani", "asmani", "turquoise", "firozi", "feroza", "teal"],
  green: ["green", "hara", "hari", "sabz", "ہرا", "ہری", "سبز", "emerald"],
  olive: ["olive", "mint", "bottlegreen", "seagreen", "zaituni"],
  yellow: ["yellow", "peela", "pila", "peeli", "pili", "zard", "پیلا", "پیلی", "زرد"],
  mustard: ["mustard", "lemon"],
  orange: ["orange", "narangi", "naranji", "rust"],
  pink: ["pink", "gulabi", "گلابی", "peach", "rose", "magenta"],
  purple: ["purple", "jamni", "baingani", "lilac", "lavender", "plum", "mauve", "جامنی"],
  brown: ["brown", "bhura", "bhoora", "camel", "tan", "khaki", "coffee", "بھورا"],
  grey: ["grey", "gray", "surmai", "silver", "ash", "charcoal", "سرمئی"],
  gold: ["gold", "golden", "sunehri", "sunehra", "سنہری"],
  multi: ["multi", "multicolor", "multicolour", "printed", "rangeen"],
};

// Colour families, so "no red, but here's maroon" works as a close alternative.
export const COLOR_FAMILIES: readonly (readonly string[])[] = [
  ["red", "maroon", "pink", "orange"],
  ["blue", "navy", "skyblue"],
  ["green", "olive"],
  ["white", "offwhite"],
  ["black", "grey"],
  ["yellow", "mustard", "gold", "orange"],
  ["brown", "offwhite", "orange"],
  ["purple", "pink"],
];

export const CATEGORY_CONCEPTS: ConceptTable = {
  shirt: ["shirt", "shirts", "qameez", "kameez", "kamees", "qamees", "qamiz", "top", "tops", "قمیض", "شرٹ"],
  kurta: ["kurta", "kurtas", "kurti", "kurtis", "kurtay", "kurtey", "kurte", "کرتا", "کرتی"],
  tshirt: ["tshirt", "tshirts", "tee", "polo"],
  suit: ["suit", "suits", "jora", "joda", "jorra", "jore", "joray", "2piece", "3piece", "جوڑا", "سوٹ"],
  shalwar: ["shalwar", "salwar", "shalwaar", "trouser", "trousers", "pant", "pants", "pajama", "pyjama", "capri", "شلوار", "ٹراؤزر"],
  dupatta: ["dupatta", "duppata", "dopatta", "chunri", "chunni", "scarf", "stole", "shawl", "دوپٹہ", "شال"],
  shoes: ["shoes", "shoe", "joota", "joote", "jootay", "juta", "sandal", "sandals", "chappal", "chappals", "khussa", "heels", "sneakers", "جوتا", "جوتے"],
  abaya: ["abaya", "abayas", "burqa", "burka", "hijab", "عبایا", "برقع"],
  frock: ["frock", "frocks", "maxi", "gown", "dress", "dresses", "فراک"],
  lehenga: ["lehenga", "lehnga", "lengha", "sharara", "gharara", "لہنگا"],
  waistcoat: ["waistcoat", "koti", "vest"],
  jacket: ["jacket", "jackets", "coat", "hoodie", "sweater", "jersey"],
  // Not "bache/bachay": in chat that means "left in stock" ("kitne bachay hain").
  kids: ["kids", "kid", "baby", "bachon", "children"],
};

// Garments customers use interchangeably ("shirt" for a kameez or kurta top).
export const CATEGORY_FAMILIES: readonly (readonly string[])[] = [
  ["shirt", "kurta", "tshirt"],
  ["suit", "kurta", "shirt"],
  ["frock", "lehenga"],
  ["abaya", "dupatta"],
];

export const FABRIC_CONCEPTS: ConceptTable = {
  lawn: ["lawn", "لان"],
  cotton: ["cotton", "sooti", "suti", "khaddar", "khadar", "khaddi"],
  chiffon: ["chiffon", "shiffon"],
  silk: ["silk", "resham", "reshmi", "raw silk"],
  linen: ["linen", "lenin"],
  wool: ["wool", "woolen", "woollen", "oon", "karandi"],
  velvet: ["velvet", "makhmal"],
  denim: ["denim", "jeans"],
};

// Words that carry no product meaning in chat ("bhai, apke paas ... hai?").
const STOP_WORD_LIST = [
  "a", "an", "the", "is", "are", "am", "do", "does", "you", "your", "have", "has", "any", "some", "show", "me", "i", "want",
  "need", "please", "pls", "plz", "for", "of", "in", "on", "with", "and", "or", "to", "it", "this", "that", "what", "which",
  "available", "availabe", "avail", "stock", "size", "sizes", "price", "rate", "much", "how", "can", "get", "send", "pic", "pics",
  "hai", "ha", "hain", "hy", "he", "ho", "hoga", "hogi", "ka", "ki", "ke", "ko", "mein", "me", "mai", "main", "se", "sy", "koi",
  "kuch", "kya", "kia", "aap", "ap", "apke", "apka", "apki", "aapke", "aapka", "paas", "pas", "pass", "chahiye", "chahye",
  "chaiye", "dikhao", "dikha", "dikhayen", "bhejo", "bhej", "dein", "do", "de", "abhi", "yr", "yar", "yaar", "bhai", "bro",
  "brother", "sis", "sister", "sir", "madam", "maam", "ji", "jee", "g", "hy", "wala", "wali", "walay", "wale", "bhi", "b",
  "mujhe", "muje", "mjhe", "hum", "humein", "hume", "ye", "yeh", "wo", "woh", "or", "aur", "ya", "acha", "achha", "ok", "okay",
  "کیا", "ہے", "ہیں", "کا", "کی", "کے", "میں", "سے", "آپ", "پاس", "کوئی", "چاہیے", "دکھائیں", "بھائی",
  // Greetings, small talk and chat verbs: never product words.
  "hi", "hii", "hello", "helo", "hey", "hy", "salam", "salaam", "slam", "assalam", "asalam", "alaikum", "alaykum", "aoa", "walaikum",
  "wsalam", "how", "kaise", "kese", "kaisay", "haal", "hal", "theek", "thik", "fine", "good", "morning", "evening", "night",
  "thanks", "thank", "shukriya", "shukria", "jazakallah", "who", "kon", "kaun", "call", "phone", "number", "baat", "bat", "krni",
  "karni", "karna", "krna", "karo", "kro", "sakta", "sakti", "sakte", "hon", "hoon", "hun", "yes", "no", "haan", "han", "nahi",
  "nhi", "nai", "ok", "okay", "okk", "done", "please", "zaroor", "bata", "batao", "btao", "bataen", "info", "detail", "details",
  "السلام", "علیکم", "شکریہ", "کون", "بات", "کال",
  "pe", "par", "py", "per", "tak", "kam", "under", "below", "max", "upto", "budget", "rs", "pkr", "rupees", "rupee", "rupay",
  "rupaye", "andar", "less", "than", "around", "about",
  // Sizes are read separately; they are not product words.
  "xxs", "xs", "s", "m", "l", "xl", "xxl", "xxxl", "small", "medium", "large", "extra", "free",
];

const lookup = (table: ConceptTable): Map<string, string> => {
  const map = new Map<string, string>();
  for (const [concept, words] of Object.entries(table)) for (const word of words) map.set(normalizeText(word), concept);
  return map;
};


// Lowercase, strip accents and punctuation, keep Urdu letters and digits.
export function normalizeText(value: string): string {
  return (
    value
      // NFKD splits Urdu letters like ئ ؤ آ into base + mark; dropping all marks keeps words whole.
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/(\d)\s*(pc|piece)s?\b/g, "$1piece")
      .replace(/t[\s-]?shirts?/g, "tshirt")
      .replace(/off[\s-]?white/g, "offwhite")
      .replace(/navy[\s-]?blue/g, "navyblue")
      .replace(/(?:sky|baby)[\s-]?blue/g, "skyblue")
      // "baby pink" is a shade, not a kids' item.
      .replace(/baby[\s-]?pink/g, "pink")
      .replace(/(bottle|sea)[\s-]?green/g, "$1green")
      .replace(/multi[\s-]?colou?r/g, "multicolor")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim()
  );
}

// Built after normalizeText exists so Urdu entries are normalized exactly like customer text.
export const STOP_WORDS = new Set(STOP_WORD_LIST.map(normalizeText));

const COLOR_LOOKUP = lookup(COLOR_CONCEPTS);
const CATEGORY_LOOKUP = lookup(CATEGORY_CONCEPTS);
const FABRIC_LOOKUP = lookup(FABRIC_CONCEPTS);


export function tokenize(value: string): string[] {
  const normalized = normalizeText(value);
  return normalized ? normalized.split(" ") : [];
}

// Light plural/spelling folding for Roman Urdu and English ("kurtas" -> "kurta", "shirtss" -> "shirt").
function fold(token: string): string {
  return token.replace(/(.)\1+$/, "$1").replace(/(?<=\w{3})(es|s)$/, "");
}

function conceptOf(token: string, table: Map<string, string>): string | undefined {
  return table.get(token) ?? table.get(fold(token));
}

export const colorOf = (token: string) => conceptOf(token, COLOR_LOOKUP);
export const categoryOf = (token: string) => conceptOf(token, CATEGORY_LOOKUP);
export const fabricOf = (token: string) => conceptOf(token, FABRIC_LOOKUP);

export function sameFamily(families: readonly (readonly string[])[], a: string, b: string): boolean {
  return a !== b && families.some((family) => family.includes(a) && family.includes(b));
}

export function isStopWord(token: string): boolean {
  return STOP_WORDS.has(token) || STOP_WORDS.has(fold(token));
}

// Canonical form used for free-text overlap: concepts collapse synonyms, other words are folded.
export function canonicalToken(token: string): string {
  return colorOf(token) ?? categoryOf(token) ?? fabricOf(token) ?? fold(token);
}

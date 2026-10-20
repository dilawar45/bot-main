import type { Language } from "@huzaifa/contracts";
import { hasProductIntent, type CatalogItem, type CatalogOverview, type SearchFilters, type SearchResult } from "../catalog/search";
import type { ShopStatus } from "../shop/settings";
import { refFor, type DraftReply, type ProductRefs } from "./compose";

// Rule-based replies for when Gemini is unavailable. Still never dead-ends: greets small talk,
// shows matches or the closest items, and otherwise lists what the shop has with one question.

const ROMAN_URDU_WORDS =
  /^(kya|kia|hai|ha|hain|hy|mujhe|muje|mjhe|chahiye|chahye|dikhao|dikha|rang|qeemat|keemat|kitne|kitna|mein|aap|apke|apka|paas|koi|kuch|bhai|yaar|yr|acha|theek|thik|nahi|nhi|haan|kaise|kese|ho|hoga|wala|wali|abhi|kab|kahan|kyun|krni|karni|baat|bata|batao|salam|assalam|shukriya|jazakallah|laal|kala|kaala|neela|hara|safaid|kameez|jora|sahi|bilkul|zaroor|raha|rahi|karo|kro|dein|lena|leni|hoon|ka|ki|ke|ko|se|ji|jee|aur|lekin|magar|bohat|bahut|sirf|yeh|ye|woh|wo|bhi|dekhein|dekh|lein|mil|jayega|jayegi|karein|karen|kijiye|chahta|chahti|wala|wale|kar|kardo|kardein|lunga|lungi|lena|dena|rehne|milega|milegi|chahie|dikhayen|dikhaen|bhejo|kitni|bataen|bataein|batayen)$/i;

export function detectLanguage(text: string, fallback: Language = "en"): Language {
  if (/[؀-ۿ]/.test(text)) return "ur";
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  if (words.length === 0) return fallback;
  const urduish = words.filter((word) => ROMAN_URDU_WORDS.test(word)).length;
  // One stray match in a long English sentence isn't Roman Urdu; short messages need just one.
  return urduish >= 2 || (urduish === 1 && urduish / words.length >= 0.25) ? "roman_ur" : "en";
}

// The message's language when it shows clearly; undefined for "ok", "L?", "Hii brother" and the like,
// which should be answered in the language of the chat so far.
export function clearLanguage(text: string): Language | undefined {
  const language = detectLanguage(text);
  if (language !== "en") return language;
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  // Product words dilute Roman Urdu ("red maroon kurta dikhao"): any Roman Urdu word means it isn't clearly English.
  if (words.some((word) => ROMAN_URDU_WORDS.test(word))) return undefined;
  // Names and addresses ("Ali Raza, House 12 Street 4 Gulberg") aren't English sentences: real English has
  // a couple of its small words ("do you have", "is the").
  return words.filter((word) => ENGLISH_WORDS.has(word)).length >= 2 ? "en" : undefined;
}

const ENGLISH_WORDS = new Set(
  "a an the is are was were be do does did have has had can could will would should i you we they he she it my your our me us this that these those what which who when where why how please want need like any some there here of in on for with and or but not no yes to from at by about".split(" "),
);

// \b doesn't work after Urdu letters, so the end is an explicit "not a letter or digit".
const GREETING = /^(?:hi+|hello+|hey+|helo|hy|salam|salaam|slam|assalam|asalam|aoa|a\.o\.a|السلام|good\s*(?:morning|evening|afternoon))(?![\p{L}\p{N}])/iu;
const SMALL_TALK = /\b(how are you|kaise ho|kese ho|kya haal|kia haal|hal chal|thanks|thank you|shukriya|shukria|jazakallah|ok|okay|theek|acha)\b|شکریہ|کیسے ہیں/i;
const WHO_ARE_YOU = /\b(who are you|who r u|are you (?:a )?(?:bot|robot|human|real)|is this a bot|kon ho|kaun ho|aap kon|ap kon|bot ho|robot)\b|کون ہیں|کون ہو/i;
const BROWSE = /\b(kya available|kia available|what do you have|what you have|collection|new arrivals?|naya|nayi|kya kya|what's available|whats available|show me|catalog|catalogue|kya hai aap ke paas|kya mil)\b/i;

export type FallbackInput = {
  text: string;
  language: Language;
  firstContact: boolean;
  hasPhoto: boolean;
  wantsHuman: boolean;
  handoffAlreadyPending: boolean;
  status: ShopStatus;
  filters: SearchFilters;
  search: SearchResult | null;
  overview: CatalogOverview;
  refs: ProductRefs;
  // Ref of the product under discussion (the one last shown), if any.
  focusRef?: string;
  // A clear best match by meaning for words the keyword search didn't know.
  similarRef?: string;
  // A product whose photo is a near-identical match for the customer's photo (nobody checked it by eye).
  photoRef?: string;
  // The customer has been waiting a long time (the bot was offline when they wrote).
  late?: boolean;
};

type Lines = Record<Language, string>;
const pick = (lines: Lines, language: Language) => lines[language];

function disclosure(language: Language): string {
  return pick(
    {
      en: "(I'm the shop's automated assistant — type \"human\" anytime to reach a person.)",
      roman_ur: "(Main shop ka automated assistant hoon — kisi insaan se baat karni ho to \"human\" likh dein.)",
      ur: "(میں دکان کا خودکار اسسٹنٹ ہوں — کسی انسان سے بات کرنی ہو تو \"انسان\" لکھ دیں۔)",
    },
    language,
  );
}

function handoffLine(input: FallbackInput): string {
  const { language, status } = input;
  if (input.handoffAlreadyPending) {
    return pick(
      {
        en: "Our team already has your request and will reply here soon. Meanwhile I'm happy to help.",
        roman_ur: "Hamari team ko aap ka message mil chuka hai, wo jald yahin reply karenge. Tab tak main madad kar sakta hoon.",
        ur: "ہماری ٹیم کو آپ کا پیغام مل چکا ہے، وہ جلد یہیں جواب دیں گے۔ تب تک میں مدد کر سکتا ہوں۔",
      },
      language,
    );
  }
  if (!status.open) {
    return pick(
      {
        en: `I've let our team know. The shop is closed right now (${status.hoursLabel}), so they'll get back to you ${status.nextOpenLabel}.`,
        roman_ur: `Maine team ko bata diya hai. Shop abhi band hai (timing ${status.hoursLabel}), wo ${status.nextOpenLabel?.replace("today at", "aaj").replace("tomorrow at", "kal").replace("next working day at", "agle working din")} ke baad aap se rabta karenge.`,
        ur: `میں نے ٹیم کو بتا دیا ہے۔ دکان ابھی بند ہے (اوقات ${status.hoursLabel})، وہ کھلنے کے بعد آپ سے رابطہ کریں گے۔`,
      },
      language,
    );
  }
  return pick(
    {
      en: "Sure — I've told our team, someone will get back to you here shortly.",
      roman_ur: "Ji zaroor — maine team ko bata diya hai, koi jald yahin aap se baat karega.",
      ur: "جی ضرور — میں نے ٹیم کو بتا دیا ہے، کوئی جلد یہیں آپ سے بات کرے گا۔",
    },
    language,
  );
}

function categoriesLine(overview: CatalogOverview): string {
  return overview.categories.slice(0, 5).map((entry) => entry.name).join(", ");
}

function cardsFrom(items: readonly CatalogItem[], refs: ProductRefs): string[] {
  return items.slice(0, 3).map((item) => refFor(refs, item));
}

export function fallbackDraft(input: FallbackInput): DraftReply {
  const { language, overview, search } = input;
  const messages: string[] = [];
  let showProducts: string[] = [];
  const categories = categoriesLine(overview);

  if (input.wantsHuman) {
    messages.push(handoffLine(input));
  } else if (WHO_ARE_YOU.test(input.text)) {
    messages.push(
      pick(
        {
          en: "I'm the shop's assistant (automated) — I can show you what's in stock, prices and sizes. What are you looking for?",
          roman_ur: "Main shop ka assistant hoon (automated) — stock, qeemat aur sizes bata sakta hoon. Aap kya dhoond rahe hain?",
          ur: "میں دکان کا اسسٹنٹ ہوں (خودکار) — اسٹاک، قیمت اور سائز بتا سکتا ہوں۔ آپ کیا ڈھونڈ رہے ہیں؟",
        },
        language,
      ),
    );
  } else if (input.photoRef) {
    // Asked, never claimed: without the model nobody compared the photos.
    showProducts = [input.photoRef];
    messages.push(pick({ en: "Is it this one? 👇", roman_ur: "Kya ye wala hai? 👇", ur: "کیا یہ والا ہے؟ 👇" }, language));
  } else if (input.focusRef && input.filters.size && !input.filters.category && !input.filters.color) {
    // "M hai is mein?" asks about the product already shown, not the whole catalog.
    messages.push(`{{size:${input.focusRef}:${input.filters.size}}}.`);
    messages.push(pick({ en: "Should I check another size or design for you?", roman_ur: "Koi aur size ya design dekhna ho to bata dein.", ur: "کوئی اور سائز یا ڈیزائن دیکھنا ہو تو بتا دیں۔" }, language));
  } else if (search && search.matches.length) {
    showProducts = cardsFrom(search.matches.map((hit) => hit.product), input.refs);
    const size = input.filters.size;
    const sizeNotes = size ? showProducts.map((ref) => `{{product:${ref}}}: {{size:${ref}:${size}}}`).join("\n") : "";
    messages.push(pick({ en: "Here's what we have 👇", roman_ur: "Ji, ye dekhein 👇", ur: "جی، یہ دیکھیں 👇" }, language));
    if (sizeNotes) messages.push(sizeNotes);
    messages.push(pick({ en: "Which one do you like?", roman_ur: "Koi pasand aye to bata dein.", ur: "کوئی پسند آئے تو بتا دیں۔" }, language));
  } else if (input.similarRef && !input.filters.color && !input.filters.category) {
    // A word the vocabulary doesn't know ("burqa", "chadar") that clearly means one of our items.
    showProducts = [input.similarRef];
    messages.push(pick({ en: "This looks like what you mean 👇", roman_ur: "Shayad aap ye dhoond rahe hain 👇", ur: "شاید آپ یہ ڈھونڈ رہے ہیں 👇" }, language));
    messages.push(pick({ en: "Is this the one?", roman_ur: "Yehi chahiye?", ur: "یہی چاہیے؟" }, language));
  } else if (search && hasProductIntent(input.filters) && (input.filters.color || input.filters.category)) {
    showProducts = cardsFrom(search.alternatives.map((hit) => hit.product), input.refs);
    // Echo only words we understood; never parrot the customer's whole sentence back as a "product".
    const asked = [input.filters.color, input.filters.category].filter(Boolean).join(" ");
    const overBudget = Boolean(input.filters.maxPrice) && search.alternatives.some((hit) => hit.withinBudget === false && hit.category !== "none" && hit.color !== "none");
    if (showProducts.length && overBudget) {
      messages.push(
        pick(
          {
            en: `Nothing in ${asked} within that budget, but these are close 👇`,
            roman_ur: `Is budget mein ${asked} nahi hai, lekin ye dekh lein 👇`,
            ur: `اس بجٹ میں ${asked} نہیں، لیکن یہ دیکھ لیں 👇`,
          },
          language,
        ),
      );
      messages.push(pick({ en: "Any of these work for you?", roman_ur: "Inmein se koi pasand aye?", ur: "ان میں سے کوئی پسند آئے؟" }, language));
    } else if (showProducts.length) {
      messages.push(
        pick(
          {
            en: `Sorry, ${asked} isn't available right now. These are the closest 👇`,
            roman_ur: `Sorry, ${asked} abhi available nahi hai. Ye milti julti hain 👇`,
            ur: `معذرت، ${asked} ابھی دستیاب نہیں۔ یہ ملتی جلتی ہیں 👇`,
          },
          language,
        ),
      );
      messages.push(pick({ en: "Any of these work for you?", roman_ur: "Inmein se koi pasand aye?", ur: "ان میں سے کوئی پسند آئے؟" }, language));
    } else {
      messages.push(
        pick(
          {
            en: `Sorry, we don't have ${asked} right now.${categories ? ` We do have: ${categories}.` : ""} What else can I show you?`,
            roman_ur: `Sorry, ${asked} abhi nahi hai.${categories ? ` Hamare paas ${categories} hain.` : ""} Kya dikhaun?`,
            ur: `معذرت، ${asked} ابھی نہیں ہے۔${categories ? ` ہمارے پاس ${categories} ہیں۔` : ""} کیا دکھاؤں؟`,
          },
          language,
        ),
      );
    }
  } else if (BROWSE.test(input.text) || input.hasPhoto) {
    // A photo with a caption like "ye available hai?" gets the photo reply too, not "I didn't get that".
    showProducts = cardsFrom(overview.newest, input.refs);
    messages.push(
      input.hasPhoto
        ? pick(
            {
              en: "Thanks for the photo! Here are some of our latest pieces 👇 Tell me the colour or item you want and I'll find the closest.",
              roman_ur: "Photo ka shukriya! Ye hamari latest items hain 👇 Rang ya item bata dein, main milti julti dhoond deta hoon.",
              ur: "تصویر کا شکریہ! یہ ہماری نئی چیزیں ہیں 👇 رنگ یا چیز بتا دیں، میں ملتی جلتی ڈھونڈ دیتا ہوں۔",
            },
            language,
          )
        : pick(
            {
              en: `We have ${categories || "a few new pieces"}. Here are the latest 👇`,
              roman_ur: `Hamare paas ${categories || "kuch naye items"} hain. Ye latest dekhein 👇`,
              ur: `ہمارے پاس ${categories || "کچھ نئی چیزیں"} ہیں۔ یہ تازہ ترین دیکھیں 👇`,
            },
            language,
          ),
    );
    messages.push(pick({ en: "What are you looking for?", roman_ur: "Aap ko kya chahiye?", ur: "آپ کو کیا چاہیے؟" }, language));
  } else if (input.handoffAlreadyPending && !BROWSE.test(input.text)) {
    // Waiting for the team: reassure rather than guess at what they meant.
    messages.push(handoffLine(input));
  } else if (GREETING.test(input.text.trim()) || SMALL_TALK.test(input.text)) {
    messages.push(
      pick(
        {
          en: "Hello! Hope you're doing well 😊 What are you looking for today?",
          roman_ur: "Walaikum assalam! Umeed hai aap theek hain 😊 Bataen, kya dhoond rahe hain?",
          ur: "وعلیکم السلام! امید ہے آپ خیریت سے ہیں 😊 بتائیں، کیا ڈھونڈ رہے ہیں؟",
        },
        language,
      ),
    );
  } else {
    messages.push(
      pick(
        {
          en: `I didn't quite get that.${categories ? ` We have ${categories}.` : ""} Tell me the item, colour or size you want?`,
          roman_ur: `Main samjha nahi.${categories ? ` Hamare paas ${categories} hain.` : ""} Item, rang ya size bata dein?`,
          ur: `میں سمجھا نہیں۔${categories ? ` ہمارے پاس ${categories} ہیں۔` : ""} چیز، رنگ یا سائز بتا دیں؟`,
        },
        language,
      ),
    );
  }

  if (input.late) {
    messages[0] = `${pick({ en: "Sorry for the late reply!", roman_ur: "Maazrat, jawab mein der ho gayi.", ur: "معذرت، جواب میں دیر ہو گئی۔" }, language)} ${messages[0]}`;
  }
  // Mentioned once, after the actual answer, so the reply still opens like a person would.
  if (input.firstContact && !input.wantsHuman) messages[0] = `${messages[0]}\n\n${disclosure(language)}`;
  return { language, messages: messages.slice(0, 3), showProducts };
}

import { imageMimeFromPath } from "./manifest";
import { normalizeCode, parseProductLine, stripMarks, type SheetRowResult } from "./product-sheet";

// A WhatsApp chat exported with "Export chat → Include media": the chat as text (Android "WhatsApp Chat with
// Shop.txt", iPhone "_chat.txt") with the photos next to it. The shop sends each product's photos with its code as
// the caption ("K12", or the whole "K12 | 3500 | S2 M3 L1 | lawn" line) and one line per product; this reads the
// messages and works out which photos belong to which code, so the export imports as it is.
//
// Only the shop's messages count (whoever sends the product lines): the other side's questions and forwards don't.
// A later line for a code replaces an earlier one (a stock update is the same code with new counts), and every line
// keeps the time it was sent, so the import can tell a new line from one it applied before.

export type PhotoMatch = "caption" | "same batch" | "before its line" | "after its line";
export type ChatPhoto = { file: string; via: PhotoMatch };

export type ChatImport = {
  // The latest line per code, in the order the products first came up; a product keeps the code's first spelling.
  rows: SheetRowResult[];
  // Photos (paths relative to the chat's folder) by codeKey, in the order they were sent: the first is the main one.
  photos: Map<string, ChatPhoto[]>;
  // When each row's line (by SKU) and each photo (by path) was sent; null when the date can't be read.
  lineTimes: Map<string, Date | null>;
  photoTimes: Map<string, Date | null>;
  // The shop's photos that no code claimed.
  unmatched: string[];
  // Photos from the other side of the chat, and stickers: not products.
  skipped: string[];
  stickers: string[];
  notes: string[];
  shop: string | null;
  messages: number;
  firstAt: Date | null;
  lastAt: Date | null;
};

// "K-12", "k12", "#K 12" → "K12": how codes are compared between captions, lines, folders and the shop.
export const codeKey = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");

const DATE = String.raw`(?<d1>\d{1,4})[./-](?<d2>\d{1,2})[./-](?<d3>\d{1,4})`;
// "2:15 pm", "14:15", "2:15:30 PM", "2:15 p. m." (newer phones put a narrow space before pm), or the phone language's words.
const TIME = String.raw`(?<hour>\d{1,2})[:.](?<minute>\d{2})(?:[:.](?<second>\d{2}))?(?<meridiem>(?:\s*[^\s\d\]\-–,][^\]\-–,]{0,14}?)?)`;
const MESSAGE_START = [
  new RegExp(String.raw`^\[${DATE},?\s*${TIME}\]\s*`), // iPhone: "[06/10/2026, 2:15:30 PM] Huzaifa: …"
  new RegExp(String.raw`^\[${TIME},\s*${DATE}\]\s*`), // copied from WhatsApp on a computer: "[2:15 PM, 06/10/2026] Huzaifa: …"
  new RegExp(String.raw`^${DATE},?\s*${TIME}\s+[-–]\s+`), // Android: "06/10/2026, 2:15 pm - Huzaifa: …"
];

type Stamp = { d1: number; d2: number; d3: number; hour: number; minute: number; second: number; meridiem: string };

function readMessageStart(line: string): { stamp: Stamp; sender: string | null; text: string } | null {
  for (const pattern of MESSAGE_START) {
    const match = pattern.exec(line);
    if (!match?.groups) continue;
    const { d1, d2, d3, hour, minute, second, meridiem } = match.groups;
    const rest = line.slice(match[0].length);
    // "Huzaifa: text"; Android system messages ("Messages and calls are end-to-end encrypted…") have no sender.
    const colon = rest.search(/:(?:\s|$)/);
    const sender = colon > 0 && colon <= 80 ? rest.slice(0, colon).trim() : null;
    return {
      stamp: { d1: Number(d1), d2: Number(d2), d3: Number(d3), hour: Number(hour), minute: Number(minute), second: Number(second ?? 0), meridiem: (meridiem ?? "").trim().toLowerCase() },
      sender,
      text: sender === null ? rest : rest.slice(colon + 1).trimStart(),
    };
  }
  return null;
}

// Phones in Pakistan export local time (UTC+5, no daylight saving).
const KARACHI_OFFSET_MS = 5 * 60 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

function toDate(stamp: Stamp, dayFirst: boolean): Date | null {
  const yearFirst = stamp.d1 > 31;
  const year = yearFirst ? stamp.d1 : stamp.d3 < 100 ? 2000 + stamp.d3 : stamp.d3;
  const [day, month] = yearFirst ? [stamp.d3, stamp.d2] : dayFirst ? [stamp.d1, stamp.d2] : [stamp.d2, stamp.d1];
  let hour = stamp.hour;
  if (/p\.?\s*m|بعد/.test(stamp.meridiem) && hour < 12) hour += 12;
  else if (/a\.?\s*m|قبل/.test(stamp.meridiem) && hour === 12) hour = 0;
  if (month < 1 || month > 12 || day < 1 || hour > 23 || stamp.minute > 59 || stamp.second > 59) return null;
  const local = Date.UTC(year, month - 1, day, hour, stamp.minute, stamp.second);
  if (new Date(local).getUTCDate() !== day) return null; // 31/02
  return new Date(local - KARACHI_OFFSET_MS);
}

// Day/month (Pakistan, UK) or month/day (US)? A part above 12 settles it. When every date reads both ways, the
// reading whose last message is the latest one not after the export wins (an export is made soon after the messages
// it holds); day first on a tie.
function readsDayFirst(stamps: readonly Stamp[], exportedAt: Date): boolean {
  const ordinary = stamps.filter((stamp) => stamp.d1 <= 31);
  if (ordinary.some((stamp) => stamp.d1 > 12)) return true;
  if (ordinary.some((stamp) => stamp.d2 > 12)) return false;
  const latest = (dayFirst: boolean) => stamps.reduce((last, stamp) => Math.max(last, toDate(stamp, dayFirst)?.getTime() ?? -Infinity), -Infinity);
  const [dayFirstLast, monthFirstLast] = [latest(true), latest(false)];
  const limit = exportedAt.getTime() + DAY_MS;
  if (monthFirstLast > limit) return true;
  if (dayFirstLast > limit) return false;
  return dayFirstLast >= monthFirstLast;
}

// Android: the message's first line is the file, "IMG-20261006-WA0001.jpg (file attached)", and the caption is on the
// lines after it. iPhone: "<attached: 00000012-PHOTO-2026-10-06-14-15-30.jpg>" ends the message, after the caption
// ("K12 | 3500 | S2 <attached: …>"). The words follow the phone's language ("(archivo adjunto)", "<Anhang: …>",
// "<… eklendi>"), so only the shape is matched, and only a photo in the export (or a photo's name) counts.
const ANDROID_ATTACHMENT = /^(\S.*?\.[A-Za-z0-9]{2,5})\s+\([^()]{1,40}\)\s*$/;
const BRACKETED = /<([^<>]{1,300})>/g;
// "<Media omitted>" (Android, in any language) or "image omitted" (iPhone): exported without media.
const OMITTED = /^<[^<>:]{1,40}>$|\bomitted$/i;
const isSticker = (path: string) => /(?:^|[\\/])STK-|-STICKER-/i.test(path);

// The message's photo (the file in the export, or null when it's missing from it) and its caption lines.
function findAttachment(lines: readonly string[], resolveFile: (name: string) => string | null): { file: string | null; caption: { at: number; text: string }[] } | null {
  const android = ANDROID_ATTACHMENT.exec(lines[0]!.trim());
  if (android) {
    const file = resolveFile(android[1]!);
    if (file || imageMimeFromPath(android[1]!)) return { file, caption: lines.slice(1).map((text, at) => ({ at: at + 1, text })) };
  }
  for (const [index, line] of lines.entries()) {
    for (const match of line.matchAll(BRACKETED)) {
      const content = match[1]!.trim();
      // "attached: name" or "name eklendi"
      const names = [content.replace(/^[^:：]*[:：]\s*/, ""), content.replace(/\s+\S+$/, ""), content];
      const file = names.map(resolveFile).find(Boolean) ?? null;
      if (!file && !names.some((name) => imageMimeFromPath(name))) continue;
      return { file, caption: lines.map((text, at) => ({ at, text: at === index ? text.replace(match[0], "") : text })) };
    }
  }
  return null;
}

// Urdu and Arabic phones may write ۰۱۲… or ٠١٢… for 012….
const latinDigits = (text: string) => text.replace(/[٠-٩۰-۹]/g, (digit) => String(digit.charCodeAt(0) & 0xf));
// iPhones may write names decomposed (NFD); file names are compared composed and ignoring case.
const fileKey = (name: string) => name.trim().normalize("NFC").toLowerCase();

// The codes a caption mentions, compared like codeKey: "k-12 maroon" and "#K 12" mention K12; "K120", "AK12" and
// "K1 2" don't. Letters and digits written apart are read together only where letters meet digits.
function mentionedKeys(caption: string, known: ReadonlySet<string>): string[] {
  const runs = caption.toUpperCase().match(/[A-Z0-9]+/g) ?? [];
  const found = new Set<string>();
  runs.forEach((_, start) => {
    let candidate = "";
    for (let at = start; at < Math.min(runs.length, start + 4); at += 1) {
      const next = runs[at]!;
      if (candidate && /\d$/.test(candidate) === /^\d/.test(next)) break;
      candidate += next;
      if (known.has(candidate)) found.add(candidate);
    }
  });
  return [...found];
}

// A caption that is only a code nobody has sent a line for yet ("K15", "Code: K15"), not a price ("Rs 3500",
// "3500" unless the shop's codes are numbers) or a size ("M2").
function loneCode(caption: string, numericCodes: boolean): string | null {
  const lone = caption
    .trim()
    .replace(/^(?:code|design|article|item)\s*(?:no\.?)?\s*[:#.-]?\s*/i, "")
    .replace(/^#/, "");
  if (!/^[a-z]{0,4}[\s-]?\d{1,6}[a-z]?$/i.test(lone)) return null;
  if (/^(?:rs|pkr|qty|size)(?![a-z])/i.test(lone) || /^(?:xxl|xl|xs|s|m|l)[\s-]?\d$/i.test(lone)) return null;
  if (/^\d+$/.test(lone) && !numericCodes) return null;
  return normalizeCode(lone.replace(/\s+/g, "")) ? codeKey(lone) : null;
}

// Two dated messages at the start of the text: a chat, not a sheet.
export function looksLikeChat(text: string): boolean {
  let starts = 0;
  for (const line of latinDigits(stripMarks(text.slice(0, 20_000))).split(/\r?\n/, 200)) {
    if (readMessageStart(line) && ++starts >= 2) return true;
  }
  return false;
}

// Photos sent within this long after a captioned photo, with no line in between, belong to the same product.
const BATCH_GAP_MS = 10 * 60 * 1_000;

type PhotoItem = { kind: "photo"; file: string; message: number; at: Date | null; key: string | null; ownLine: boolean };
type LineItem = { kind: "line"; key: string; message: number; at: Date | null };

// Null when the text isn't a WhatsApp chat (fewer than two dated messages).
export function readChatExport(text: string, images: readonly string[], exportedAt: Date): ChatImport | null {
  type Message = { stamp: Stamp; sender: string | null; body: { text: string; line: number }[] };
  const messages: Message[] = [];
  latinDigits(stripMarks(text).normalize("NFC"))
    .split(/\r?\n/)
    .forEach((raw, index) => {
      const start = readMessageStart(raw);
      if (start) messages.push({ stamp: start.stamp, sender: start.sender, body: [{ text: start.text, line: index + 1 }] });
      else messages.at(-1)?.body.push({ text: raw, line: index + 1 });
    });
  if (messages.length < 2) return null;

  const dayFirst = readsDayFirst(
    messages.map((message) => message.stamp),
    exportedAt,
  );
  const times = messages.map((message) => toDate(message.stamp, dayFirst));

  // The folder's photos by file name (the one nearest the chat when two share a name).
  const byName = new Map<string, string>();
  for (const path of [...images].sort((a, b) => a.split(/[\\/]/).length - b.split(/[\\/]/).length)) {
    const name = fileKey(path.split(/[\\/]/).at(-1)!);
    if (!byName.has(name)) byName.set(name, path);
  }
  const resolveFile = (name: string) => byName.get(fileKey(name)) ?? null;

  // Each message's photo, if any, and its text lines (a photo's caption).
  let missing = 0;
  let omitted = 0;
  const stickers: string[] = [];
  const parsed = messages.map((message) => {
    const attachment = findAttachment(
      message.body.map((line) => line.text),
      resolveFile,
    );
    const file = attachment?.file ?? null;
    if (attachment && !file) missing += 1;
    if (!attachment && OMITTED.test(message.body[0]!.text.trim())) omitted += 1;
    if (file && isSticker(file)) stickers.push(file);
    const lines = attachment ? attachment.caption.map(({ at, text: caption }) => ({ text: caption, line: message.body[at]!.line })) : message.body;
    return { photo: file && !isSticker(file) ? file : null, lines: lines.filter((line) => line.text.trim()) };
  });

  const allLines = parsed.flatMap((message, index) =>
    message.lines.flatMap(({ text: lineText, line }) => {
      const result = parseProductLine(lineText, line);
      return result ? [{ result, key: codeKey(skuOf(result)), message: index, text: lineText.trim() }] : [];
    }),
  );

  // The shop is whoever sends the most product lines; the other side's lines, captions and photos are left out.
  const linesBySender = new Map<string, number>();
  for (const line of allLines) {
    const sender = messages[line.message]!.sender;
    if (line.result.ok && sender !== null) linesBySender.set(sender, (linesBySender.get(sender) ?? 0) + 1);
  }
  const shop = [...linesBySender].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const fromShop = (message: number) => shop === null || messages[message]!.sender === shop;
  // A line that fails to read still names a product when its code has a digit ("K15 | price? | M2"); "Lawn |
  // Chiffon | Cotton" or a "Code | Price | Sizes" header doesn't.
  const productLines = allLines.filter((line) => fromShop(line.message) && line.key && (line.result.ok || /\d/.test(line.key)));
  const known = new Set(productLines.map((line) => line.key));
  const numericCodes = [...known].some((key) => /^\d+$/.test(key));
  const linesByMessage = Map.groupBy(productLines, (line) => line.message);

  const items: (PhotoItem | LineItem)[] = [];
  const skipped: string[] = [];
  const others = new Set<string>();
  const withLines = new Set(allLines.filter((line) => line.result.ok).map((line) => line.message));
  parsed.forEach((message, index) => {
    if (!fromShop(index)) {
      if (message.photo) skipped.push(message.photo);
      if (message.photo || withLines.has(index)) others.add(messages[index]!.sender ?? "?");
      return;
    }
    const own = linesByMessage.get(index) ?? [];
    const base = { message: index, at: times[index] ?? null };
    if (message.photo) {
      const caption = message.lines.map((line) => line.text).join("\n");
      const mentioned = mentionedKeys(caption, known);
      const key = own[0]?.key ?? (mentioned.length === 1 ? mentioned[0]! : mentioned.length ? null : loneCode(caption, numericCodes));
      items.push({ kind: "photo", file: message.photo, key, ownLine: own.length > 0, ...base });
    }
    for (const line of own) items.push({ kind: "line", key: line.key, ...base });
  });

  // Captioned photos, and the photos sent with them (a few minutes apart, no line in between).
  const assigned = new Map<string, { key: string; via: PhotoMatch }>();
  const free: number[] = [];
  let batch: { key: string; message: number; at: number | null } | null = null;
  items.forEach((item, index) => {
    if (item.kind === "line") {
      if (batch && item.message !== batch.message) batch = null;
      return;
    }
    const at = item.at?.getTime() ?? null;
    if (item.key) {
      assigned.set(item.file, { key: item.key, via: "caption" });
      batch = { key: item.key, message: item.message, at };
    } else if (batch && (at === null || batch.at === null || at - batch.at <= BATCH_GAP_MS)) {
      assigned.set(item.file, { key: batch.key, via: "same batch" });
      batch.at = at ?? batch.at;
    } else {
      free.push(index);
      batch = null;
    }
  });

  // The rest come in runs between lines; a run belongs to the line after it ("photos, then the line", as the shop
  // is asked to send them) or the one before it, whichever this chat does.
  const runs: number[][] = [];
  for (const index of free) {
    const run = runs.at(-1);
    if (run && run.at(-1) === index - 1) run.push(index);
    else runs.push([index]);
  }
  // A product's first line can claim the photos next to it, unless the product has captioned photos already; a later
  // line (a stock update) never does.
  const firstLine = new Map<string, number>();
  items.forEach((item, index) => {
    if (item.kind === "line" && !firstLine.has(item.key)) firstLine.set(item.key, index);
  });
  const captioned = new Set([...assigned.values()].map((match) => match.key));
  // The code next to a run of photos. Lines sent one after another with no photo between can't share out the photos
  // next to them when more than one of them could claim them.
  const side = (index: number, step: 1 | -1): { key: string | null; byLine: boolean; crowded: string[] | null } => {
    const item = items[index];
    if (!item) return { key: null, byLine: false, crowded: null };
    if (item.kind === "photo") return { key: assigned.get(item.file)?.key ?? null, byLine: false, crowded: null };
    const claimants = new Set<string>();
    for (let at = index; items[at]?.kind === "line"; at += step) {
      const line = items[at] as LineItem;
      if (firstLine.get(line.key) === at && !captioned.has(line.key)) claimants.add(line.key);
    }
    if (claimants.size > 1) return { key: null, byLine: true, crowded: [...claimants] };
    return { key: [...claimants][0] ?? item.key, byLine: true, crowded: null };
  };
  const edges = runs.map((run) => ({ run, before: side(run[0]! - 1, -1), after: side(run.at(-1)! + 1, 1) }));

  // Which way this chat goes: a photo captioned with its code, sent right before or right after its own line (not a
  // stock update days later). Otherwise, the way that leaves fewer photos without a code.
  let photosFirst = 0;
  let lineFirst = 0;
  items.forEach((item, index) => {
    if (item.kind !== "photo" || !item.key || item.ownLine) return;
    const sameProduct = (other: PhotoItem | LineItem | undefined) => other?.kind === "photo" && assigned.get(other.file)?.key === item.key;
    let after = index + 1;
    while (sameProduct(items[after])) after += 1;
    let before = index - 1;
    while (sameProduct(items[before])) before -= 1;
    const next = items[after];
    const previous = items[before];
    if (next?.kind === "line" && next.key === item.key) photosFirst += 1;
    else if (previous?.kind === "line" && previous.key === item.key) lineFirst += 1;
  });
  const lost = (pick: "before" | "after") => edges.reduce((sum, edge) => sum + (edge[pick].key && !edge[pick].crowded ? 0 : edge.run.length), 0);
  const tied = photosFirst === lineFirst;
  const lineAfter = tied ? lost("after") <= lost("before") : photosFirst > lineFirst;

  const notes: string[] = [];
  const unmatched: string[] = [];
  let byLine = 0;
  for (const { run, before, after } of edges) {
    const pick = lineAfter ? after : before;
    const files = run.map((index) => (items[index] as PhotoItem).file);
    if (pick.key && !pick.crowded) {
      const via: PhotoMatch = !pick.byLine ? "same batch" : lineAfter ? "before its line" : "after its line";
      for (const file of files) assigned.set(file, { key: pick.key, via });
      if (pick.byLine) byLine += files.length;
      continue;
    }
    unmatched.push(...files);
    if (pick.crowded) notes.push(`${plural(files.length, "photo")} next to ${pick.crowded.join(", ")} can't be split between them: send each product's first photo with its code as the caption.`);
  }
  if (byLine && tied && lost("after") === lost("before")) notes.push("Photos without a code in the caption went to the line sent after them; the chat doesn't show the order for sure, so check the preview.");
  else if (byLine && !lineAfter) notes.push("Photos without a code in the caption went to the line sent before them (this chat sends the line first).");

  const photos = new Map<string, ChatPhoto[]>();
  const photoTimes = new Map<string, Date | null>();
  for (const item of items) {
    if (item.kind !== "photo") continue;
    photoTimes.set(item.file, item.at);
    const match = assigned.get(item.file);
    if (match) photos.set(match.key, [...(photos.get(match.key) ?? []), { file: item.file, via: match.via }]);
  }

  // The latest line per code wins (a stock update is the same code with new counts); products stay in the order
  // they first came up, under the code's first spelling ("K12", not a later "K 12").
  const latest = new Map<string, (typeof productLines)[number]>();
  const firstSku = new Map<string, string>();
  const repeated = new Set<string>();
  for (const line of productLines) {
    // Some phones repeat an album's caption on a second photo: the same line again isn't an update.
    if (latest.has(line.key) && latest.get(line.key)!.text !== line.text) repeated.add(line.key);
    latest.set(line.key, line);
    if (line.result.ok && !firstSku.has(line.key)) firstSku.set(line.key, line.result.row.sku);
  }
  const rows: SheetRowResult[] = [];
  const lineTimes = new Map<string, Date | null>();
  for (const line of latest.values()) {
    if (!line.result.ok) {
      rows.push(line.result);
      continue;
    }
    const sku = firstSku.get(line.key) ?? line.result.row.sku;
    rows.push({ ok: true, row: { ...line.result.row, sku } });
    lineTimes.set(sku, times[line.message] ?? null);
  }
  if (repeated.size) notes.push(`More than one line for ${[...repeated].map((key) => firstSku.get(key) ?? key).join(", ")} (stock updates): the latest is used.`);
  if (omitted) notes.push(`${plural(omitted, "photo")} left out of this export: choose "Include media" when exporting, from a phone that has the photos downloaded.`);
  if (missing) notes.push(`${plural(missing, "photo")} named in the chat ${missing === 1 ? "isn't" : "aren't"} in the folder.`);
  const otherLines = allLines.filter((line) => !fromShop(line.message) && line.result.ok).length;
  if (skipped.length || otherLines) {
    const what = [skipped.length && plural(skipped.length, "photo"), otherLines && plural(otherLines, "product line")].filter(Boolean).join(" and ");
    notes.push(`${what} from ${[...others].join(", ")} skipped: only ${shop ?? "the shop"}'s messages are used.`);
  }
  // Lines with a "|" that don't read and have no digit in the code ("Lawn | Chiffon | Cotton") are chat, not products.
  const chatter = allLines.filter((line) => fromShop(line.message) && !line.result.ok && !(line.key && /\d/.test(line.key)));
  if (chatter.length) notes.push(`Not read as products (no code with a number): line ${chatter.slice(0, 5).map((line) => (line.result.ok ? line.result.row.line : line.result.line)).join(", ")}${chatter.length > 5 ? "…" : ""}.`);
  if (times.every((time) => time === null)) notes.push("The message dates couldn't be read, so products already in the shop keep their stock.");

  const dated = times.filter((time): time is Date => time !== null);
  return {
    rows,
    photos,
    lineTimes,
    photoTimes,
    unmatched,
    skipped,
    stickers,
    notes,
    shop,
    messages: messages.length,
    firstAt: dated[0] ?? null,
    lastAt: dated.at(-1) ?? null,
  };
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const skuOf = (result: SheetRowResult) => (result.ok ? result.row.sku : result.sku);

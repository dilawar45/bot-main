import { describe, expect, it } from "vitest";
import { codeKey, readChatExport, type ChatImport } from "./chat-export";

const exportedAt = new Date("2026-10-06T14:00:00Z");
const android = (time: string, sender: string, text: string) => `06/10/2026, ${time} - ${sender}: ${text}`;
const photo = (number: number) => `IMG-20261006-WA${String(number).padStart(4, "0")}.jpg`;
const attached = (number: number) => `${photo(number)} (file attached)`;
const photos = (result: ChatImport, code: string) => (result.photos.get(codeKey(code)) ?? []).map((item) => `${item.file} ${item.via}`);
const skus = (result: ChatImport) => result.rows.map((row) => (row.ok ? row.row.sku : `error: ${row.error}`));

describe("readChatExport", () => {
  it("reads an Android export: captioned photos, the photos sent with them, and photos sent before their line", () => {
    const chat = [
      "06/10/2026, 2:10 pm - Messages and calls are end-to-end encrypted. Only people in this chat can read them.",
      android("2:14 pm", "Ali", "Assalam o alaikum, naye products bhej dein"),
      android("2:15 pm", "Huzaifa", attached(1)),
      "K12",
      android("2:15 pm", "Huzaifa", attached(2)),
      android("2:16 pm", "Huzaifa", "K12 | 3500 | S2 M3 L1 | lawn, 3 piece"),
      android("2:20 pm", "Huzaifa", attached(3)),
      android("2:20 pm", "Huzaifa", attached(4)),
      android("2:21 pm", "Huzaifa", "K13 | 2200 | Free 5"),
      android("2:22 pm", "Ali", attached(5)),
      "ye wala bhi hai?",
      android("2:23 pm", "Huzaifa", "STK-20261006-WA0006.webp (file attached)"),
    ].join("\n");
    const result = readChatExport(chat, [1, 2, 3, 4, 5].map(photo).concat("STK-20261006-WA0006.webp"), exportedAt)!;

    expect(skus(result)).toEqual(["K12", "K13"]);
    expect(photos(result, "K12")).toEqual([`${photo(1)} caption`, `${photo(2)} same batch`]);
    expect(photos(result, "K13")).toEqual([`${photo(3)} before its line`, `${photo(4)} before its line`]);
    expect(result.skipped).toEqual([photo(5)]);
    expect(result.stickers).toEqual(["STK-20261006-WA0006.webp"]);
    expect(result.unmatched).toEqual([]);
    expect(result.shop).toBe("Huzaifa");
    expect(result.notes).toEqual(["1 photo from Ali skipped: only Huzaifa's messages are used."]);
    // 2:16 pm in Pakistan is 09:16 UTC.
    expect(result.lineTimes.get("K12")?.toISOString()).toBe("2026-10-06T09:16:00.000Z");
    expect(result.photoTimes.get(photo(3))?.toISOString()).toBe("2026-10-06T09:20:00.000Z");
    expect(result.messages).toBe(10);
  });

  it("reads an iPhone export, where the caption comes before the attachment and may run over several lines", () => {
    const iphone = (time: string, text: string) => `‎[06/10/2026, ${time}] Huzaifa: ${text}`;
    const file = (number: number) => `000000${number}-PHOTO-2026-10-06-14-15-30.jpg`;
    const chat = [
      "[06/10/2026, 2:10:00 PM] Huzaifa: ‎Messages and calls are end-to-end encrypted.",
      iphone("2:15:30 PM", `K14 | 1800 | M2 L1 | khaddar ‎<attached: ${file(12)}>`),
      iphone("2:15:31 PM", `‎<attached: ${file(13)}>`),
      iphone("2:15:32 PM", `‎<attached: ${file(14)}>`),
      iphone("2:20:05 PM", "K15 | 950 | Free 3"),
      `silk dupatta ‎<attached: ${file(15)}>`,
      iphone("2:20:06 PM", `‎<attached: ${file(16)}>`),
    ].join("\r\n");
    const files = [12, 13, 14, 15, 16].map(file);
    const result = readChatExport(`﻿${chat}`, files, exportedAt)!;

    expect(skus(result)).toEqual(["K14", "K15"]);
    expect(result.rows[0]).toMatchObject({ ok: true, row: { fields: { pricePkr: "1800", description: "khaddar" } } });
    expect(photos(result, "K14")).toEqual([`${file(12)} caption`, `${file(13)} same batch`, `${file(14)} same batch`]);
    expect(photos(result, "K15")).toEqual([`${file(15)} caption`, `${file(16)} same batch`]);
    expect(result.lineTimes.get("K14")?.toISOString()).toBe("2026-10-06T09:15:30.000Z");
    expect(result.notes).toEqual([]);
  });

  it("reads other phone languages, edited lines, repeated album captions and rupee notes", () => {
    const chat = [
      // Spanish Android: a mark before the file name, "(archivo adjunto)", a. m./p. m.
      "6/10/2026, 2:15 p. m. - Huzaifa: ‎IMG-20261006-WA0001.jpg (archivo adjunto)",
      "K12 | 3500 | S2 M3 L1",
      "6/10/2026, 2:15 p. m. - Huzaifa: ‎IMG-20261006-WA0002.jpg (archivo adjunto)",
      "K12 | 3500 | S2 M3 L1",
      // An edited line, and a note in brackets that isn't a file.
      "6/10/2026, 2:16 p. m. - Huzaifa: K13 | ۲۲۰۰ | M1 <Se editó este mensaje.>",
      "6/10/2026, 2:17 p. m. - Huzaifa: K14 | 1800 | M1 | Rs.1800 (final)",
    ].join("\n");
    const result = readChatExport(chat, [photo(1), photo(2)], exportedAt)!;

    expect(skus(result)).toEqual(["K12", "K13", "K14"]);
    expect(photos(result, "K12")).toEqual([`${photo(1)} caption`, `${photo(2)} caption`]);
    expect(result.rows.map((row) => row.ok && row.row.fields.pricePkr)).toEqual(["3500", "2200", "1800"]);
    expect(result.lineTimes.get("K12")?.toISOString()).toBe("2026-10-06T09:15:00.000Z");
    // The same caption on two photos of one album isn't a stock update.
    expect(result.notes).toEqual([]);
  });

  it("finds photos named in other languages' iPhone markers, and counts photos missing from the export", () => {
    const iphone = (second: number, text: string) => `[06/10/2026, 14:15:${second}] Huzaifa: ${text}`;
    const chat = [
      iphone(10, "K12 ‎<Anhang: 00000001-PHOTO-2026-10-06-14-15-10.jpg>"),
      iphone(11, "‎<00000002-PHOTO-2026-10-06-14-15-11.jpg eklendi>"),
      iphone(12, "‎<attached: 00000003-PHOTO-2026-10-06-14-15-12.jpg>"),
      iphone(13, "K12 | 3500 | S2"),
    ].join("\n");
    const result = readChatExport(chat, ["00000001-PHOTO-2026-10-06-14-15-10.jpg", "00000002-PHOTO-2026-10-06-14-15-11.jpg"], exportedAt)!;

    expect(photos(result, "K12")).toEqual(["00000001-PHOTO-2026-10-06-14-15-10.jpg caption", "00000002-PHOTO-2026-10-06-14-15-11.jpg same batch"]);
    expect(result.notes).toEqual(["1 photo named in the chat isn't in the folder."]);
  });

  it("follows a chat that sends the line first and the photos after it", () => {
    const chat = [
      android("2:15 pm", "Huzaifa", "K12 | 3500 | S2"),
      android("2:15 pm", "Huzaifa", attached(1)),
      android("2:16 pm", "Huzaifa", attached(2)),
      android("2:17 pm", "Huzaifa", "K13 | 2200 | M1"),
      android("2:17 pm", "Huzaifa", attached(3)),
    ].join("\n");
    const result = readChatExport(chat, [1, 2, 3].map(photo), exportedAt)!;

    expect(photos(result, "K12")).toEqual([`${photo(1)} after its line`, `${photo(2)} after its line`]);
    expect(photos(result, "K13")).toEqual([`${photo(3)} after its line`]);
    expect(result.notes).toEqual(["Photos without a code in the caption went to the line sent before them (this chat sends the line first)."]);
  });

  it("won't guess between several lines sent together after a batch of photos", () => {
    const chat = [
      android("2:15 pm", "Huzaifa", attached(1)),
      android("2:15 pm", "Huzaifa", attached(2)),
      android("2:16 pm", "Huzaifa", "K12 | 3500 | S2"),
      "K13 | 2200 | M1",
    ].join("\n");
    const result = readChatExport(chat, [1, 2].map(photo), exportedAt)!;

    expect(skus(result)).toEqual(["K12", "K13"]);
    expect(result.photos.size).toBe(0);
    expect(result.unmatched).toEqual([photo(1), photo(2)]);
    expect(result.notes[0]).toBe("2 photos next to K12, K13 can't be split between them: send each product's first photo with its code as the caption.");
  });

  it("uses the latest line for a code (a stock update) and keeps unparseable lines as errors", () => {
    const chat = [
      android("2:15 pm", "Huzaifa", "K12 | 3500 | S2 M3"),
      android("2:16 pm", "Huzaifa", "K15 | price? | M2"),
      android("5:40 pm", "Huzaifa", "k-12 | 3500 | S0 M1"),
    ].join("\n");
    const result = readChatExport(chat, [], exportedAt)!;

    // In the order the products first came up, each with its latest line, under the code's first spelling.
    expect(skus(result)).toEqual(["K12", 'error: price "price?" isn\'t a whole number of rupees']);
    const update = result.rows[0]!;
    expect(update.ok && update.row.variants.map((variant) => `${variant.sizeLabel}${variant.stockQty}`)).toEqual(["S0", "M1"]);
    expect(result.lineTimes.get("K12")?.toISOString()).toBe("2026-10-06T12:40:00.000Z");
    expect(result.notes).toEqual(["More than one line for K12 (stock updates): the latest is used."]);
  });

  it("keeps photos captioned with a code that has no line, and ends a batch after a long pause", () => {
    const chat = [
      android("2:15 pm", "Huzaifa", attached(1)),
      "#k15",
      android("2:16 pm", "Huzaifa", attached(2)),
      android("2:45 pm", "Huzaifa", attached(3)),
      android("2:46 pm", "Huzaifa", "K16 | 999 | M1"),
    ].join("\n");
    const result = readChatExport(chat, [1, 2, 3].map(photo), exportedAt)!;

    expect(photos(result, "K15")).toEqual([`${photo(1)} caption`, `${photo(2)} same batch`]);
    expect(photos(result, "K16")).toEqual([`${photo(3)} before its line`]);
  });

  it("says when the chat was exported without media", () => {
    const chat = [android("2:15 pm", "Huzaifa", "<Media omitted>"), "K12", android("2:16 pm", "Huzaifa", "K12 | 3500 | S2")].join("\n");
    const result = readChatExport(chat, [], exportedAt)!;
    expect(result.notes).toEqual(['1 photo left out of this export: choose "Include media" when exporting, from a phone that has the photos downloaded.']);
  });

  it("reads month-first dates when a day above 12 or the export date says so", () => {
    const us = (date: string, text: string) => `${date}, 2:15 PM - Huzaifa: ${text}`;
    const decided = readChatExport([us("10/5/26", "K1 | 100 | M1"), us("10/13/26", "K2 | 100 | M1")].join("\n"), [], new Date("2026-10-14T00:00:00Z"))!;
    expect(decided.lineTimes.get("K1")?.toISOString()).toBe("2026-10-05T09:15:00.000Z");

    // "10/6/26" reads as 10 June or 6 October; an export made on 6 October means 6 October.
    const guessed = readChatExport([us("10/6/26", "K1 | 100 | M1"), us("10/6/26", "K2 | 100 | M1")].join("\n"), [], exportedAt)!;
    expect(guessed.lineTimes.get("K1")?.toISOString()).toBe("2026-10-06T09:15:00.000Z");
    const pakistani = readChatExport([android("2:15 pm", "Huzaifa", "K1 | 100 | M1"), android("2:16 pm", "Huzaifa", "K2 | 100 | M1")].join("\n"), [], exportedAt)!;
    expect(pakistani.lineTimes.get("K1")?.toISOString()).toBe("2026-10-06T09:15:00.000Z");
  });

  it("isn't thrown off by a stock update days later when telling which way the chat goes", () => {
    const day = (date: string, time: string, text: string) => `${date}, ${time} - Huzaifa: ${text}`;
    const chat = [
      day("06/10/2026", "2:15 pm", attached(1)),
      "K12 | 3500 | S2 M3 L1",
      day("06/10/2026", "2:15 pm", attached(2)),
      day("07/10/2026", "11:00 am", "K12 | 3500 | S1 M3 L1"),
      day("07/10/2026", "11:05 am", "K14 | 1800 | M2"),
      day("07/10/2026", "11:05 am", attached(5)),
      day("07/10/2026", "11:06 am", attached(6)),
      day("07/10/2026", "11:20 am", "K15 | 1500 | L1"),
      day("07/10/2026", "11:20 am", attached(7)),
    ].join("\n");
    const result = readChatExport(chat, [1, 2, 5, 6, 7].map(photo), new Date("2026-10-07T12:00:00Z"))!;

    expect(photos(result, "K12")).toEqual([`${photo(1)} caption`, `${photo(2)} same batch`]);
    expect(photos(result, "K14")).toEqual([`${photo(5)} after its line`, `${photo(6)} after its line`]);
    expect(photos(result, "K15")).toEqual([`${photo(7)} after its line`]);
  });

  it("leaves out the other side's lines, captions and photos, so a forwarded old line can't undo a stock update", () => {
    const chat = [
      android("2:15 pm", "Huzaifa", attached(1)),
      "K12 | 3500 | S2 M3 L1",
      android("5:00 pm", "Huzaifa", "K12 | 3500 | S0 M1 L1"),
      android("6:00 pm", "Ali", attached(2)),
      "K12 ka ye rang bhi hai?",
      android("6:01 pm", "Ali", attached(3)),
      android("6:02 pm", "Ali", "K12 | 3500 | S2 M3 L1"),
      android("6:05 pm", "Huzaifa", "K13 | 2200 | M1"),
    ].join("\n");
    const result = readChatExport(chat, [1, 2, 3].map(photo), exportedAt)!;

    expect(result.shop).toBe("Huzaifa");
    const k12 = result.rows[0]!;
    expect(k12.ok && k12.row.variants.map((variant) => `${variant.sizeLabel}${variant.stockQty}`)).toEqual(["S0", "M1", "L1"]);
    expect(photos(result, "K12")).toEqual([`${photo(1)} caption`]);
    expect(result.photos.has("K13")).toBe(false);
    expect(result.skipped).toEqual([photo(2), photo(3)]);
    expect(result.notes).toContain("2 photos and 1 product line from Ali skipped: only Huzaifa's messages are used.");
  });

  it("doesn't take a list of fabrics, a header or a price for codes", () => {
    const chat = [
      android("2:10 pm", "Huzaifa", "Code | Price | Sizes"),
      android("2:11 pm", "Huzaifa", "Lawn | Chiffon | Cotton sab available hai"),
      android("2:15 pm", "Huzaifa", attached(1)),
      "K12 lawn 3 piece",
      android("2:16 pm", "Huzaifa", "K12 | 3500 | S2 M3 L1"),
      android("2:20 pm", "Huzaifa", attached(2)),
      "Rs 2200",
      android("2:20 pm", "Huzaifa", attached(3)),
      "2200",
      android("2:21 pm", "Huzaifa", "K13 | 2200 | M1"),
    ].join("\n");
    const result = readChatExport(chat, [1, 2, 3].map(photo), exportedAt)!;

    expect(skus(result)).toEqual(["K12", "K13"]);
    expect(photos(result, "K12")).toEqual([`${photo(1)} caption`]);
    expect(photos(result, "K13")).toEqual([`${photo(2)} before its line`, `${photo(3)} before its line`]);
    expect(result.notes).toEqual(["Not read as products (no code with a number): line 1, 2."]);
  });

  it("isn't a chat without dated messages", () => {
    expect(readChatExport("K12 | 3500 | S2 M3 L1\nK13 | 2200 | Free 5", [], exportedAt)).toBeNull();
  });
});

// Chat memory for the agent: recent turns (so "aur koi colour?" or "pehle wala" make sense),
// the long-term summary, and which products this customer has already been shown.

export type StoredMessage = {
  id: string;
  direction: "inbound" | "outbound";
  source: "customer" | "agent" | "human" | "system";
  contentType: "text" | "image";
  text: string | null;
  mediaPath: string | null;
  occurredAt: string;
};

export type HistoryLine = { role: "customer" | "assistant" | "owner"; text: string };

// Support alerts written before they were tagged as "system" messages.
const LEGACY_ALERT = /^Customer wants to talk to a person/;
const PRODUCT_PATH = /^products\/([0-9a-f-]{36})\//;

export function historyFromMessages(messages: readonly StoredMessage[], excludeId?: string): HistoryLine[] {
  const lines: HistoryLine[] = [];
  for (const message of messages) {
    if (message.id === excludeId || message.source === "system") continue;
    const text = message.text?.trim() ?? "";
    if (LEGACY_ALERT.test(text)) continue;
    if (message.direction === "inbound") {
      lines.push({ role: "customer", text: message.contentType === "image" ? `[sent a photo]${text ? ` ${text}` : ""}` : text });
    } else if (message.source === "human") {
      lines.push({ role: "owner", text: text || "[sent a photo]" });
    } else if (message.contentType === "image") {
      // Product cards: the caption (name/price/sizes) is what the customer saw.
      lines.push({ role: "assistant", text: `[product photo] ${text.replace(/\n+/g, " | ")}` });
    } else if (text) {
      lines.push({ role: "assistant", text });
    }
  }
  return lines;
}

export function shownProductIds(messages: readonly StoredMessage[]): string[] {
  const ids: string[] = [];
  for (const message of messages) {
    const id = message.direction === "outbound" ? message.mediaPath?.match(PRODUCT_PATH)?.[1] : undefined;
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

// A product without a photo is sent as a text card: "*Name*\nPrice: …" (compose.ts productCaption).
const TEXT_CARD = /^\*([^*\n]{1,160})\*\n(?:Price|Qeemat|قیمت):/;

// Products whose card (photo or text) went out in the bot's last `turns` replies, newest first.
export function recentCardProductIds(messages: readonly StoredMessage[], productIdByName: ReadonlyMap<string, string>, turns = 2): Set<string> {
  const ids = new Set<string>();
  let botTurns = 0;
  let inBotTurn = false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.direction === "inbound") {
      if (inBotTurn && ++botTurns >= turns) break;
      inBotTurn = false;
      continue;
    }
    if (message.source !== "agent") continue;
    inBotTurn = true;
    const photoProduct = message.mediaPath?.match(PRODUCT_PATH)?.[1];
    if (photoProduct) ids.add(photoProduct);
    // Several photo-less products share one text message, separated by a blank line.
    for (const block of (message.text ?? "").split(/\n{2,}/)) {
      const name = block.trim().match(TEXT_CARD)?.[1];
      const id = name ? productIdByName.get(name) : undefined;
      if (id) ids.add(id);
    }
  }
  return ids;
}

const ROLE_LABEL: Record<HistoryLine["role"], string> = { customer: "Customer", assistant: "You", owner: "Shop team member" };

// One chat message stays on one line, and prompt delimiters are removed, so a customer can't forge
// a "Shop team member:" line or close the <customer_message> block from inside their text.
export function flattenUntrusted(text: string): string {
  return text
    .replace(/<\/?\s*customer_message\s*>/gi, " ")
    .replace(/\s*[\r\n]+\s*/g, " / ")
    .trim();
}

// Newest lines win when the chat is long; each line is capped so one essay can't crowd out the rest.
export function formatHistory(lines: readonly HistoryLine[], maxChars = 3_500): string {
  const rendered: string[] = [];
  let used = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    const flat = flattenUntrusted(line.text);
    const text = flat.length > 400 ? `${flat.slice(0, 400)}…` : flat;
    const entry = `${ROLE_LABEL[line.role]}: ${text}`;
    if (used + entry.length > maxChars) break;
    rendered.unshift(entry);
    used += entry.length + 1;
  }
  return rendered.join("\n");
}

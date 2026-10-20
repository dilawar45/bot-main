import { z } from "zod";

const text = (max: number) => z.string().trim().max(max).default("");

// Everything the bot may say about the shop itself. Owner-edited in /admin/shop; empty means "unknown",
// and the bot then promises that a team member will confirm instead of guessing.
export const ShopSettingsSchema = z.object({
  shopName: text(80),
  botName: text(40),
  about: text(800),
  address: text(400),
  // Karachi time, 24h clock. openHour === closeHour means open all day.
  openHour: z.number().int().min(0).max(23).default(11),
  closeHour: z.number().int().min(0).max(24).default(22),
  closedDays: z.array(z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"])).max(7).default([]),
  delivery: text(1200),
  payment: text(800),
  returns: text(800),
  otherFaq: text(3000),
  toneNotes: text(1200),
  // Pasted real chats between the owner and customers; the strongest signal for sounding like the shop.
  exampleChats: text(12_000),
  // The bot takes orders in the chat (items, name, phone, address), shows a priced summary and hands the
  // confirmed order to the owner. Off: it hands buyers to the team instead.
  ordersEnabled: z.boolean().default(true),
  // Flat delivery charge added to order summaries; null = "the team confirms delivery charges".
  deliveryFeePkr: z.number().int().min(0).max(100_000).nullable().default(null),
  // Orders with items worth at least this much ship free; null = no free-delivery threshold.
  freeDeliveryFromPkr: z.number().int().min(0).max(10_000_000).nullable().default(null),
  // One reminder to a customer who saw the priced summary but didn't confirm, this many minutes later
  // (only during opening hours, within a day of their last message). null = never remind.
  cartReminderMinutes: z.number().int().min(15).max(24 * 60).nullable().default(60),
  // WhatsApp notes to the owner about carts that went quiet and placed orders still waiting for confirmation.
  ownerFollowUps: z.boolean().default(true),
});
export type ShopSettings = z.infer<typeof ShopSettingsSchema>;

export const DEFAULT_SHOP_SETTINGS: ShopSettings = ShopSettingsSchema.parse({
  shopName: "Huzaifa Collection",
  botName: "",
});

export function parseShopSettings(value: unknown): ShopSettings {
  const parsed = ShopSettingsSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_SHOP_SETTINGS;
}

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

// Pakistan has no daylight saving time: local = UTC + 5.
export function karachiTime(now: Date): { day: (typeof DAY_KEYS)[number]; hour: number; minute: number; label: string } {
  const local = new Date(now.getTime() + 5 * 60 * 60 * 1_000);
  const hour = local.getUTCHours();
  const minute = local.getUTCMinutes();
  const label = `${DAY_KEYS[local.getUTCDay()]} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  return { day: DAY_KEYS[local.getUTCDay()]!, hour, minute, label };
}

// Midnight in Pakistan (UTC+5, no daylight saving), as an instant.
export function karachiDayStart(now: Date): Date {
  const local = new Date(now.getTime() + 5 * 60 * 60 * 1_000);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - 5 * 60 * 60 * 1_000);
}

export type ShopStatus = { open: boolean; nowLabel: string; hoursLabel: string; nextOpenLabel: string | null };

function hourLabel(hour: number): string {
  const normalized = hour % 24;
  const suffix = normalized < 12 ? "am" : "pm";
  const twelve = normalized % 12 === 0 ? 12 : normalized % 12;
  return `${twelve}${suffix}`;
}

export function shopStatus(settings: ShopSettings, now: Date): ShopStatus {
  const { day, hour, label } = karachiTime(now);
  const allDay = settings.openHour === settings.closeHour % 24;
  const withinHours = allDay
    ? true
    : settings.openHour < settings.closeHour
      ? hour >= settings.openHour && hour < settings.closeHour
      : hour >= settings.openHour || hour < settings.closeHour;
  const open = withinHours && !settings.closedDays.includes(day);
  const hoursLabel = allDay ? "24 hours" : `${hourLabel(settings.openHour)} to ${hourLabel(settings.closeHour)}`;
  let nextOpenLabel: string | null = null;
  if (!open) {
    const before = !allDay && hour < settings.openHour && !settings.closedDays.includes(day);
    nextOpenLabel = before ? `today at ${hourLabel(settings.openHour)}` : `${settings.closedDays.length ? "next working day" : "tomorrow"} at ${hourLabel(settings.openHour)}`;
  }
  return { open, nowLabel: label, hoursLabel, nextOpenLabel };
}

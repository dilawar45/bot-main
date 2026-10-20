import { describe, expect, it } from "vitest";
import { DEFAULT_SHOP_SETTINGS, karachiDayStart, parseShopSettings } from "./settings";

describe("shop settings", () => {
  it("starts the day at midnight Pakistan time", () => {
    // 01:30 on Oct 7 in Karachi is still Oct 6 in UTC.
    expect(karachiDayStart(new Date("2026-10-06T20:30:00.000Z")).toISOString()).toBe("2026-10-06T19:00:00.000Z");
    expect(karachiDayStart(new Date("2026-10-06T10:00:00.000Z")).toISOString()).toBe("2026-10-05T19:00:00.000Z");
  });

  it("gives settings saved before follow-ups existed the default reminders", () => {
    const saved = { ...DEFAULT_SHOP_SETTINGS } as Record<string, unknown>;
    delete saved.cartReminderMinutes;
    delete saved.ownerFollowUps;
    expect(parseShopSettings(saved)).toMatchObject({ cartReminderMinutes: 60, ownerFollowUps: true });
    expect(parseShopSettings({ ...DEFAULT_SHOP_SETTINGS, cartReminderMinutes: null }).cartReminderMinutes).toBeNull();
  });
});

"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/auth/admin";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { ShopSettingsSchema } from "@/shop/settings";
import { saveShopSettings } from "@/shop/settings-store";
import type { ActionState } from "../products/actions";

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

// "" → not set; "1,500" / "Rs 1500" → 1500; anything else stays invalid for the schema to report.
function optionalAmount(value: string): number | null {
  const cleaned = value.replace(/rs\.?|pkr|,|\s/gi, "");
  if (!cleaned) return null;
  return /^\d+$/.test(cleaned) ? Number(cleaned) : Number.NaN;
}

export async function saveShopSettingsAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  await requireAdmin();
  const field = (name: string) => String(formData.get(name) ?? "");
  const parsed = ShopSettingsSchema.safeParse({
    shopName: field("shopName"),
    botName: field("botName"),
    about: field("about"),
    address: field("address"),
    openHour: Number(field("openHour")),
    closeHour: Number(field("closeHour")),
    closedDays: DAYS.filter((day) => formData.get(`closed_${day}`) === "on"),
    delivery: field("delivery"),
    payment: field("payment"),
    returns: field("returns"),
    otherFaq: field("otherFaq"),
    toneNotes: field("toneNotes"),
    exampleChats: field("exampleChats"),
    ordersEnabled: formData.get("ordersEnabled") === "on",
    deliveryFeePkr: optionalAmount(field("deliveryFeePkr")),
    freeDeliveryFromPkr: optionalAmount(field("freeDeliveryFromPkr")),
    cartReminderMinutes: field("cartReminderMinutes") ? Number(field("cartReminderMinutes")) : null,
    ownerFollowUps: formData.get("ownerFollowUps") === "on",
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { error: `${issue?.path.join(".") || "Form"}: ${issue?.message ?? "invalid"}` };
  }
  try {
    // Stored in private Storage (service role) after the admin check; no database migration needed.
    await saveShopSettings(createSupabaseServiceClient(), parsed.data);
  } catch (error) {
    console.error("Saving shop settings failed", error);
    return { error: "Could not save. Try again." };
  }
  revalidatePath("/admin/shop");
  return { message: "Saved. The bot uses this from its next message (within a minute)." };
}

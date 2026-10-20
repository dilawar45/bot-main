import type { Language } from "@huzaifa/contracts";

// What the customer receives on WhatsApp when the owner moves their order on in the admin.

export type OrderUpdateKind = "confirmed" | "shipped" | "delivered" | "cancelled";

function firstName(name: string | null): string {
  const first = name?.trim().split(/\s+/)[0];
  return first ? ` ${first}` : "";
}

export function customerUpdateText(kind: OrderUpdateKind, input: { number: number; name: string | null; language: Language; extra?: string }): string {
  const { number, language } = input;
  const name = firstName(input.name);
  const extra = input.extra?.trim().slice(0, 200);
  const texts: Record<OrderUpdateKind, Record<Language, string>> = {
    confirmed: {
      en: `Hi${name}! Your order #${number} is confirmed ✅ We'll dispatch it soon.`,
      roman_ur: `Assalam o Alaikum${name}! Aap ka order #${number} confirm ho gaya hai ✅ Jald dispatch kar diya jayega.`,
      ur: `السلام علیکم${name}! آپ کا آرڈر #${number} کنفرم ہو گیا ہے ✅ جلد روانہ کر دیا جائے گا۔`,
    },
    shipped: {
      en: `Your order #${number} is on its way 🚚${extra ? ` Tracking: ${extra}` : ""}`,
      roman_ur: `Aap ka order #${number} dispatch ho gaya hai 🚚${extra ? ` Tracking: ${extra}` : ""}`,
      ur: `آپ کا آرڈر #${number} روانہ ہو گیا ہے 🚚${extra ? ` ٹریکنگ: ${extra}` : ""}`,
    },
    delivered: {
      en: `Your order #${number} has been delivered. Thank you for shopping with us! 🙏`,
      roman_ur: `Aap ka order #${number} deliver ho gaya hai. Humse shopping ka shukriya! 🙏`,
      ur: `آپ کا آرڈر #${number} پہنچ گیا ہے۔ خریداری کا شکریہ! 🙏`,
    },
    cancelled: {
      en: `Sorry, your order #${number} has been cancelled.${extra ? ` Reason: ${extra}.` : ""} Message us here if you have any questions.`,
      roman_ur: `Maazrat, aap ka order #${number} cancel kar diya gaya hai.${extra ? ` Wajah: ${extra}.` : ""} Koi sawal ho to yahin message karein.`,
      ur: `معذرت، آپ کا آرڈر #${number} منسوخ کر دیا گیا ہے۔${extra ? ` وجہ: ${extra}۔` : ""} کوئی سوال ہو تو یہیں پیغام کریں۔`,
    },
  };
  return texts[kind][language];
}

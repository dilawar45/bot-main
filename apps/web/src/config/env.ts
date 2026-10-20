import { z } from "zod";
import { parseGeminiKeys, parseModelList } from "../ai/gemini";
import { DEFAULT_EMBEDDING_MODEL, DEFAULT_IMAGE_EMBEDDING_MODEL } from "../catalog/semantic";

const ServerEnvironmentSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  GATEWAY_HMAC_SECRET: z.string().min(32),
  // whatsapp-web.js chat ID: country code + number, no "+" or leading 0, e.g. 923001234567@c.us
  SUPPORT_WA_ID: z.string().regex(/^[1-9]\d{7,14}@c\.us$/, "SUPPORT_WA_ID must look like 923001234567@c.us"),
  STORE_CURRENCY: z.literal("PKR").default("PKR"),
});

export type ServerEnvironment = z.infer<typeof ServerEnvironmentSchema>;

const StorageEnvironmentSchema = ServerEnvironmentSchema.pick({
  NEXT_PUBLIC_SUPABASE_URL: true,
  SUPABASE_SERVICE_ROLE_KEY: true,
  GATEWAY_HMAC_SECRET: true,
});
export type StorageEnvironment = z.infer<typeof StorageEnvironmentSchema>;

const AuthEnvironmentSchema = z
  .object({
    NEXT_PUBLIC_SUPABASE_URL: z.url(),
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(20).optional(),
    NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20).optional(),
    ADMIN_EMAIL: z.email(),
  })
  .transform((value, context) => {
    const publicKey = value.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? value.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!publicKey) {
      context.addIssue({ code: "custom", message: "Set NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY or NEXT_PUBLIC_SUPABASE_ANON_KEY." });
      return z.NEVER;
    }
    return { supabaseUrl: value.NEXT_PUBLIC_SUPABASE_URL, supabasePublicKey: publicKey, adminEmail: value.ADMIN_EMAIL };
  });
export type AuthEnvironment = z.infer<typeof AuthEnvironmentSchema>;

export function getAuthEnvironment(): AuthEnvironment {
  return AuthEnvironmentSchema.parse(process.env);
}

export type VisionEnvironment = {
  // GEMINI_API_KEY may hold several comma-separated keys; they are rotated with failover.
  geminiKeys: string[];
  // Summaries, and the last resort for replies: cheapest, fastest.
  fastModel: string;
  // Writes replies and reads photos: the stronger model.
  proModel: string;
  // GEMINI_MODEL_FALLBACKS: extra models tried when the two above are slow or overloaded.
  fallbackModels: string[];
  // Meaning-based product search. Changing it means rebuilding the search index (Products page).
  embeddingModel: string;
  // Photo search: a multimodal embedding model for customers' photos and the shop's product photos. Changing it
  // also means rebuilding the search index.
  imageEmbeddingModel: string;
};

export function getVisionEnvironment(): VisionEnvironment {
  const legacy = process.env.GEMINI_MODEL?.trim() || undefined;
  return {
    geminiKeys: parseGeminiKeys(process.env.GEMINI_API_KEY),
    fastModel: process.env.GEMINI_MODEL_FAST?.trim() || legacy || "gemini-flash-lite-latest",
    proModel: process.env.GEMINI_MODEL_PRO?.trim() || legacy || "gemini-flash-latest",
    fallbackModels: parseModelList(process.env.GEMINI_MODEL_FALLBACKS),
    embeddingModel: process.env.GEMINI_EMBEDDING_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL,
    imageEmbeddingModel: process.env.GEMINI_IMAGE_EMBEDDING_MODEL?.trim() || DEFAULT_IMAGE_EMBEDDING_MODEL,
  };
}

// Public address of this app, for links in the owner's WhatsApp alerts. Vercel provides its production URL.
export function getAppBaseUrl(): string | undefined {
  const explicit = process.env.APP_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  return vercel ? `https://${vercel}` : undefined;
}

const GatewayAdminEnvironmentSchema = z.object({
  GATEWAY_BASE_URL: z.url().optional(),
  GATEWAY_ADMIN_TOKEN: z.string().min(32).optional(),
});
export type GatewayAdminEnvironment = z.infer<typeof GatewayAdminEnvironmentSchema>;

export function getGatewayAdminEnvironment(): GatewayAdminEnvironment {
  return GatewayAdminEnvironmentSchema.parse({
    GATEWAY_BASE_URL: process.env.GATEWAY_BASE_URL || undefined,
    GATEWAY_ADMIN_TOKEN: process.env.GATEWAY_ADMIN_TOKEN || undefined,
  });
}

let cachedEnvironment: ServerEnvironment | undefined;

export function getServerEnvironment(): ServerEnvironment {
  cachedEnvironment ??= ServerEnvironmentSchema.parse(process.env);
  return cachedEnvironment;
}

export function getStorageEnvironment(): StorageEnvironment {
  return StorageEnvironmentSchema.parse(process.env);
}
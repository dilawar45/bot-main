import { z } from "zod";

export const LanguageSchema = z.enum(["en", "ur", "roman_ur"]);
export type Language = z.infer<typeof LanguageSchema>;

export const MessageMediaSchema = z.object({
  objectPath: z.string().min(1).max(512),
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  sizeBytes: z.number().int().positive().max(10 * 1024 * 1024),
  fileName: z.string().min(1).max(180).optional(),
});

export const MediaUploadRequestSchema = z.object({
  messageId: z.string().min(1).max(180),
  chatId: z.string().min(3).max(180),
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  sizeBytes: z.number().int().positive().max(10 * 1024 * 1024),
  fileName: z.string().min(1).max(180).optional(),
});
export type MediaUploadRequest = z.infer<typeof MediaUploadRequestSchema>;

export const MediaUploadGrantSchema = z.object({
  bucket: z.literal("inbound-media"),
  objectPath: z.string().min(1).max(512),
  signedUrl: z.url().refine((url) => url.startsWith("https://"), "Signed URL must use HTTPS"),
  expiresAt: z.string().datetime({ offset: true }),
});
export type MediaUploadGrant = z.infer<typeof MediaUploadGrantSchema>;

export const InboundMessageSchema = z
  .object({
    eventId: z.string().min(1).max(180),
    messageId: z.string().min(1).max(180),
    chatId: z.string().min(3).max(180),
    displayName: z.string().max(180).optional(),
    // Real number (digits) when WhatsApp exposes it; chatId can be a privacy "@lid" id.
    phoneNumber: z.string().regex(/^[0-9]{6,15}$/).optional(),
    occurredAt: z.string().datetime({ offset: true }),
    type: z.enum(["text", "image"]),
    text: z.string().max(4_000).optional(),
    media: MessageMediaSchema.optional(),
  })
  .superRefine((message, context) => {
    if (message.type === "text" && !message.text?.trim()) {
      context.addIssue({ code: "custom", message: "Text messages require text", path: ["text"] });
    }
    if (message.type === "image" && !message.media) {
      context.addIssue({ code: "custom", message: "Image messages require media", path: ["media"] });
    }
  });
export type InboundMessage = z.infer<typeof InboundMessageSchema>;

const OutboundBaseSchema = z.object({
  actionId: z.uuid(),
  recipientChatId: z.string().min(3).max(180),
});

export const OutboundActionSchema = z.discriminatedUnion("type", [
  OutboundBaseSchema.extend({ type: z.literal("text"), text: z.string().min(1).max(4_000) }),
  OutboundBaseSchema.extend({
    type: z.literal("image"),
    objectPath: z.string().min(1).max(512),
    caption: z.string().max(1_000).optional(),
    // Public HTTPS URL of a catalog photo the gateway downloads and sends. Only product-images URLs are accepted.
    url: z.url().refine((url) => url.startsWith("https://"), "Media URL must use HTTPS").optional(),
  }),
]);
export type OutboundAction = z.infer<typeof OutboundActionSchema>;

export const BrainResponseSchema = z.object({
  eventId: z.string().min(1),
  duplicate: z.boolean().default(false),
  // Up to 3 short texts + 3 product photos + 1 support alert, with headroom.
  actions: z.array(OutboundActionSchema).max(8),
});
export type BrainResponse = z.infer<typeof BrainResponseSchema>;

// A message the shop owner typed on the bot's own WhatsApp (phone or linked device).
// The brain records it in the chat history and pauses the bot for that chat.
export const OwnerMessageSchema = z.object({
  messageId: z.string().min(1).max(180),
  chatId: z.string().min(3).max(180),
  // Other ids WhatsApp may use for the same customer (privacy "@lid" vs phone "@c.us").
  alternateChatIds: z.array(z.string().min(3).max(180)).max(3).default([]),
  occurredAt: z.string().datetime({ offset: true }),
  type: z.enum(["text", "image"]),
  text: z.string().max(4_000).optional(),
});
export type OwnerMessage = z.infer<typeof OwnerMessageSchema>;

export const OwnerMessageResultSchema = z.object({
  recorded: z.boolean(),
  paused: z.boolean(),
});
export type OwnerMessageResult = z.infer<typeof OwnerMessageResultSchema>;

// The gateway asks every few minutes for follow-ups that are due (order reminders, nudges to the owner).
export const FollowUpRequestSchema = z.object({
  requestedAt: z.string().datetime({ offset: true }),
});
export type FollowUpRequest = z.infer<typeof FollowUpRequestSchema>;

export const FollowUpResponseSchema = z.object({
  // A few customer reminders plus one owner digest and re-sent alerts; more waits for the next round.
  actions: z.array(OutboundActionSchema).max(10),
});
export type FollowUpResponse = z.infer<typeof FollowUpResponseSchema>;

export const DeliveryAcknowledgementSchema = z.object({
  actionId: z.uuid(),
  status: z.enum(["sent", "failed"]),
  providerMessageId: z.string().max(180).optional(),
  errorCode: z.string().max(120).optional(),
});
export type DeliveryAcknowledgement = z.infer<typeof DeliveryAcknowledgementSchema>;

export const DeliveryReportSchema = z.object({
  acknowledgements: z.array(DeliveryAcknowledgementSchema).min(1).max(8),
});
export type DeliveryReport = z.infer<typeof DeliveryReportSchema>;

export const SearchAttributesSchema = z.object({
  query: z.string().max(500).default(""),
  sku: z.string().max(100).optional(),
  category: z.string().max(100).optional(),
  color: z.string().max(100).optional(),
  material: z.string().max(100).optional(),
  style: z.string().max(100).optional(),
  requestedSize: z.string().max(40).optional(),
});

export const AgentClassificationSchema = z.object({
  language: LanguageSchema,
  intent: z.enum(["greeting", "product_search", "product_question", "lead_details", "human_handoff", "other"]),
  attributes: SearchAttributesSchema,
  suppliedLead: z.object({
    name: z.string().max(180).optional(),
    location: z.string().max(240).optional(),
  }),
  handoffRequested: z.boolean(),
  confidence: z.number().min(0).max(1),
});
export type AgentClassification = z.infer<typeof AgentClassificationSchema>;

export const ReplyPlanSchema = z.object({
  language: LanguageSchema,
  kind: z.enum(["greeting", "no_match", "clarify", "product", "handoff", "fallback"]),
  productIds: z.array(z.uuid()).max(3),
  requestedSize: z.string().max(40).optional(),
  safePreface: z.string().max(500).optional(),
  handoffReason: z.string().max(500).optional(),
});
export type ReplyPlan = z.infer<typeof ReplyPlanSchema>;
import { describe, expect, it } from "vitest";
import {
  BrainResponseSchema,
  InboundMessageSchema,
  MediaUploadGrantSchema,
  MediaUploadRequestSchema,
} from "./index.js";

describe("InboundMessageSchema", () => {
  it("accepts a valid text message", () => {
    const result = InboundMessageSchema.safeParse({
      eventId: "evt-1",
      messageId: "wamid-1",
      chatId: "923001234567@c.us",
      occurredAt: "2026-09-28T00:00:00.000Z",
      type: "text",
      text: "Do you have this in medium?",
    });

    expect(result.success).toBe(true);
  });

  it("rejects an image event without uploaded media", () => {
    const result = InboundMessageSchema.safeParse({
      eventId: "evt-2",
      messageId: "wamid-2",
      chatId: "923001234567@c.us",
      occurredAt: "2026-09-28T00:00:00.000Z",
      type: "image",
    });

    expect(result.success).toBe(false);
  });
});

describe("BrainResponseSchema", () => {
  it("limits outbound actions to protect the gateway", () => {
    const actions = Array.from({ length: 9 }, (_, index) => ({
      actionId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      recipientChatId: "923001234567@c.us",
      type: "text",
      text: "Hello",
    }));

    expect(BrainResponseSchema.safeParse({ eventId: "evt-1", actions }).success).toBe(false);
  });
});

describe("media upload contracts", () => {
  it("accepts supported image metadata", () => {
    expect(
      MediaUploadRequestSchema.safeParse({
        messageId: "wamid-image-1",
        chatId: "923001234567@c.us",
        mimeType: "image/webp",
        sizeBytes: 4_096,
        fileName: "product.webp",
      }).success,
    ).toBe(true);
  });

  it("rejects oversized media and insecure grants", () => {
    expect(
      MediaUploadRequestSchema.safeParse({
        messageId: "wamid-image-2",
        chatId: "923001234567@c.us",
        mimeType: "image/jpeg",
        sizeBytes: 10 * 1024 * 1024 + 1,
      }).success,
    ).toBe(false);
    expect(
      MediaUploadGrantSchema.safeParse({
        bucket: "inbound-media",
        objectPath: "2026-09-28/image.jpg",
        signedUrl: "http://example.com/upload",
        expiresAt: "2026-09-28T14:00:00.000Z",
      }).success,
    ).toBe(false);
  });
});
describe("DeliveryReportSchema", () => {
  it("accepts sent and failed acknowledgements and rejects empty reports", async () => {
    const { DeliveryReportSchema } = await import("./index.js");
    expect(
      DeliveryReportSchema.parse({
        acknowledgements: [
          { actionId: "7c3a4f0e-8f7b-4a3e-9f58-7bb1d0a4a111", status: "sent", providerMessageId: "true_923@c.us_ABC" },
          { actionId: "7c3a4f0e-8f7b-4a3e-9f58-7bb1d0a4a112", status: "failed", errorCode: "send_failed" },
        ],
      }).acknowledgements,
    ).toHaveLength(2);
    expect(DeliveryReportSchema.safeParse({ acknowledgements: [] }).success).toBe(false);
  });
});

describe("agent-era contracts", () => {
  it("accepts image actions with an https url and rejects http", async () => {
    const { OutboundActionSchema } = await import("./index.js");
    const base = { actionId: "7c3a4f0e-8f7b-4a3e-9f58-7bb1d0a4a111", recipientChatId: "923001234567@c.us", type: "image", objectPath: "products/x/y.jpg" };
    expect(OutboundActionSchema.safeParse({ ...base, url: "https://p.supabase.co/storage/v1/object/public/product-images/products/x/y.jpg" }).success).toBe(true);
    expect(OutboundActionSchema.safeParse({ ...base, url: "http://p.supabase.co/x.jpg" }).success).toBe(false);
  });

  it("parses owner messages with default alternate ids", async () => {
    const { OwnerMessageSchema } = await import("./index.js");
    const parsed = OwnerMessageSchema.parse({ messageId: "true_x@lid_1", chatId: "98100@lid", occurredAt: "2026-09-29T10:00:00.000Z", type: "text", text: "Ji main call karta hoon" });
    expect(parsed.alternateChatIds).toEqual([]);
  });
});

describe("follow-up contracts", () => {
  it("needs a timestamp in the request and caps the actions in the response", async () => {
    const { FollowUpRequestSchema, FollowUpResponseSchema } = await import("./index.js");
    expect(FollowUpRequestSchema.safeParse({ requestedAt: "2026-10-06T10:00:00.000Z" }).success).toBe(true);
    expect(FollowUpRequestSchema.safeParse({}).success).toBe(false);
    const action = (index: number) => ({ actionId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, recipientChatId: "923001234567@c.us", type: "text", text: "Reminder" });
    expect(FollowUpResponseSchema.safeParse({ actions: [action(1)] }).success).toBe(true);
    expect(FollowUpResponseSchema.safeParse({ actions: Array.from({ length: 11 }, (_, index) => action(index)) }).success).toBe(false);
  });
});

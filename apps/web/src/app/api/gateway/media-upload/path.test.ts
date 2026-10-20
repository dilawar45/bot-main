import { describe, expect, it } from "vitest";
import { createInboundMediaPath } from "./path";

describe("createInboundMediaPath", () => {
  it("creates deterministic paths without exposing chat or message IDs", () => {
    const request = {
      messageId: "message-secret-id",
      chatId: "923001234567@c.us",
      mimeType: "image/jpeg" as const,
      sizeBytes: 1_024,
      fileName: "customer-photo.jpg",
    };
    const first = createInboundMediaPath(request);
    const second = createInboundMediaPath(request);

    expect(first).toBe(second);
    expect(first).toMatch(/^messages\/[a-f0-9]{24}\/[a-f0-9]{32}\.jpg$/);
    expect(first).not.toContain(request.chatId);
    expect(first).not.toContain(request.messageId);
    expect(first).not.toContain(request.fileName);
  });
});
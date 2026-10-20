import {
  BrainResponseSchema,
  DeliveryReportSchema,
  FollowUpResponseSchema,
  MediaUploadGrantSchema,
  OutboundActionSchema,
  OwnerMessageResultSchema,
  OwnerMessageSchema,
  type DeliveryAcknowledgement,
  type FollowUpResponse,
  type InboundMessage,
  type MediaUploadGrant,
  type MediaUploadRequest,
  type OwnerMessage,
  type OwnerMessageResult,
} from "@huzaifa/contracts";
import { z } from "zod";
import { BrainRequestError } from "./retry.js";
import { createGatewaySignature } from "./signature.js";

export type BrainClientOptions = {
  baseUrl: string;
  hmacSecret: string;
  timeoutMs: number;
  fetchImplementation?: typeof fetch;
};

export class BrainClient {
  private readonly fetchImplementation: typeof fetch;

  constructor(private readonly options: BrainClientOptions) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  async processMessage(message: InboundMessage) {
    const response = await this.signedRequest("/api/gateway/messages", message);
    return BrainResponseSchema.parse(await response.json());
  }

  async createMediaUpload(request: MediaUploadRequest): Promise<MediaUploadGrant> {
    const response = await this.signedRequest("/api/gateway/media-upload", request);
    return MediaUploadGrantSchema.parse(await response.json());
  }

  async reportDeliveries(acknowledgements: DeliveryAcknowledgement[]): Promise<void> {
    const report = DeliveryReportSchema.parse({ acknowledgements });
    await this.signedRequest("/api/gateway/deliveries", report);
  }

  // Follow-ups that are due now (order reminders, notes to the owner), already claimed by the brain. Checked one
  // by one: a single malformed action must not cost the round's other claimed follow-ups.
  async fetchFollowUps(): Promise<FollowUpResponse & { invalid: number }> {
    const response = await this.signedRequest("/api/gateway/followups", { requestedAt: new Date().toISOString() });
    const { actions } = FollowUpResponseSchema.extend({ actions: z.array(z.unknown()).max(20) }).parse(await response.json());
    const valid = actions.flatMap((action) => {
      const parsed = OutboundActionSchema.safeParse(action);
      return parsed.success ? [parsed.data] : [];
    });
    return { actions: valid, invalid: actions.length - valid.length };
  }

  // The owner typed in a customer chat; the brain records it and pauses the bot there.
  async reportOwnerMessage(message: OwnerMessage): Promise<OwnerMessageResult> {
    const response = await this.signedRequest("/api/gateway/owner-messages", OwnerMessageSchema.parse(message));
    return OwnerMessageResultSchema.parse(await response.json());
  }

  async uploadMedia(grant: MediaUploadGrant, bytes: Uint8Array, mimeType: MediaUploadRequest["mimeType"]): Promise<void> {
    const uploadUrl = new URL(grant.signedUrl);
    if (uploadUrl.protocol !== "https:" || !uploadUrl.pathname.includes("/storage/v1/object/upload/sign/inbound-media/")) {
      throw new Error("Brain returned an invalid media upload URL");
    }

    const body = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(body).set(bytes);
    const response = await this.fetchImplementation(uploadUrl, {
      method: "PUT",
      headers: {
        "cache-control": "max-age=0",
        "content-type": mimeType,
        "x-upsert": "false",
      },
      body,
      signal: AbortSignal.timeout(this.options.timeoutMs),
    });
    if (!response.ok) throw new BrainRequestError(`Media upload failed with status ${response.status}`, response.status);
  }

  private async signedRequest(path: string, payload: unknown): Promise<Response> {
    const body = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const response = await this.fetchImplementation(`${this.options.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-huzaifa-timestamp": timestamp,
        "x-huzaifa-signature": createGatewaySignature(body, timestamp, this.options.hmacSecret),
      },
      body,
      signal: AbortSignal.timeout(this.options.timeoutMs),
    });

    if (!response.ok) {
      throw new BrainRequestError(`Brain request ${path} failed with status ${response.status}`, response.status);
    }
    return response;
  }
}
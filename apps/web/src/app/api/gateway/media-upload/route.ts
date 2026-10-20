import { readLimitedBody } from "@/security/request-body";
import { createClient } from "@supabase/supabase-js";
import { MediaUploadGrantSchema, MediaUploadRequestSchema } from "@huzaifa/contracts";
import { getStorageEnvironment } from "@/config/env";
import { verifyGatewaySignature } from "@/security/gateway-signature";
import { createInboundMediaPath } from "./path";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const read = await readLimitedBody(request);
  if (!read.ok) return read.response;
  const body = read.body;
  let environment;
  try {
    environment = getStorageEnvironment();
  } catch {
    return Response.json({ error: "Server configuration is invalid" }, { status: 503 });
  }

  if (
    !verifyGatewaySignature({
      body,
      timestamp: request.headers.get("x-huzaifa-timestamp"),
      signature: request.headers.get("x-huzaifa-signature"),
      secret: environment.GATEWAY_HMAC_SECRET,
    })
  ) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsedRequest = MediaUploadRequestSchema.safeParse(payload);
  if (!parsedRequest.success) {
    return Response.json(
      { error: "Invalid media metadata", details: parsedRequest.error.flatten() },
      { status: 400 },
    );
  }

  const objectPath = createInboundMediaPath(parsedRequest.data);
  const supabase = createClient(environment.NEXT_PUBLIC_SUPABASE_URL, environment.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await supabase.storage
    .from("inbound-media")
    .createSignedUploadUrl(objectPath, { upsert: false });

  if (error) {
    console.error("Media upload grant failed", { messageId: parsedRequest.data.messageId, error });
    return Response.json({ error: "Could not create media upload grant" }, { status: 500 });
  }

  const grant = MediaUploadGrantSchema.parse({
    bucket: "inbound-media",
    objectPath,
    signedUrl: data.signedUrl,
    expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1_000).toISOString(),
  });
  return Response.json(grant);
}
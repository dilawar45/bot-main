// Gateway payloads are small JSON documents; anything larger is a mistake or abuse.
export const MAX_GATEWAY_BODY_BYTES = 64 * 1024;

export type BodyResult = { ok: true; body: string } | { ok: false; response: Response };

export async function readLimitedBody(request: Request, maxBytes = MAX_GATEWAY_BODY_BYTES): Promise<BodyResult> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maxBytes) return { ok: false, response: Response.json({ error: "Payload too large" }, { status: 413 }) };
  const body = await request.text();
  if (Buffer.byteLength(body) > maxBytes) return { ok: false, response: Response.json({ error: "Payload too large" }, { status: 413 }) };
  return { ok: true, body };
}

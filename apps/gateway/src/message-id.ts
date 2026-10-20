type WidLike = string | { _serialized?: unknown } | null | undefined;

function widToString(value: WidLike): string | undefined {
  if (typeof value === "string") return value || undefined;
  if (value && typeof value._serialized === "string") return value._serialized || undefined;
  return undefined;
}

// Newer WhatsApp Web builds no longer put `_serialized` on message keys, so build it the way WhatsApp does:
// "<fromMe>_<remote>_<id>[_<participant>]".
export function serializeMessageId(id: unknown): string | undefined {
  if (typeof id === "string") return id || undefined;
  if (!id || typeof id !== "object") return undefined;
  const key = id as { _serialized?: unknown; fromMe?: unknown; remote?: WidLike; id?: unknown; participant?: WidLike };
  if (typeof key._serialized === "string" && key._serialized) return key._serialized;
  const remote = widToString(key.remote);
  if (typeof key.id !== "string" || !key.id || !remote) return undefined;
  const participant = widToString(key.participant);
  return `${key.fromMe ? "true" : "false"}_${remote}_${key.id}${participant ? `_${participant}` : ""}`;
}

// "923001234567@c.us" -> "923001234567"; anything else (e.g. "…@lid") -> undefined.
export function phoneFromWid(wid: string | undefined): string | undefined {
  const match = wid?.match(/^(\d{6,15})@c\.us$/);
  return match?.[1];
}

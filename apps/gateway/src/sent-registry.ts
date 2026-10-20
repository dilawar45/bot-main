// WhatsApp echoes every message this account sends ("message_create" with fromMe), including the gateway's
// own replies. Remembering what the gateway just sent keeps those echoes from being mistaken for the owner
// typing in the chat, which would pause the bot for that customer.
export class SentRegistry {
  // "<chatId>\u0000<body>" -> expiry of each send still waiting for its echo (the same text can go out twice).
  private readonly pendingEchoes = new Map<string, number[]>();
  private readonly sentIds = new Map<string, number>();

  constructor(
    private readonly ttlMs = 60_000,
    private readonly maxEntries = 1_000,
    private readonly now: () => number = Date.now,
  ) {}

  // Call before sending: the echo can arrive before the send call returns the message id.
  expect(chatId: string, body: string): void {
    this.prune();
    const key = echoKey(chatId, body);
    this.pendingEchoes.set(key, [...(this.pendingEchoes.get(key) ?? []), this.now() + this.ttlMs]);
    trim(this.pendingEchoes, this.maxEntries);
  }

  remember(id: string): void {
    if (!id) return;
    this.prune();
    this.sentIds.set(id, this.now() + this.ttlMs);
    trim(this.sentIds, this.maxEntries);
  }

  // True for an echo of the gateway's own send. The matching expectation is consumed, so the owner typing
  // the same words afterwards still counts as the owner.
  isOwnSend(id: string | undefined, chatIds: readonly string[], body: string): boolean {
    this.prune();
    for (const chatId of chatIds) {
      const key = echoKey(chatId, body);
      const pending = this.pendingEchoes.get(key);
      if (!pending) continue;
      pending.shift();
      if (!pending.length) this.pendingEchoes.delete(key);
      return true;
    }
    return id !== undefined && this.sentIds.has(id);
  }

  private prune(): void {
    const now = this.now();
    for (const [key, expiries] of this.pendingEchoes) {
      const live = expiries.filter((expiresAt) => expiresAt > now);
      if (!live.length) this.pendingEchoes.delete(key);
      else if (live.length !== expiries.length) this.pendingEchoes.set(key, live);
    }
    for (const [id, expiresAt] of this.sentIds) if (expiresAt <= now) this.sentIds.delete(id);
  }
}

function echoKey(chatId: string, body: string): string {
  return `${chatId}\u0000${body.trim()}`;
}

// Maps iterate in insertion order, so the first keys are the oldest.
function trim(map: Map<string, unknown>, maxEntries: number): void {
  for (const key of map.keys()) {
    if (map.size <= maxEntries) return;
    map.delete(key);
  }
}

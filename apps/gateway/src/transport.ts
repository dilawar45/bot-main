export type GatewayMedia = {
  mimeType: string;
  dataBase64: string;
  fileName?: string;
};

export type TransportMessage = {
  id: string;
  chatId: string;
  displayName?: string;
  // Real phone number (digits) when known; chatId may be a privacy "@lid" id.
  phoneNumber?: string;
  occurredAt: string;
  fromMe: boolean;
  isGroup: boolean;
  text?: string;
  media?: GatewayMedia;
};

export type SessionState = "starting" | "qr_pending" | "authenticated" | "ready" | "disconnected" | "error";

// How the running session is doing. All optional: consumers must keep working with gateways that predate them.
export type SessionHealth = {
  // Last message WhatsApp delivered live from a one-to-one chat (recovered ones don't count): proof messages flow.
  lastInboundAt?: string;
  // Last check that the browser session still answers, and its outcome (absent until the first check).
  lastHealthCheckAt?: string;
  healthy?: boolean;
  // Customer messages WhatsApp never reported live that a catch-up handed over, since the gateway started.
  recoveredMessages?: number;
  // The latest restart the gateway did on its own, and why.
  lastAutoRestartAt?: string;
  lastAutoRestartReason?: string;
  // Messages from contacts saved in the phone that were left alone; only present while that filter is on.
  ignoredSavedContacts?: number;
  // False while the chat list can't be read, so missed messages can't be found (e.g. whatsapp-web.js out of step
  // with WhatsApp Web); absent until the first look.
  missedMessageCheck?: boolean;
};

export type SessionSnapshot = SessionHealth & {
  state: SessionState;
  qrDataUrl?: string;
  detail?: string;
  // Linked account number (digits only) once ready.
  phoneNumber?: string;
  updatedAt?: string;
  reconnectAttempts?: number;
  // 8-character code for "Link with phone number instead", when requested.
  pairingCode?: string;
};

export type MessageHandler = (message: TransportMessage) => Promise<void>;

// Something the shop owner typed into a customer chat from the linked account (phone or another device).
// The gateway's own sends are never reported as owner messages.
export type TransportOwnerMessage = {
  id: string;
  chatId: string;
  // The customer's other WhatsApp id when known: privacy "@lid" <-> "<number>@c.us".
  alternateChatIds: string[];
  occurredAt: string;
  type: "text" | "image";
  text?: string;
};

export type OwnerMessageHandler = (message: TransportOwnerMessage) => Promise<void>;

// Thrown when a send failed before WhatsApp accepted it (not connected, photo download failed), so
// retrying can't produce a duplicate. Any other send error is not retried.
export class NotSentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotSentError";
  }
}

// Provider-neutral boundary: a Meta Cloud API adapter can implement this without touching the processor or brain.
export interface WhatsAppTransport {
  initialize(): Promise<void>;
  destroy(): Promise<void>;
  logout(): Promise<void>;
  reinitialize(): Promise<void>;
  requestPairingCode(phoneNumber: string): Promise<string>;
  onMessage(handler: MessageHandler): void;
  onOwnerMessage(handler: OwnerMessageHandler): void;
  sendText(chatId: string, text: string): Promise<string>;
  // Downloads a public HTTPS image and sends it; resolves to the provider message id ("" when unknown).
  sendImage(chatId: string, url: string, caption?: string): Promise<string>;
  // Best effort "typing…" indicator; never throws.
  setTyping(chatId: string, typing: boolean): Promise<void>;
  getSessionSnapshot(): SessionSnapshot;
}

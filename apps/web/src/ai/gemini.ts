// Minimal Gemini generateContent client for structured (JSON) output.
// Kept free of Next.js/server-only imports so the catalog import CLI can reuse it.

export type GeminiPart = { text: string } | { inline_data: { mime_type: string; data: string } };

// A multi-turn exchange (e.g. model asks for a tool, we answer with tool results). Use instead of `parts`.
export type GeminiTurn = { role: "user" | "model"; parts: GeminiPart[] };

export type GeminiJsonRequest = {
  // One key or several (from separate projects/quotas). Several are rotated, with failover on rate limits.
  apiKey: string | readonly string[];
  model: string;
  // Tried in order when the previous model is slow, overloaded (5xx) or out of quota on every key.
  // Gemini load shifts minute to minute, so a chain of models is far more reliable than one.
  fallbackModels?: readonly string[];
  systemInstruction: string;
  // Single user turn. Ignored when `contents` is given.
  parts?: GeminiPart[];
  contents?: GeminiTurn[];
  responseJsonSchema: Record<string, unknown>;
  maxOutputTokens?: number;
  temperature?: number;
  // Per-attempt limit for one HTTP call.
  timeoutMs?: number;
  // Overall limit across all models and keys; attempts get whatever time is left.
  budgetMs?: number;
  // Time the preferred models get in total before only the last model in the chain is tried. Overloaded models
  // can take 8-10s just to answer 503; a customer shouldn't wait that out twice.
  lastResortAfterMs?: number;
  // "low"/"minimal" skip reasoning for simple extraction; omit to use the model's default.
  thinkingLevel?: "minimal" | "low" | "medium" | "high";
  // Called after every HTTP attempt (and for skipped models), so slow replies can be explained later.
  onAttempt?: (attempt: GeminiAttempt) => void;
  fetchImpl?: typeof fetch;
};

export type GeminiAttempt = { model: string; outcome: string; ms: number };

export type GeminiJsonResult = { json: unknown; model: string; inputTokens: number | null; outputTokens: number | null };

export class GeminiError extends Error {
  constructor(
    message: string,
    readonly kind: "http" | "timeout" | "network" | "blocked" | "empty" | "invalid_json",
    readonly status?: number,
    // A 429 from a per-day quota (the free tier allows e.g. 20 requests a day on the strongest model).
    readonly dailyQuota = false,
    // The Google project whose quota ran out ("projects/123…"), when the error says.
    readonly quotaProject?: string,
  ) {
    super(message);
    this.name = "GeminiError";
  }
}

type GenerateContentResponse = {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: { message?: string; details?: { violations?: { quotaId?: string }[]; metadata?: { consumer?: string } }[] };
};

// "k1,k2 k3" -> ["k1","k2","k3"], de-duplicated, ignoring blanks.
export function parseGeminiKeys(raw: string | undefined): string[] {
  return [...new Set((raw ?? "").split(/[\s,]+/).map((key) => key.trim()).filter((key) => key.length >= 20))];
}

// "a, b" -> ["a","b"]
export function parseModelList(raw: string | undefined): string[] {
  return [...new Set((raw ?? "").split(/[\s,]+/).map((model) => model.trim()).filter(Boolean))];
}

// Spreads requests across keys; each key has its own per-minute quota.
let nextKeyIndex = 0;

// Another key may still work: this one is rate-limited or rejected.
const TRY_NEXT_KEY = new Set([401, 403, 429]);

function isKeyProblem(error: unknown): boolean {
  return error instanceof GeminiError && error.kind === "http" && error.status !== undefined && TRY_NEXT_KEY.has(error.status);
}

// Another model may still work: this one is slow, overloaded, out of quota everywhere, or returned
// empty/cut-off JSON (e.g. it hit maxOutputTokens).
function isModelProblem(error: unknown): boolean {
  if (!(error instanceof GeminiError)) return false;
  // A dropped connection is worth another model right away (no cooldown: it says nothing about the model).
  if (error.kind === "empty" || error.kind === "invalid_json" || error.kind === "network") return true;
  return error.kind === "timeout" || (error.kind === "http" && ((error.status ?? 0) >= 500 || error.status === 429 || error.status === 404));
}

// Bad output is a one-off; only slowness, overload and quota put a model on cooldown.
function isCapacityProblem(error: unknown): boolean {
  return error instanceof GeminiError && (error.kind === "timeout" || error.kind === "http");
}

// Models that just failed (slow/overloaded/out of quota) are tried last for a while, so the next
// messages go straight to a healthy model instead of waiting out the same timeout again. Overload
// ("high demand" 503s) tends to last many minutes; rate limits clear within one.
const MODEL_COOLDOWN_MS = { overloaded: 5 * 60_000, rateLimited: 60_000 };
const modelCooldownUntil = new Map<string, number>();

export function orderByHealth(models: readonly string[], now = Date.now()): string[] {
  const healthy = models.filter((model) => (modelCooldownUntil.get(model) ?? 0) <= now);
  const cooling = models.filter((model) => (modelCooldownUntil.get(model) ?? 0) > now);
  return [...healthy, ...cooling];
}

export function resetModelHealth(): void {
  modelCooldownUntil.clear();
  keyCooldownUntil.clear();
}

export async function generateGeminiJson(request: GeminiJsonRequest): Promise<GeminiJsonResult> {
  const chain = [...new Set([request.model, ...(request.fallbackModels ?? [])])];
  const lastResort = chain[chain.length - 1];
  const models = orderByHealth(chain);
  const started = Date.now();
  const deadline = started + (request.budgetMs ?? Number.POSITIVE_INFINITY);
  const preferredDeadline = started + (request.lastResortAfterMs ?? Number.POSITIVE_INFINITY);
  let lastError: unknown = new GeminiError("Gemini request timed out", "timeout");
  for (const model of models) {
    const now = Date.now();
    const remaining = deadline - now;
    if (remaining < 1_000) break;
    const preferred = model !== lastResort;
    if (preferred && preferredDeadline - now < 1_000) {
      request.onAttempt?.({ model, outcome: "skipped: out of time for preferred models", ms: 0 });
      continue;
    }
    const ownTimeout = Math.min(request.timeoutMs ?? 30_000, remaining);
    const timeoutMs = Math.min(ownTimeout, preferred ? preferredDeadline - now : Number.POSITIVE_INFINITY);
    try {
      const result = await generateAcrossKeys(request, model, timeoutMs);
      modelCooldownUntil.delete(model);
      return result;
    } catch (error) {
      lastError = error;
      if (!isModelProblem(error)) throw error;
      // Cut short by the preferred-models cap rather than its own timeout: slow this once, not overloaded.
      const cutShort = timeoutMs < ownTimeout && error instanceof GeminiError && error.kind === "timeout";
      if (isCapacityProblem(error) && !cutShort) {
        const rateLimited = error instanceof GeminiError && error.status === 429;
        modelCooldownUntil.set(model, Date.now() + (rateLimited ? MODEL_COOLDOWN_MS.rateLimited : MODEL_COOLDOWN_MS.overloaded));
      }
    }
  }
  throw lastError;
}

// A key that was just rate-limited (or rejected) on a model is skipped for a while, so an exhausted
// quota fails over in milliseconds instead of re-trying every key on every message. A used-up daily
// quota only resets the next day; checking it hourly costs one request per key instead of one a minute.
const KEY_COOLDOWN_MS = { 429: 60_000, daily: 60 * 60_000, rejected: 10 * 60_000 };
const keyCooldownUntil = new Map<string, number>();

function generateAcrossKeys(request: GeminiJsonRequest, model: string, timeoutMs: number): Promise<GeminiJsonResult> {
  return acrossKeys(request.apiKey, model, request.onAttempt, (key) => generateWithKey(request, model, key, timeoutMs));
}

// Runs one call per key, rotating and skipping keys that are cooling down for this model.
async function acrossKeys<T>(
  apiKey: string | readonly string[],
  model: string,
  onAttempt: ((attempt: GeminiAttempt) => void) | undefined,
  run: (key: string) => Promise<T>,
): Promise<T> {
  const keys = typeof apiKey === "string" ? [apiKey] : [...apiKey];
  if (keys.length === 0) throw new GeminiError("No Gemini API key configured", "http", 401);
  const start = nextKeyIndex++ % keys.length;
  const now = Date.now();
  const rotated = keys.map((_, offset) => keys[(start + offset) % keys.length]!);
  const usable = rotated.filter((key) => (keyCooldownUntil.get(`${model}|${key}`) ?? 0) <= now);
  if (usable.length === 0) {
    onAttempt?.({ model, outcome: "skipped: every key cooling down", ms: 0 });
    throw new GeminiError(`Every Gemini key is cooling down for ${model}`, "http", 429);
  }
  let lastError: unknown;
  const exhaustedProjects: (string | undefined)[] = [];
  for (const key of usable) {
    const started = Date.now();
    try {
      const result = await run(key);
      onAttempt?.({ model, outcome: "ok", ms: Date.now() - started });
      return result;
    } catch (error) {
      onAttempt?.({ model, outcome: attemptOutcome(error), ms: Date.now() - started });
      lastError = error;
      if (!isKeyProblem(error)) throw error;
      const { status, dailyQuota, quotaProject } = error as GeminiError;
      const cooldown = dailyQuota ? KEY_COOLDOWN_MS.daily : status === 429 ? KEY_COOLDOWN_MS[429] : KEY_COOLDOWN_MS.rejected;
      keyCooldownUntil.set(`${model}|${key}`, Date.now() + cooldown);
      if (status === 429) {
        exhaustedProjects.push(quotaProject);
        // Keys from one Google project share its quotas (per minute and per day): two rate-limited in the same
        // project (or with the project unknown) means the rest almost certainly are too, and probing each costs
        // the customer about half a second. Keys from different projects keep being tried; untried keys stay
        // available for later turns, which start from the next key.
        if (new Set(exhaustedProjects).size < exhaustedProjects.length) break;
      }
    }
  }
  throw lastError;
}

function attemptOutcome(error: unknown): string {
  if (!(error instanceof GeminiError)) return error instanceof Error ? error.name : "error";
  if (error.kind !== "http") return error.kind;
  return error.dailyQuota ? `${error.status} daily quota` : String(error.status);
}

async function generateWithKey(request: GeminiJsonRequest, model: string, apiKey: string, timeoutMs: number): Promise<GeminiJsonResult> {
  const fetchImpl = request.fetchImpl ?? fetch;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: request.systemInstruction }] },
        contents: request.contents ?? [{ role: "user", parts: request.parts ?? [] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseJsonSchema: request.responseJsonSchema,
          maxOutputTokens: request.maxOutputTokens ?? 1024,
          temperature: request.temperature ?? 0.2,
          ...(request.thinkingLevel ? { thinkingConfig: { thinkingLevel: request.thinkingLevel } } : {}),
        },
      }),
    });
  } catch (error) {
    throw fetchFailure(model, error);
  }

  const body = (await response.json().catch(() => ({}))) as GenerateContentResponse;
  if (!response.ok) throw httpError(model, response.status, body);
  if (body.promptFeedback?.blockReason) throw new GeminiError(`Gemini blocked the prompt: ${body.promptFeedback.blockReason}`, "blocked");

  const candidate = body.candidates?.[0];
  const text = (candidate?.content?.parts ?? [])
    .filter((part) => !part.thought && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
  if (!text.trim()) throw new GeminiError(`Gemini returned no text (finishReason ${candidate?.finishReason ?? "unknown"})`, "empty");

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new GeminiError("Gemini returned invalid JSON", "invalid_json");
  }

  return {
    json,
    model,
    inputTokens: body.usageMetadata?.promptTokenCount ?? null,
    outputTokens: body.usageMetadata?.candidatesTokenCount ?? null,
  };
}

// The request never got an answer: our timeout, or the connection failed ("fetch failed", DNS, reset).
function fetchFailure(model: string, error: unknown): GeminiError {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return new GeminiError(`Gemini ${model} timed out`, "timeout");
  const cause = error instanceof Error ? ((error.cause as { code?: string } | undefined)?.code ?? error.message) : String(error);
  return new GeminiError(`Gemini ${model} unreachable: ${cause}`, "network");
}

function httpError(model: string, status: number, body: Pick<GenerateContentResponse, "error">): GeminiError {
  const details = body.error?.details ?? [];
  const dailyQuota = status === 429 && details.some((detail) => detail.violations?.some((violation) => /PerDay/i.test(violation.quotaId ?? "")));
  const quotaProject = details.find((detail) => typeof detail.metadata?.consumer === "string")?.metadata?.consumer;
  return new GeminiError(`Gemini ${model} HTTP ${status}: ${body.error?.message ?? "request failed"}`, "http", status, dailyQuota, quotaProject);
}

// Matches the products.embedding and product_images.image_embedding columns (vector(768)); gemini-embedding
// models shorten (and re-normalise) their output to it.
export const EMBEDDING_DIMENSIONS = 768;

export type GeminiEmbedRequest = {
  apiKey: string | readonly string[];
  model: string;
  text: string;
  // Queries and documents are embedded differently so they match each other well.
  taskType: "RETRIEVAL_QUERY" | "RETRIEVAL_DOCUMENT";
  // Document title (RETRIEVAL_DOCUMENT only), e.g. the product name.
  title?: string;
  timeoutMs?: number;
  onAttempt?: (attempt: GeminiAttempt) => void;
  fetchImpl?: typeof fetch;
};

// One text → one 768-number vector, with the same key rotation and cooldowns as generateGeminiJson.
export function embedText(request: GeminiEmbedRequest): Promise<number[]> {
  return embedContent(request, 8_000, {
    content: { parts: [{ text: request.text.slice(0, 8_000) }] },
    taskType: request.taskType,
    ...(request.title && request.taskType === "RETRIEVAL_DOCUMENT" ? { title: request.title.slice(0, 200) } : {}),
  });
}

export type GeminiImageEmbedRequest = {
  apiKey: string | readonly string[];
  // A multimodal embedding model (gemini-embedding-2): photos and text share one space.
  model: string;
  image: { base64: string; mimeType: string };
  timeoutMs?: number;
  onAttempt?: (attempt: GeminiAttempt) => void;
  fetchImpl?: typeof fetch;
};

// One photo → one 768-number vector. A photo alone needs no task prefix; JPEG, PNG and WebP are accepted.
export function embedImage(request: GeminiImageEmbedRequest): Promise<number[]> {
  return embedContent(request, 15_000, { content: { parts: [{ inline_data: { mime_type: request.image.mimeType, data: request.image.base64 } }] } });
}

type EmbedContentResponse = GenerateContentResponse & { embedding?: { values?: unknown }; embeddings?: { values?: unknown }[] };

async function embedContent(
  request: Pick<GeminiEmbedRequest, "apiKey" | "model" | "timeoutMs" | "onAttempt" | "fetchImpl">,
  defaultTimeoutMs: number,
  content: Record<string, unknown>,
): Promise<number[]> {
  const { model } = request;
  return acrossKeys(request.apiKey, model, request.onAttempt, async (key) => {
    const fetchImpl = request.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:embedContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        signal: AbortSignal.timeout(request.timeoutMs ?? defaultTimeoutMs),
        body: JSON.stringify({ ...content, outputDimensionality: EMBEDDING_DIMENSIONS }),
      });
    } catch (error) {
      throw fetchFailure(model, error);
    }
    const body = (await response.json().catch(() => ({}))) as EmbedContentResponse;
    if (!response.ok) throw httpError(model, response.status, body);
    // embedContent answers with `embedding`; the batch form (and possibly future versions) with `embeddings`.
    const values = body.embedding?.values ?? body.embeddings?.[0]?.values;
    if (!Array.isArray(values) || values.length !== EMBEDDING_DIMENSIONS || !values.every((value) => typeof value === "number" && Number.isFinite(value))) {
      throw new GeminiError(`Gemini ${model} returned no usable embedding`, "empty");
    }
    return values as number[];
  });
}

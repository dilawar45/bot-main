import { beforeEach, describe, expect, it, vi } from "vitest";
import { embedImage, GeminiError, generateGeminiJson, orderByHealth, parseGeminiKeys, resetModelHealth } from "./gemini";

beforeEach(() => resetModelHealth());

const ok = () =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] }, finishReason: "STOP" }] }), { status: 200 });
const fail = (status: number) => new Response(JSON.stringify({ error: { message: `status ${status}` } }), { status });
const keyOf = (init: RequestInit | undefined) => (init?.headers as Record<string, string>)["x-goog-api-key"];

const request = (apiKey: string | string[], fetchImpl: typeof fetch) => ({
  apiKey,
  model: "m",
  systemInstruction: "s",
  parts: [{ text: "t" }],
  responseJsonSchema: { type: "object" },
  fetchImpl,
});

describe("parseGeminiKeys", () => {
  it("splits on commas and whitespace, trims and de-duplicates", () => {
    const a = "a".repeat(30);
    const b = "b".repeat(30);
    expect(parseGeminiKeys(` ${a}, ${b},${a}\n `)).toEqual([a, b]);
    expect(parseGeminiKeys(undefined)).toEqual([]);
    expect(parseGeminiKeys("short")).toEqual([]);
    // Regression: keys containing the letter "s" must stay whole.
    const withS = "AQ.sssKeyWithSsInside_1234567890";
    expect(parseGeminiKeys(`${withS},${b}`)).toEqual([withS, b]);
  });
});

describe("generateGeminiJson key rotation", () => {
  const keys = ["k1".padEnd(30, "x"), "k2".padEnd(30, "x"), "k3".padEnd(30, "x")];

  it("fails over to the next key when one is rate-limited or rejected", async () => {
    const used: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      used.push(keyOf(init));
      return used.length < 3 ? fail(used.length === 1 ? 429 : 403) : ok();
    });
    const result = await generateGeminiJson(request(keys, fetchImpl));
    expect(result.json).toEqual({ ok: true });
    expect(new Set(used).size).toBe(3);
  });

  it("does not try other keys for request errors like 400", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => fail(400));
    await expect(generateGeminiJson(request(keys, fetchImpl))).rejects.toMatchObject({ kind: "http", status: 400 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("stops after two rate-limited keys that (as far as it can tell) share a project", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => fail(429));
    await expect(generateGeminiJson(request(keys, fetchImpl))).rejects.toBeInstanceOf(GeminiError);
    // Keys in one project share its per-minute quota: probing the third would only cost time.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("spreads successive requests across keys", async () => {
    const used: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      used.push(keyOf(init));
      return ok();
    });
    for (let index = 0; index < 3; index += 1) await generateGeminiJson(request(keys, fetchImpl));
    expect(new Set(used).size).toBe(3);
  });
});

describe("fallback model", () => {
  it("retries once on the fallback model when the primary is overloaded", async () => {
    const models: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      const model = String(url).match(/models\/([^:]+):/)![1]!;
      models.push(model);
      return model === "pro" ? fail(503) : ok();
    });
    const result = await generateGeminiJson({ ...request(["k".repeat(30)], fetchImpl), model: "pro", fallbackModels: ["fast"] });
    expect(result.json).toEqual({ ok: true });
    expect(result.model).toBe("fast");
    expect(models).toEqual(["pro", "fast"]);
  });

  it("does not fall back for rejected requests", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => fail(400));
    await expect(generateGeminiJson({ ...request(["k".repeat(30)], fetchImpl), model: "pro", fallbackModels: ["fast"] })).rejects.toMatchObject({ status: 400 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("model chain", () => {
  it("moves to the next model when every key is rate-limited on the first", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      const model = String(url).match(/models\/([^:]+):/)![1]!;
      calls.push(model);
      return model === "busy" ? fail(429) : ok();
    });
    const result = await generateGeminiJson({ ...request(["a".repeat(30), "b".repeat(30)], fetchImpl), model: "busy", fallbackModels: ["free"] });
    expect(result.model).toBe("free");
    expect(calls).toEqual(["busy", "busy", "free"]);
  });

  it("stops when the overall budget is spent", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })));
        }),
    );
    const started = Date.now();
    await expect(
      generateGeminiJson({ ...request(["a".repeat(30)], fetchImpl), model: "slow1", fallbackModels: ["slow2", "slow3"], timeoutMs: 1_000, budgetMs: 1_500 }),
    ).rejects.toMatchObject({ kind: "timeout" });
    expect(Date.now() - started).toBeLessThan(2_500);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reports every attempt so slow replies can be explained", async () => {
    const attempts: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url) => (String(url).includes("/busy:") ? fail(503) : ok()));
    const onAttempt = (attempt: { model: string; outcome: string }) => void attempts.push(`${attempt.model} ${attempt.outcome}`);
    await generateGeminiJson({ ...request(["a".repeat(30)], fetchImpl), model: "busy", fallbackModels: ["free"], onAttempt });
    expect(attempts).toEqual(["busy 503", "free ok"]);
  });

  it("sends the thinking level when asked", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => ok());
    await generateGeminiJson({ ...request(["a".repeat(30)], fetchImpl), thinkingLevel: "low" });
    const body = JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body));
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "low" });
  });
});

describe("model health", () => {
  it("tries a model that just failed last, then forgives it on success", async () => {
    const calls: string[] = [];
    let busyIsDown = true;
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      const model = String(url).match(/models\/([^:]+):/)![1]!;
      calls.push(model);
      return model === "busy" && busyIsDown ? fail(503) : ok();
    });
    const go = () => generateGeminiJson({ ...request(["a".repeat(30)], fetchImpl), model: "busy", fallbackModels: ["healthy"] });

    await go();
    expect(calls).toEqual(["busy", "healthy"]);
    expect(orderByHealth(["busy", "healthy"])).toEqual(["healthy", "busy"]);

    calls.length = 0;
    await go();
    expect(calls).toEqual(["healthy"]);

    // Overload lasts: still benched after a minute, tried first again after five.
    expect(orderByHealth(["busy", "healthy"], Date.now() + 61_000)).toEqual(["healthy", "busy"]);
    expect(orderByHealth(["busy", "healthy"], Date.now() + 5 * 60_000 + 1_000)).toEqual(["busy", "healthy"]);
    busyIsDown = false;
  });

  it("benches a rate-limited model for only a minute", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) => (String(url).includes("/limited:") ? fail(429) : ok()));
    await generateGeminiJson({ ...request(["a".repeat(30)], fetchImpl), model: "limited", fallbackModels: ["free"] });
    expect(orderByHealth(["limited", "free"], Date.now() + 61_000)).toEqual(["limited", "free"]);
  });

  it("gives the preferred models a shared time limit, then asks the last model", async () => {
    const attempts: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).includes("/lite:")) return ok();
      // Overloaded models hang until the caller gives up.
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })));
      });
    });
    const started = Date.now();
    const result = await generateGeminiJson({
      ...request(["a".repeat(30)], fetchImpl),
      model: "pro",
      fallbackModels: ["flash", "lite"],
      timeoutMs: 15_000,
      lastResortAfterMs: 1_500,
      onAttempt: (attempt) => void attempts.push(`${attempt.model} ${attempt.outcome}`),
    });
    expect(result.model).toBe("lite");
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(attempts).toEqual(["pro timeout", "flash skipped: out of time for preferred models", "lite ok"]);
  });
});

describe("key cooldown", () => {
  it("skips a rate-limited key on the next request and fails fast when all keys are cooling", async () => {
    const used: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      used.push(keyOf(init));
      return fail(429);
    });
    const keys = ["a".repeat(30), "b".repeat(30)];
    await expect(generateGeminiJson(request(keys, fetchImpl))).rejects.toMatchObject({ status: 429 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // Both keys are now cooling for this model: no network calls at all.
    await expect(generateGeminiJson(request(keys, fetchImpl))).rejects.toMatchObject({ status: 429 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("stops probing a model's keys after two report a used-up daily quota", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => dailyQuota());
    const keys = ["a".repeat(30), "b".repeat(30), "c".repeat(30), "d".repeat(30)];
    await expect(generateGeminiJson(request(keys, fetchImpl))).rejects.toMatchObject({ status: 429, dailyQuota: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("checks a key with a used-up daily quota hourly, not every minute", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => dailyQuota());
    const keys = ["a".repeat(30)];
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await expect(generateGeminiJson(request(keys, fetchImpl))).rejects.toMatchObject({ status: 429, dailyQuota: true });
      vi.setSystemTime(Date.now() + 5 * 60_000);
      await expect(generateGeminiJson(request(keys, fetchImpl))).rejects.toMatchObject({ status: 429 });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      vi.setSystemTime(Date.now() + 60 * 60_000);
      await expect(generateGeminiJson(request(keys, fetchImpl))).rejects.toMatchObject({ status: 429 });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

// What Gemini answers once a free-tier daily quota is used up (optionally naming the Google project).
function dailyQuota(project?: string): Response {
  return new Response(
    JSON.stringify({
      error: {
        message: "You exceeded your current quota",
        details: [
          { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] },
          { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "50s" },
          ...(project ? [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "RATE_LIMIT_EXCEEDED", metadata: { consumer: project } }] : []),
        ],
      },
    }),
    { status: 429 },
  );
}

describe("quota edge cases", () => {
  it("keeps trying keys when the used-up ones belong to different projects", async () => {
    let calls = 0;
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      calls += 1;
      return calls <= 2 ? dailyQuota(`projects/${calls}`) : ok();
    });
    const result = await generateGeminiJson(request(["a".repeat(30), "b".repeat(30), "c".repeat(30)], fetchImpl));
    expect(result.json).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("doesn't bench a healthy preferred model that the time cap cut short", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).includes("/lite:")) return ok();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })));
      });
    });
    await generateGeminiJson({ ...request(["a".repeat(30)], fetchImpl), model: "pro", fallbackModels: ["lite"], timeoutMs: 15_000, lastResortAfterMs: 1_200 });
    // Slow once isn't overloaded: the stronger model stays first for the next message.
    expect(orderByHealth(["pro", "lite"])).toEqual(["pro", "lite"]);
  });
});

describe("embedImage", () => {
  const vector = (length = 768) => Array.from({ length }, (_, index) => (index % 7) / 10);
  const embedding = (body: Record<string, unknown>) => new Response(JSON.stringify(body), { status: 200 });
  const image = { base64: "AAAA", mimeType: "image/webp" };

  it("sends the photo alone (no task type) and asks for 768 numbers", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => embedding({ embedding: { values: vector() } }));
    const values = await embedImage({ apiKey: "k".repeat(30), model: "gemini-embedding-2", image, fetchImpl });
    expect(values).toHaveLength(768);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toContain("/models/gemini-embedding-2:embedContent");
    expect(JSON.parse(String(init?.body))).toEqual({ content: { parts: [{ inline_data: { mime_type: "image/webp", data: "AAAA" } }] }, outputDimensionality: 768 });
  });

  it("also reads the embeddings[0] answer shape", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => embedding({ embeddings: [{ values: vector() }] }));
    await expect(embedImage({ apiKey: "k".repeat(30), model: "m", image, fetchImpl })).resolves.toHaveLength(768);
  });

  it("rejects a vector of the wrong size or with non-numbers", async () => {
    for (const values of [vector(3072), [...vector(767), "x"], []]) {
      const fetchImpl = vi.fn<typeof fetch>(async () => embedding({ embedding: { values } }));
      await expect(embedImage({ apiKey: "k".repeat(30), model: "m", image, fetchImpl })).rejects.toMatchObject({ kind: "empty" });
    }
  });

  it("fails over to the next key on a rate limit, like the other calls", async () => {
    const used: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      used.push(keyOf(init));
      return used.length === 1 ? fail(429) : embedding({ embedding: { values: vector() } });
    });
    const attempts: string[] = [];
    await embedImage({ apiKey: ["a".repeat(30), "b".repeat(30)], model: "m", image, fetchImpl, onAttempt: (attempt) => void attempts.push(attempt.outcome) });
    expect(new Set(used).size).toBe(2);
    expect(attempts).toEqual(["429", "ok"]);
  });

  it("reports a timeout as one", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })));
      });
    });
    await expect(embedImage({ apiKey: "k".repeat(30), model: "m", image, timeoutMs: 20, fetchImpl })).rejects.toMatchObject({ kind: "timeout" });
  });
});

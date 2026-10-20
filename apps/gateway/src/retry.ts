export class BrainRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "BrainRequestError";
  }
}

// Network failures, timeouts, 429 and 5xx are worth another try; other 4xx mean the request itself is wrong.
export function isRetryable(error: unknown): boolean {
  if (error instanceof BrainRequestError) return error.status === 429 || error.status >= 500;
  if (error instanceof Error) return error.name === "TimeoutError" || error.name === "AbortError" || error.name === "TypeError";
  return false;
}

export type Sleep = (ms: number) => Promise<void>;
export const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function withRetry<T>(
  operation: () => Promise<T>,
  delaysMs: readonly number[],
  sleep: Sleep = defaultSleep,
  shouldRetry: (error: unknown) => boolean = isRetryable,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const delay = delaysMs[attempt];
      if (delay === undefined || !shouldRetry(error)) throw error;
      // Jitter spreads retries from many chats so they don't hit the brain in lockstep.
      await sleep(delay + Math.floor(Math.random() * Math.min(250, delay / 2)));
    }
  }
}

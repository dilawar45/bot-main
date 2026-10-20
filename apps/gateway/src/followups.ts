import type { BrainClient } from "./brain-client.js";
import type { MessageProcessor, ProcessorLogger } from "./processor.js";
import { BrainRequestError } from "./retry.js";
import type { WhatsAppTransport } from "./transport.js";

// A brain deployed before follow-ups existed answers 404; ask again much later instead of every round.
const MISSING_ENDPOINT_BACKOFF_MS = 60 * 60 * 1_000;

export type FollowUpLoop = {
  stop(): void;
  // One round now (used by the timer and by tests).
  runOnce(): Promise<void>;
};

// Asks the brain every few minutes for follow-ups that are due (order reminders, notes to the owner) and
// sends them. Only while WhatsApp is connected: the brain counts a follow-up as handed out once it answers.
export function startFollowUps(options: {
  intervalMs: number;
  transport: Pick<WhatsAppTransport, "getSessionSnapshot">;
  brainClient: Pick<BrainClient, "fetchFollowUps">;
  processor: Pick<MessageProcessor, "sendScheduled">;
  logger: ProcessorLogger;
  // The first round waits a little: WhatsApp needs a moment to connect after a start.
  firstDelayMs?: number;
}): FollowUpLoop {
  const { intervalMs, transport, brainClient, processor, logger } = options;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let running = false;
  let pausedUntil = 0;

  const runOnce = async () => {
    if (running || stopped || Date.now() < pausedUntil) return;
    // Also not while health checks fail: sends would hang or fail, and a claimed follow-up isn't handed out twice.
    const session = transport.getSessionSnapshot();
    if (session.state !== "ready" || session.healthy === false) return;
    running = true;
    try {
      const { actions, invalid } = await brainClient.fetchFollowUps();
      if (invalid) logger.warn({ invalid }, "Brain sent follow-ups the gateway can't send; skipped them");
      if (actions.length) await processor.sendScheduled(actions);
    } catch (error) {
      if (error instanceof BrainRequestError && error.status === 404) {
        pausedUntil = Date.now() + MISSING_ENDPOINT_BACKOFF_MS;
        logger.warn({}, "Brain has no follow-up endpoint yet (deploy the web app); asking again in an hour");
      } else {
        // The next round asks again; nothing was handed out if the brain didn't answer.
        logger.warn({ error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }, "Follow-up round failed");
      }
    } finally {
      running = false;
    }
  };

  const schedule = (delay: number) => {
    if (stopped) return;
    // Jitter keeps the rounds from lining up with other periodic work.
    timer = setTimeout(() => {
      void runOnce().finally(() => schedule(intervalMs * (0.9 + Math.random() * 0.2)));
    }, delay);
    timer.unref?.();
  };
  schedule(options.firstDelayMs ?? 60_000);

  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
    runOnce,
  };
}

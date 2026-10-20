import { afterEach, describe, expect, it, vi } from "vitest";
import { startFollowUps, type FollowUpLoop } from "./followups.js";
import { BrainRequestError } from "./retry.js";
import type { SessionSnapshot } from "./transport.js";

const action = { actionId: "00000000-0000-4000-8000-000000000001", recipientChatId: "923001234567@c.us", type: "text" as const, text: "Reminder" };
const logger = { warn: vi.fn(), error: vi.fn() };

const loops: FollowUpLoop[] = [];
afterEach(() => {
  for (const loop of loops.splice(0)) loop.stop();
  vi.useRealTimers();
});

function setup(options: { state?: SessionSnapshot["state"]; fetch?: () => Promise<{ actions: (typeof action)[]; invalid: number }> } = {}) {
  const snapshot: SessionSnapshot = { state: options.state ?? "ready" };
  const sent: unknown[][] = [];
  const fetchFollowUps = vi.fn(options.fetch ?? (async () => ({ actions: [action], invalid: 0 })));
  const loop = startFollowUps({
    intervalMs: 300_000,
    // Far away: these tests drive the rounds themselves.
    firstDelayMs: 3_600_000,
    transport: { getSessionSnapshot: () => snapshot },
    brainClient: { fetchFollowUps },
    processor: {
      sendScheduled: async (actions) => {
        sent.push([...actions]);
      },
    },
    logger,
  });
  loops.push(loop);
  return { snapshot, sent, fetchFollowUps, loop };
}

describe("follow-up rounds", () => {
  it("fetches and sends while WhatsApp is connected", async () => {
    const { sent, loop } = setup();
    await loop.runOnce();
    expect(sent).toEqual([[action]]);
  });

  it("doesn't ask the brain while WhatsApp is disconnected or failing its checks, since nothing could be sent", async () => {
    const { fetchFollowUps, loop } = setup({ state: "disconnected" });
    await loop.runOnce();
    const failing = setup();
    failing.snapshot.healthy = false;
    await failing.loop.runOnce();
    expect(fetchFollowUps).not.toHaveBeenCalled();
    expect(failing.fetchFollowUps).not.toHaveBeenCalled();
  });

  it("runs one round at a time", async () => {
    let release = () => {};
    const { fetchFollowUps, loop } = setup({
      fetch: () =>
        new Promise((resolve) => {
          release = () => resolve({ actions: [], invalid: 0 });
        }),
    });
    const first = loop.runOnce();
    await loop.runOnce();
    release();
    await first;
    expect(fetchFollowUps).toHaveBeenCalledTimes(1);
  });

  it("backs off for an hour when the brain doesn't have the endpoint yet", async () => {
    const { fetchFollowUps, loop } = setup({
      fetch: async () => {
        throw new BrainRequestError("Brain request /api/gateway/followups failed with status 404", 404);
      },
    });
    await loop.runOnce();
    await loop.runOnce();
    expect(fetchFollowUps).toHaveBeenCalledTimes(1);
  });

  it("keeps going after a failed round", async () => {
    let calls = 0;
    const { sent, loop } = setup({
      fetch: async () => {
        calls += 1;
        if (calls === 1) throw new BrainRequestError("Brain request failed with status 500", 500);
        return { actions: [action], invalid: 0 };
      },
    });
    await loop.runOnce();
    await loop.runOnce();
    expect(sent).toEqual([[action]]);
  });

  it("runs on its own timer until stopped", async () => {
    vi.useFakeTimers();
    const fetchFollowUps = vi.fn(async () => ({ actions: [], invalid: 0 }));
    const loop = startFollowUps({
      intervalMs: 300_000,
      firstDelayMs: 60_000,
      transport: { getSessionSnapshot: () => ({ state: "ready" }) },
      brainClient: { fetchFollowUps },
      processor: { sendScheduled: async () => undefined },
      logger,
    });
    loops.push(loop);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchFollowUps).toHaveBeenCalledTimes(1);
    // Next round after the interval with at most 10% jitter.
    await vi.advanceTimersByTimeAsync(330_000);
    expect(fetchFollowUps).toHaveBeenCalledTimes(2);
    loop.stop();
    await vi.advanceTimersByTimeAsync(400_000);
    expect(fetchFollowUps).toHaveBeenCalledTimes(2);
  });
});

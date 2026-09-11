import { describe, expect, test } from "bun:test";
import { createScheduler } from "../src/scheduler";

// Manual fake clock: setTimeoutImpl/clearTimeoutImpl record {at, fn} and advance()
// fires everything due, in time order, including timers scheduled by those fires.
// No real sleeping anywhere in this file.
function createFakeTimers() {
  let time = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();

  function setTimeoutImpl(fn: () => void, ms: number) {
    const id = nextId++;
    timers.set(id, { at: time + ms, fn });
    return id as unknown as ReturnType<typeof setTimeout>;
  }
  function clearTimeoutImpl(handle: unknown) {
    timers.delete(handle as number);
  }
  // Each firing yields to the microtask queue before the next, mirroring how real
  // setTimeout callbacks run as separate event-loop turns (so onCheck's in-flight
  // bookkeeping, chained via .then/.catch/.finally, settles between ticks).
  async function advance(ms: number) {
    const target = time + ms;
    for (;;) {
      let dueId: number | undefined;
      let due: { at: number; fn: () => void } | undefined;
      for (const [id, entry] of timers) {
        if (entry.at <= target && (!due || entry.at < due.at)) {
          dueId = id;
          due = entry;
        }
      }
      if (!due || dueId === undefined) break;
      timers.delete(dueId);
      time = due.at;
      due.fn();
      await flush();
    }
    time = target;
  }
  return { setTimeoutImpl, clearTimeoutImpl, advance };
}

// Drains the .then/.catch/.finally microtask chain queued by the scheduler's fire().
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("createScheduler", () => {
  test("fires each target on its own interval", async () => {
    const fakeTimers = createFakeTimers();
    const calls: string[] = [];
    const scheduler = createScheduler({
      targets: [
        { id: "a", intervalSeconds: 10 },
        { id: "b", intervalSeconds: 20 },
      ],
      onCheck: (target) => {
        calls.push(target.id);
      },
      setTimeoutImpl: fakeTimers.setTimeoutImpl,
      clearTimeoutImpl: fakeTimers.clearTimeoutImpl,
    });

    scheduler.start();
    await fakeTimers.advance(45_000);

    expect(calls.filter((id) => id === "a")).toHaveLength(5); // t=0,10,20,30,40s
    expect(calls.filter((id) => id === "b")).toHaveLength(2); // jittered to t=10,30s
  });

  test("skips a tick while a check is in flight", async () => {
    const fakeTimers = createFakeTimers();
    const calls: string[] = [];
    const resolvers: Array<() => void> = [];
    const scheduler = createScheduler({
      targets: [{ id: "a", intervalSeconds: 10 }],
      onCheck: (target) =>
        new Promise<void>((resolve) => {
          calls.push(target.id);
          resolvers.push(resolve);
        }),
      setTimeoutImpl: fakeTimers.setTimeoutImpl,
      clearTimeoutImpl: fakeTimers.clearTimeoutImpl,
    });

    scheduler.start();
    await fakeTimers.advance(0); // first fire, t=0
    expect(calls).toHaveLength(1);

    await fakeTimers.advance(10_000); // t=10s: still in flight, must be skipped
    expect(calls).toHaveLength(1);

    resolvers[0]?.();
    await flush();

    await fakeTimers.advance(10_000); // t=20s: in-flight cleared, fires again
    expect(calls).toHaveLength(2);
  });

  test("stop() prevents further fires", async () => {
    const fakeTimers = createFakeTimers();
    const calls: string[] = [];
    const scheduler = createScheduler({
      targets: [{ id: "a", intervalSeconds: 10 }],
      onCheck: (target) => {
        calls.push(target.id);
      },
      setTimeoutImpl: fakeTimers.setTimeoutImpl,
      clearTimeoutImpl: fakeTimers.clearTimeoutImpl,
    });

    scheduler.start();
    await fakeTimers.advance(0);
    expect(calls).toHaveLength(1);

    scheduler.stop();
    await fakeTimers.advance(100_000);
    expect(calls).toHaveLength(1);
  });
});

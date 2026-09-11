// Fires one check per target on its own cadence. Jittered so N targets sharing
// an interval don't all fire on the same tick, and never lets a slow check for
// a target overlap with that target's next tick.

export type SchedulerTarget = { id: string; intervalSeconds: number };

// unknown, not ReturnType<typeof setTimeout>: Bun's global setTimeout and a fake
// test timer don't agree on one handle type, and callers only ever pass it back
// to their own paired clearTimeoutImpl.
type TimerHandle = unknown;

export type CreateSchedulerOptions<T extends SchedulerTarget> = {
  targets: T[];
  onCheck: (target: T) => void | Promise<void>;
  /** Accepted for API symmetry with checker's fetch injection; scheduling itself is delay-based. */
  now?: () => number;
  setTimeoutImpl?: (callback: () => void, ms: number) => TimerHandle;
  clearTimeoutImpl?: (handle: TimerHandle) => void;
};

export function createScheduler<T extends SchedulerTarget>(options: CreateSchedulerOptions<T>) {
  const {
    targets,
    onCheck,
    setTimeoutImpl = setTimeout as (callback: () => void, ms: number) => TimerHandle,
    clearTimeoutImpl = clearTimeout as (handle: TimerHandle) => void,
  } = options;

  const timers = new Map<string, TimerHandle>();
  const inFlight = new Set<string>();
  let running = false;

  function scheduleNext(target: T, delayMs: number) {
    if (!running) return;
    timers.set(
      target.id,
      setTimeoutImpl(() => fire(target), delayMs),
    );
  }

  function fire(target: T) {
    const intervalMs = target.intervalSeconds * 1000;
    if (!inFlight.has(target.id)) {
      inFlight.add(target.id);
      Promise.resolve()
        .then(() => onCheck(target))
        .catch(() => {})
        .finally(() => inFlight.delete(target.id));
    }
    scheduleNext(target, intervalMs);
  }

  function start() {
    if (running) return;
    running = true;
    targets.forEach((target, index) => {
      const intervalMs = target.intervalSeconds * 1000;
      const jitterMs = targets.length > 1 ? (index * intervalMs) / targets.length : 0;
      scheduleNext(target, jitterMs);
    });
  }

  function stop() {
    running = false;
    for (const handle of timers.values()) clearTimeoutImpl(handle);
    timers.clear();
  }

  return { start, stop };
}

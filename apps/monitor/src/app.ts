// Wires the scheduler and the two timer loops (publish, daily prune) onto the injected
// deps. Kept separate from index.ts so tests can drive it with fake timers instead of
// real ones, and so index.ts stays a thin "read env, build real deps, call this" shim.
import type { SiteConfig } from "@uptime-status/domain";
import { createScheduler, type MonitorStore } from "@uptime-status/monitor";
import { createCheckHandler, createPruner, createPublisher, type Logger } from "./handlers";
import type { PublishSink } from "./sink";
import { buildMonitorTargets } from "./targets";

const DAY_SECONDS = 86_400;

type TimerHandle = unknown;

export type MonitorAppOptions = {
  site: SiteConfig;
  store: MonitorStore;
  sink: PublishSink;
  publishIntervalSeconds?: number;
  now?: () => Date;
  fetchImpl?: typeof fetch;
  log?: Logger;
  setTimeoutImpl?: (callback: () => void, ms: number) => TimerHandle;
  clearTimeoutImpl?: (handle: TimerHandle) => void;
};

export function createMonitorApp(options: MonitorAppOptions) {
  const {
    site,
    store,
    sink,
    publishIntervalSeconds = 60,
    now,
    fetchImpl,
    log,
    setTimeoutImpl = setTimeout as (callback: () => void, ms: number) => TimerHandle,
    clearTimeoutImpl = clearTimeout as (handle: TimerHandle) => void,
  } = options;

  const targets = buildMonitorTargets(site);
  const handleCheck = createCheckHandler({ store, fetchImpl, now });
  const publish = createPublisher({ store, site, sink, now, log });
  const pruneOnce = createPruner({ store, site, log });

  const scheduler = createScheduler({
    targets,
    onCheck: handleCheck,
    setTimeoutImpl,
    clearTimeoutImpl,
  });

  let publishTimer: TimerHandle = null;
  let publishRunning = false;
  function schedulePublish() {
    if (!publishRunning) return;
    publishTimer = setTimeoutImpl(async () => {
      await publish();
      schedulePublish();
    }, publishIntervalSeconds * 1000);
  }

  let pruneTimer: TimerHandle = null;
  let pruneRunning = false;
  function schedulePrune() {
    if (!pruneRunning) return;
    pruneTimer = setTimeoutImpl(() => {
      pruneOnce();
      schedulePrune();
    }, DAY_SECONDS * 1000);
  }

  function start() {
    pruneOnce();
    scheduler.start();
    publishRunning = true;
    schedulePublish();
    pruneRunning = true;
    schedulePrune();
  }

  function stop() {
    scheduler.stop();
    publishRunning = false;
    if (publishTimer !== null) clearTimeoutImpl(publishTimer);
    pruneRunning = false;
    if (pruneTimer !== null) clearTimeoutImpl(pruneTimer);
  }

  return { start, stop, publish, pruneOnce, targets };
}

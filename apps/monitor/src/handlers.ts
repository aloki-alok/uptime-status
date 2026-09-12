// The three units of work the app wires onto timers. Each is a plain async function with
// injected deps, so tests can call it directly without touching a scheduler or a real clock.
import type { SiteConfig } from "@uptime-status/domain";
import { check, type MonitorStore } from "@uptime-status/monitor";
import { buildSnapshotFromStore } from "@uptime-status/snapshot";
import type { PublishSink } from "./sink";
import type { MonitorTarget } from "./targets";

const DAY_SECONDS = 86_400;

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

export type Logger = (line: Record<string, unknown>) => void;

const defaultLog: Logger = (line) => console.log(JSON.stringify(line));

export type CheckHandlerDeps = {
  store: MonitorStore;
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

/** Probes one target and, for every component bound to it, records the check and rolls up today. */
export function createCheckHandler(deps: CheckHandlerDeps) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const now = deps.now ?? (() => new Date());

  return async function handleCheck(target: MonitorTarget) {
    const result = await check(
      {
        url: target.url,
        timeoutMs: target.timeoutMs,
        acceptedStatus: target.acceptedStatus,
        confirmRetries: target.confirmRetries,
      },
      fetchImpl,
    );
    const observedAt = Math.floor(now().getTime() / 1000);
    const dayStart = Math.floor(observedAt / DAY_SECONDS) * DAY_SECONDS;
    for (const componentId of target.componentIds) {
      deps.store.recordCheck({
        componentId,
        observedAt,
        status: result.status,
        responseMs: result.responseMs,
      });
      deps.store.rollUpDay(componentId, dayStart);
    }
  };
}

export type PublisherDeps = {
  store: MonitorStore;
  site: SiteConfig;
  sink: PublishSink;
  now?: () => Date;
  log?: Logger;
  /** Overridable only so a test can force a build failure without contriving invalid data. */
  buildSnapshot?: typeof buildSnapshotFromStore;
};

/**
 * Builds the snapshot and publishes it. A build failure or a sink failure is logged and
 * swallowed: the previous published file is left exactly as it was, and the next tick retries.
 */
export function createPublisher(deps: PublisherDeps) {
  const log = deps.log ?? defaultLog;
  const buildSnapshot = deps.buildSnapshot ?? buildSnapshotFromStore;

  return async function publish() {
    let body: string;
    try {
      const snapshot = buildSnapshot({ store: deps.store, site: deps.site, now: deps.now });
      body = JSON.stringify(snapshot);
    } catch (err) {
      log({ kind: "publish.build_failed", message: errorMessage(err) });
      return;
    }
    try {
      await deps.sink.publish("current.json", body);
      log({ kind: "publish.ok", bytes: body.length });
    } catch (err) {
      log({ kind: "publish.sink_failed", message: errorMessage(err) });
    }
  };
}

export type PrunerDeps = {
  store: MonitorStore;
  site: SiteConfig;
  log?: Logger;
};

/** Deletes rollups/checks past retention. Reports the counts prune() computed before deleting. */
export function createPruner(deps: PrunerDeps) {
  const log = deps.log ?? defaultLog;
  const dailyDays = deps.site.monitoring.retention?.dailyDays ?? 360;

  return function pruneOnce() {
    const result = deps.store.prune({ dailyDays });
    log({ kind: "prune", daily: result.daily, checks: result.checks });
    return result;
  };
}

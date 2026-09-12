// Assembles a multi-component StatusSnapshot straight from the monitor's own SQLite store,
// so the container profile can publish a page without an Uptime Kuma export in between.
// Unlike publisher.ts (one HTTPS probe, one component, always fresh) this reads history that
// may be stale or missing, so freshness and unknown-day handling are the whole point here.
import { createHash } from "node:crypto";
import {
  deriveOverallStatus,
  type Incident,
  type Maintenance,
  PUBLIC_HISTORY_WINDOW_DAYS,
  type SiteConfig,
  type StatusSnapshot,
  type StatusState,
  validateStatusSnapshot,
} from "@uptime-status/domain";
import { type MonitorStore, ROLLUP_VERSION } from "@uptime-status/monitor";

const DAY_MS = 86_400_000;
const HISTORY_DAYS = PUBLIC_HISTORY_WINDOW_DAYS;

export type BuildSnapshotFromStoreOptions = {
  store: MonitorStore;
  site: SiteConfig;
  now?: () => Date;
  previous?: StatusSnapshot | null;
  curated?: { incidents: Incident[]; maintenances: Maintenance[] };
};

type LatestCheckRow = { observed_at: number; response_ms: number | null };
type LatencyCheckRow = { observed_at: number; response_ms: number | null };

function checkedNow(now: () => Date) {
  const value = now();
  if (!Number.isFinite(value.getTime()))
    throw new TypeError("The store publisher clock is invalid");
  return value;
}

function dateAtUtcOffset(endDate: string, offset: number) {
  const midnight = Date.parse(`${endDate}T00:00:00.000Z`);
  return new Date(midnight + offset * DAY_MS).toISOString().slice(0, 10);
}

function unknownDay(date: string) {
  return {
    date,
    state: "unknown" as const,
    severity: "unknown" as const,
    uptime: null,
    downMinutes: 0,
    avgMs: null,
  };
}

/** Builds exactly HISTORY_DAYS entries ending on endDate; absent or stale-version rows stay unknown. */
function buildHistory(store: MonitorStore, componentId: string, endDate: string) {
  const fromDate = dateAtUtcOffset(endDate, -(HISTORY_DAYS - 1));
  const rows = store.readDays(componentId, fromDate, endDate);
  const rowByDate = new Map(
    rows.filter((row) => row.rollup_version === ROLLUP_VERSION).map((row) => [row.date, row]),
  );

  return Array.from({ length: HISTORY_DAYS }, (_, index) => {
    const date = dateAtUtcOffset(endDate, index - (HISTORY_DAYS - 1));
    const row = rowByDate.get(date);
    if (!row) return unknownDay(date);
    return {
      date,
      state: row.state as StatusState,
      severity: row.severity as "none" | "minor" | "major" | "unknown",
      uptime: row.uptime,
      downMinutes: row.down_minutes,
      avgMs: row.avg_ms,
    };
  });
}

/** Per-minute buckets of real samples over the strict trailing 60 minutes anchored on the
 * component's own newest check, mirroring publisher.ts's latencyHistory: gaps stay gaps. */
function buildLatency(store: MonitorStore, componentId: string, anchorSeconds: number) {
  const anchorMinute = Math.floor(anchorSeconds / 60) * 60;
  const cutoff = anchorMinute - 59 * 60;
  const rows = store.db
    .query(
      `SELECT observed_at, response_ms FROM checks
       WHERE component_id = ? AND observed_at >= ? AND observed_at <= ? AND response_ms IS NOT NULL
       ORDER BY observed_at ASC`,
    )
    // The upper bound is the raw anchor timestamp, not its truncated minute: the anchor check
    // itself (e.g. :45s into its minute) must stay inside its own bucket's window.
    .all(componentId, cutoff, anchorSeconds) as LatencyCheckRow[];

  const buckets = new Map<number, { total: number; count: number }>();
  for (const row of rows) {
    const bucketSeconds = Math.floor(row.observed_at / 60) * 60;
    const bucket = buckets.get(bucketSeconds) ?? { total: 0, count: 0 };
    bucket.total += row.response_ms as number;
    bucket.count += 1;
    buckets.set(bucketSeconds, bucket);
  }

  if (buckets.size === 0) return null;

  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([bucketSeconds, bucket]) => ({
      observedAt: new Date(bucketSeconds * 1000).toISOString(),
      avgMs: Math.round((bucket.total / bucket.count) * 100) / 100,
      sampleCount: bucket.count,
    }));
}

function sourceRevision(latestSeconds: number, componentIds: string[], curatedKeys: string[]) {
  const digest = createHash("sha256")
    .update(JSON.stringify({ componentIds, curatedKeys: curatedKeys.sort() }))
    .digest("hex");
  return `store-${latestSeconds}-${digest}`;
}

export function buildSnapshotFromStore(options: BuildSnapshotFromStoreOptions): StatusSnapshot {
  const { store, site, previous } = options;
  const now = options.now ?? (() => new Date());
  const nowDate = checkedNow(now);
  const endDate = nowDate.toISOString().slice(0, 10);

  // First pass: find each component's newest check so the overall generatedAt (the max) is
  // known before any per-component fallback needs it. This avoids a running maximum that
  // depends on component order.
  const latestChecks = site.components.map(
    (configured) =>
      store.db
        .query(
          `SELECT observed_at, response_ms FROM checks WHERE component_id = ? ORDER BY observed_at DESC LIMIT 1`,
        )
        .get(configured.componentId) as LatestCheckRow | null,
  );
  const latestSeconds = latestChecks.reduce(
    (max, row) => (row ? Math.max(max, row.observed_at) : max),
    0,
  );
  const generatedAt =
    latestSeconds > 0 ? new Date(latestSeconds * 1000).toISOString() : nowDate.toISOString();

  const components = site.components.map((configured, index) => {
    const componentId = configured.componentId;
    const latestCheck = latestChecks[index];

    const history = buildHistory(store, componentId, endDate);
    const state = history.at(-1)?.state ?? "unknown";
    // A component with no checks of its own still needs latestObservedAt <= generatedAt.
    const latestObservedAt = latestCheck
      ? new Date(latestCheck.observed_at * 1000).toISOString()
      : generatedAt;
    const latency = configured.showLatency
      ? latestCheck
        ? buildLatency(store, componentId, latestCheck.observed_at)
        : null
      : null;

    return {
      slug: componentId,
      name: configured.name,
      group: configured.group,
      state,
      latestObservedAt,
      responseTimeMs: latestCheck?.response_ms ?? null,
      latency,
      history,
    };
  });

  const isFresh =
    nowDate.getTime() - Date.parse(generatedAt) <= site.monitoring.staleAfterSeconds * 1000;
  const activeIncidents: StatusSnapshot["activeIncidents"] = options.curated
    ? options.curated.incidents.filter((incident) => incident.state !== "resolved")
    : (previous?.activeIncidents ?? []);
  const projectedMaintenance = options.curated?.maintenances.map((maintenance) => {
    if (maintenance.state !== "scheduled" && maintenance.state !== "active") return maintenance;
    const currentTime = nowDate.getTime();
    if (currentTime >= Date.parse(maintenance.endsAt))
      return { ...maintenance, state: "completed" as const };
    if (currentTime >= Date.parse(maintenance.startsAt))
      return { ...maintenance, state: "active" as const };
    return maintenance;
  });
  const scheduledMaintenance: StatusSnapshot["scheduledMaintenance"] = options.curated
    ? (projectedMaintenance ?? []).filter((maintenance) =>
        ["scheduled", "active", "verifying"].includes(maintenance.state),
      )
    : (previous?.scheduledMaintenance ?? []);
  const recentEvents: StatusSnapshot["recentEvents"] = options.curated
    ? [
        ...options.curated.incidents.filter((incident) => incident.state === "resolved"),
        ...(projectedMaintenance ?? []).filter((maintenance) =>
          ["completed", "cancelled"].includes(maintenance.state),
        ),
      ]
        .sort((a, b) =>
          (b.updates.at(-1)?.publishedAt ?? "").localeCompare(a.updates.at(-1)?.publishedAt ?? ""),
        )
        .slice(0, 100)
    : (previous?.recentEvents ?? []);
  const curatedKeys = options.curated
    ? [
        ...options.curated.incidents.map((event) => `incident:${event.slug}:${event.revision}`),
        ...options.curated.maintenances.map(
          (event) => `maintenance:${event.slug}:${event.revision}`,
        ),
      ]
    : [];

  const snapshot: StatusSnapshot = {
    schemaVersion: "1.0.0",
    generatedAt,
    latestCheckAt: generatedAt,
    sourceRevision: sourceRevision(
      latestSeconds,
      site.components.map((component) => component.componentId),
      curatedKeys,
    ),
    overallStatus: deriveOverallStatus({
      isFresh,
      componentStates: components.map((component) => component.state),
      activeIncidents,
      scheduledMaintenance,
    }),
    components,
    activeIncidents,
    scheduledMaintenance,
    recentEvents,
  };

  if (!validateStatusSnapshot(snapshot)) {
    throw new TypeError("The generated store snapshot failed contract validation");
  }

  return snapshot;
}

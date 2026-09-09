import { Database } from "bun:sqlite";
import {
  createHistoryImportBundle,
  type HistoryImportBundle,
  type HistoryImportBundleContent,
} from "@uptime-status/domain";
import type { HistoryExtractor } from "../registry";
import type { HistoryExtractionRequest, HistoryMapping } from "../request";

const DOWN = 0;
const SUSTAINED_DOWN_SECONDS = 600;

type DailyRow = {
  timestamp: number;
  ping: number;
  up: number;
  down: number;
  extras: string | null;
};

type HeartbeatRow = { timestamp: number; status: number };
type Interval = { start: number; end: number };

const REQUIRED_COLUMNS = {
  heartbeat: ["monitor_id", "important", "status", "time"],
  monitor: ["id"],
  stat_daily: ["monitor_id", "timestamp", "ping", "up", "down", "extras"],
} as const;

function assertSupportedRequest(request: HistoryExtractionRequest) {
  if (
    request.source.systemId !== "uptime-kuma" ||
    request.source.systemVersion !== "2.2.0" ||
    request.source.schemaVersion !== "kuma-2.2.0" ||
    request.artifact.kind !== "sqlite-backup" ||
    request.artifact.sourceTimeZone !== "UTC" ||
    request.options !== undefined
  ) {
    throw new Error("Uptime Kuma SQLite source version or options are not supported");
  }
  for (const mapping of request.mappings) {
    if (mapping.entityType !== "monitor" || !/^[1-9]\d*$/.test(mapping.externalId)) {
      throw new Error("Uptime Kuma mappings require positive numeric monitor IDs");
    }
  }
}

function assertSchema(database: Database) {
  const integrity = database.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get();
  if (integrity?.integrity_check !== "ok") {
    throw new Error("Uptime Kuma SQLite integrity check failed");
  }

  for (const [table, expected] of Object.entries(REQUIRED_COLUMNS)) {
    const columns = database
      .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
      .all()
      .map((column) => column.name);
    if (!expected.every((column) => columns.includes(column))) {
      throw new Error(`Unsupported Uptime Kuma SQLite schema: ${table}`);
    }
  }
}

function confirmedDownIntervals(rows: HeartbeatRow[], windowStart: number, cutoff: number) {
  const intervals: Interval[] = [];
  let downSince: number | null = null;

  for (const row of rows) {
    if (row.timestamp < windowStart) {
      downSince = row.status === DOWN ? windowStart : null;
      continue;
    }
    if (row.status === DOWN && downSince === null) downSince = row.timestamp;
    if (row.status !== DOWN && downSince !== null) {
      intervals.push({ start: downSince, end: Math.min(row.timestamp, cutoff) });
      downSince = null;
    }
  }
  if (downSince !== null && downSince < cutoff) intervals.push({ start: downSince, end: cutoff });
  return intervals;
}

function overlapSeconds(intervals: Interval[], start: number, end: number) {
  return intervals.reduce((total, interval) => {
    const overlap = Math.min(interval.end, end) - Math.max(interval.start, start);
    return total + Math.max(0, overlap);
  }, 0);
}

function longestOverlapSeconds(intervals: Interval[], start: number, end: number) {
  return intervals.reduce((longest, interval) => {
    const overlap = Math.min(interval.end, end) - Math.max(interval.start, start);
    return Math.max(longest, overlap);
  }, 0);
}

function maintenanceCount(extras: string | null) {
  if (!extras) return 0;
  try {
    const value = JSON.parse(extras) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
    const maintenance = (value as Record<string, unknown>).maintenance;
    return typeof maintenance === "number" && maintenance > 0 ? maintenance : 0;
  } catch {
    throw new Error("Uptime Kuma daily statistics contain invalid extras JSON");
  }
}

function dailyHistory(database: Database, mapping: HistoryMapping, cutoff: number) {
  const monitorId = Number(mapping.externalId);
  const monitor = database
    .query<{ id: number }, [number]>("SELECT id FROM monitor WHERE id = ?")
    .get(monitorId);
  if (!monitor) throw new Error(`Mapped Uptime Kuma monitor does not exist: ${mapping.externalId}`);

  const rows = database
    .query<DailyRow, [number, number]>(
      "SELECT timestamp, ping, up, down, extras FROM stat_daily WHERE monitor_id = ? AND timestamp + 86400 <= ? ORDER BY timestamp ASC",
    )
    .all(monitorId, cutoff)
    .filter((row) => row.up > 0 || row.down > 0 || maintenanceCount(row.extras) > 0);
  if (rows.length === 0) {
    throw new Error(
      `Mapped Uptime Kuma monitor has no completed UTC history: ${mapping.externalId}`,
    );
  }

  const windowStart = rows[0].timestamp;
  const heartbeats = database
    .query<HeartbeatRow, [number, number]>(
      "SELECT CAST(strftime('%s', time) AS INTEGER) AS timestamp, status FROM heartbeat WHERE monitor_id = ? AND important = 1 AND time <= datetime(?, 'unixepoch') ORDER BY time ASC",
    )
    .all(monitorId, cutoff);
  const intervals = confirmedDownIntervals(heartbeats, windowStart, cutoff);

  return rows.map((row) => {
    const start = row.timestamp;
    const end = start + 86_400;
    const downSeconds = overlapSeconds(intervals, start, end);
    const longestDown = longestOverlapSeconds(intervals, start, end);
    const maintenance = maintenanceCount(row.extras);
    const severity =
      downSeconds > 0 ? (longestDown >= SUSTAINED_DOWN_SECONDS ? "major" : "minor") : "none";
    const state =
      severity === "major"
        ? "major_outage"
        : severity === "minor"
          ? "degraded"
          : maintenance > 0
            ? "maintenance"
            : "operational";
    return {
      date: new Date(start * 1000).toISOString().slice(0, 10),
      state,
      severity,
      uptime: Math.round((100 - (downSeconds / 86_400) * 100) * 1000) / 1000,
      downMinutes: Math.round(downSeconds / 60),
      avgMs:
        row.up > 0 && Number.isFinite(row.ping) && row.ping >= 0
          ? Math.round(row.ping * 100) / 100
          : null,
    } as const;
  });
}

export class UptimeKumaSqliteExtractor implements HistoryExtractor {
  readonly id = "uptime-kuma-sqlite";
  readonly version = "1.0.0";

  async extract(request: HistoryExtractionRequest): Promise<HistoryImportBundle> {
    assertSupportedRequest(request);
    const database = new Database(request.artifact.path, { readonly: true, strict: true });
    try {
      database.run("PRAGMA query_only = ON");
      assertSchema(database);
      const cutoff = Math.floor(Date.parse(request.artifact.cutoffAt) / 1000);
      const content: HistoryImportBundleContent = {
        schemaVersion: "1.0.0",
        siteId: request.siteId,
        topologyRevision: request.topologyRevision,
        source: structuredClone(request.source),
        extraction: {
          adapterId: this.id,
          adapterVersion: this.version,
          artifactKind: request.artifact.kind,
          artifactSha256: request.artifact.sha256,
          cutoffAt: request.artifact.cutoffAt,
          exportedAt: request.artifact.exportedAt,
          sourceTimeZone: request.artifact.sourceTimeZone,
        },
        components: request.mappings.map((mapping) => {
          const history = dailyHistory(database, mapping, cutoff);
          return {
            componentId: mapping.componentId,
            sourceBinding: {
              sourceId: request.source.sourceId,
              entityType: mapping.entityType,
              externalId: mapping.externalId,
            },
            coverage: {
              startsOn: history[0].date,
              endsOn: history.at(-1)?.date ?? history[0].date,
            },
            history,
          };
        }),
      };
      return createHistoryImportBundle(content);
    } finally {
      database.close();
    }
  }
}

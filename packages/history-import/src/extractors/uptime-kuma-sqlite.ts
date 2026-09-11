import { Database } from "bun:sqlite";
import { pathToFileURL } from "node:url";
import {
  createHistoryImportBundle,
  type HistoryImportBundle,
  type HistoryImportBundleContent,
} from "@uptime-status/domain";
import { confirmedDownIntervals, rollUpDay, type UptimeCheckRow } from "@uptime-status/uptime-math";
import type { HistoryExtractor } from "../registry";
import type { HistoryExtractionRequest, HistoryMapping } from "../request";

type DailyRow = {
  timestamp: number;
  ping: number;
  up: number;
  down: number;
  extras: string | null;
};

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
    .query<UptimeCheckRow, [number, number]>(
      "SELECT CAST(strftime('%s', time) AS INTEGER) AS timestamp, status FROM heartbeat WHERE monitor_id = ? AND important = 1 AND time <= datetime(?, 'unixepoch') ORDER BY time ASC",
    )
    .all(monitorId, cutoff);
  const intervals = confirmedDownIntervals(heartbeats, windowStart, cutoff);

  return rows.map((row) =>
    rollUpDay({
      start: row.timestamp,
      intervals,
      maintenance: maintenanceCount(row.extras),
      up: row.up,
      ping: row.ping,
    }),
  );
}

export class UptimeKumaSqliteExtractor implements HistoryExtractor {
  readonly id = "uptime-kuma-sqlite";
  readonly version = "1.0.0";

  async extract(request: HistoryExtractionRequest): Promise<HistoryImportBundle> {
    assertSupportedRequest(request);
    const artifactUrl = pathToFileURL(request.artifact.path);
    artifactUrl.searchParams.set("immutable", "1");
    const database = new Database(artifactUrl.href, { readonly: true, strict: true });
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

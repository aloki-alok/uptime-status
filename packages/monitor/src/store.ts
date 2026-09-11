// SQLite-backed store for live-probed checks and their daily rollups.
// Rollup arithmetic is never done here: it is delegated to @uptime-status/uptime-math
// so a day computed from an import and a day computed from our own probes agree exactly.
import { Database } from "bun:sqlite";
import {
  rollUpDay as computeRollUpDay,
  confirmedDownIntervals,
  type UptimeCheckRow,
} from "@uptime-status/uptime-math";

export const ROLLUP_VERSION = 1;

const DAY_SECONDS = 86_400;

export type RecordCheckInput = {
  componentId: string;
  observedAt: number;
  status: number;
  responseMs?: number | null;
};

export type DailyRow = {
  component_id: string;
  date: string;
  state: string;
  severity: string;
  uptime: number | null;
  down_minutes: number;
  avg_ms: number | null;
  rollup_version: number;
  origin: "native" | "import";
  import_id: string | null;
};

/**
 * Raw checks exist only to compute the current day and finalise the previous one after UTC
 * midnight. The page renders 60 minutes of latency and 90 days of rollups, so nothing reads
 * checks older than that. Three days is the functional floor plus a day of slack; a constant
 * rather than config because no deployment has a reason to change it.
 */
export const CHECK_RETENTION_DAYS = 3;

export type PruneOptions = { dailyDays: number };
export type PruneResult = { daily: number; checks: number };

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS checks(
    component_id TEXT NOT NULL,
    observed_at INTEGER NOT NULL,
    status INTEGER NOT NULL,
    response_ms INTEGER,
    PRIMARY KEY(component_id, observed_at)
  );
  CREATE TABLE IF NOT EXISTS daily(
    component_id TEXT NOT NULL,
    date TEXT NOT NULL,
    state TEXT NOT NULL,
    severity TEXT NOT NULL,
    uptime REAL,
    down_minutes INTEGER NOT NULL,
    avg_ms REAL,
    rollup_version INTEGER NOT NULL,
    origin TEXT NOT NULL CHECK(origin IN ('native','import')),
    import_id TEXT,
    PRIMARY KEY(component_id, date)
  );
  CREATE INDEX IF NOT EXISTS idx_daily_date ON daily(date);
  CREATE INDEX IF NOT EXISTS idx_checks_observed_at ON checks(observed_at);
`;

function utcDayStart(seconds: number): number {
  return Math.floor(seconds / DAY_SECONDS) * DAY_SECONDS;
}

function isoDate(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

export class MonitorStore {
  readonly db: Database;

  constructor(dbOrPath: Database | string) {
    this.db = dbOrPath instanceof Database ? dbOrPath : new Database(dbOrPath, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
  }

  static open(path: string): MonitorStore {
    return new MonitorStore(path);
  }

  recordCheck(input: RecordCheckInput): void {
    this.db.run(
      `INSERT INTO checks (component_id, observed_at, status, response_ms)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(component_id, observed_at) DO UPDATE SET
         status = excluded.status,
         response_ms = excluded.response_ms`,
      [input.componentId, input.observedAt, input.status, input.responseMs ?? null],
    );
  }

  /** Rolls up one UTC day from its own check rows and upserts it as origin 'native'. */
  rollUpDay(componentId: string, utcDayStartSeconds: number) {
    const start = utcDayStart(utcDayStartSeconds);
    const end = start + DAY_SECONDS;

    const dayRows = this.db
      .query(
        `SELECT observed_at, status, response_ms FROM checks
         WHERE component_id = ? AND observed_at >= ? AND observed_at < ?
         ORDER BY observed_at ASC`,
      )
      .all(componentId, start, end) as {
      observed_at: number;
      status: number;
      response_ms: number | null;
    }[];

    // A single prior row carries the down/up state across the day boundary.
    const priorRow = this.db
      .query(
        `SELECT observed_at, status FROM checks
         WHERE component_id = ? AND observed_at < ?
         ORDER BY observed_at DESC LIMIT 1`,
      )
      .get(componentId, start) as { observed_at: number; status: number } | null;

    const rowsForIntervals: UptimeCheckRow[] = [
      ...(priorRow ? [{ timestamp: priorRow.observed_at, status: priorRow.status }] : []),
      ...dayRows.map((row) => ({ timestamp: row.observed_at, status: row.status })),
    ];

    const intervals = confirmedDownIntervals(rowsForIntervals, start, end);

    const up = dayRows.filter((row) => row.status === 1).length;
    const withPing = dayRows.filter((row) => row.response_ms != null);
    const ping =
      withPing.length > 0
        ? withPing.reduce((sum, row) => sum + (row.response_ms ?? 0), 0) / withPing.length
        : 0;

    const result = computeRollUpDay({ start, intervals, up, ping });

    this.db.run(
      `INSERT INTO daily (component_id, date, state, severity, uptime, down_minutes, avg_ms, rollup_version, origin, import_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'native', NULL)
       ON CONFLICT(component_id, date) DO UPDATE SET
         state = excluded.state,
         severity = excluded.severity,
         uptime = excluded.uptime,
         down_minutes = excluded.down_minutes,
         avg_ms = excluded.avg_ms,
         rollup_version = excluded.rollup_version,
         origin = excluded.origin,
         import_id = excluded.import_id
       WHERE daily.origin != 'import'`,
      [
        componentId,
        result.date,
        result.state,
        result.severity,
        result.uptime,
        result.downMinutes,
        result.avgMs,
        ROLLUP_VERSION,
      ],
    );

    return result;
  }

  readDays(componentId: string, fromDate: string, toDate: string): DailyRow[] {
    return this.db
      .query(
        `SELECT * FROM daily WHERE component_id = ? AND date >= ? AND date <= ? ORDER BY date ASC`,
      )
      .all(componentId, fromDate, toDate) as DailyRow[];
  }

  prune({ dailyDays }: PruneOptions): PruneResult {
    const todayStart = utcDayStart(Math.floor(Date.now() / 1000));
    const dailyCutoffDate = isoDate(todayStart - dailyDays * DAY_SECONDS);
    const checksCutoffTs = todayStart - CHECK_RETENTION_DAYS * DAY_SECONDS;

    this.db.exec("BEGIN");
    try {
      const daily = (
        this.db.query(`SELECT COUNT(*) AS n FROM daily WHERE date < ?`).get(dailyCutoffDate) as {
          n: number;
        }
      ).n;
      const checks = (
        this.db
          .query(`SELECT COUNT(*) AS n FROM checks WHERE observed_at < ?`)
          .get(checksCutoffTs) as {
          n: number;
        }
      ).n;
      this.db.run(`DELETE FROM daily WHERE date < ?`, [dailyCutoffDate]);
      this.db.run(`DELETE FROM checks WHERE observed_at < ?`, [checksCutoffTs]);
      this.db.exec("COMMIT");
      return { daily, checks };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}

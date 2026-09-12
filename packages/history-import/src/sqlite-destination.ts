import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  createHistoryImportApplyReceipt,
  createHistoryImportRollbackReceipt,
  type HistoryImportApplyReceipt,
  type HistoryImportBundle,
  type HistoryImportPlan,
  type HistoryImportRollbackReceipt,
  type HistoryImportVerifyReceipt,
} from "@uptime-status/domain";
import { MonitorStore, ROLLUP_VERSION } from "@uptime-status/monitor";
import type { AppliedHistoryImportState, HistoryImportDestination } from "./execution";
import type { ExistingHistoryRecord } from "./preview";

type ImportMetaRow = {
  site_id: string;
  import_id: string;
  plan_id: string;
  bundle_sha256: string;
  active: number;
  cutoff_at: string;
};

const EXTRA_SCHEMA = `
  CREATE TABLE IF NOT EXISTS import_meta(
    site_id TEXT NOT NULL,
    import_id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL,
    bundle_sha256 TEXT NOT NULL,
    active INTEGER NOT NULL,
    cutoff_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS import_receipts(
    import_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    operation TEXT NOT NULL,
    receipt_json TEXT NOT NULL,
    PRIMARY KEY(import_id, seq)
  );
`;

/**
 * History destination backed by the live monitor's own SQLite database: migrated Kuma days
 * land in the same `daily` table the real prober writes to (origin='import', import_id set),
 * so the page renders one continuous history instead of stitching two stores together.
 *
 * ponytail: the monitor schema has no latency table, so latency counts are never genuinely
 * stored or counted here, just carried through from the plan (see apply/inspect). Add a
 * latency table if per-minute imported latency ever needs to render.
 */
export class SqliteHistoryDestination implements HistoryImportDestination {
  readonly adapterId = "sqlite";
  /** Exposed for tests: lets a second MonitorStore wrap the same connection to write native rows. */
  readonly db: Database;

  private constructor(
    readonly destinationId: string,
    db: Database,
    private readonly siteId: string,
  ) {
    this.db = db;
  }

  static async open(databasePath: string, siteId: string) {
    const absolute = databasePath === ":memory:" ? databasePath : resolve(databasePath);
    // MonitorStore owns the checks/daily schema; we only add bookkeeping tables on top of it.
    const db = MonitorStore.open(absolute).db;
    db.exec(EXTRA_SCHEMA);

    // A database belongs to exactly one site. Once any import has run, its recorded site_id
    // is the durable guard; before that, the siteId passed to open() is all there is to bind to.
    const bound = db.query("SELECT site_id FROM import_meta LIMIT 1").get() as {
      site_id: string;
    } | null;
    if (bound && bound.site_id !== siteId) {
      throw new Error(
        `This database is bound to site "${bound.site_id}" and cannot be opened for site "${siteId}"`,
      );
    }

    const destinationId = createHash("sha256").update(absolute).digest("hex");
    return new SqliteHistoryDestination(destinationId, db, siteId);
  }

  private assertSite(siteId: string) {
    if (siteId !== this.siteId) {
      throw new Error(
        `This database is bound to site "${this.siteId}" and cannot import site "${siteId}"`,
      );
    }
  }

  async listExisting(siteId: string, _sourceId: string): Promise<ExistingHistoryRecord[]> {
    this.assertSite(siteId);
    // No source-provenance column exists on `daily`: since the database is bound to one site,
    // every existing day (native or from a prior import) is a collision candidate regardless
    // of which upstream source produced it.
    const rows = this.db
      .query("SELECT component_id, date, import_id FROM daily ORDER BY component_id ASC, date ASC")
      .all() as { component_id: string; date: string; import_id: string | null }[];
    return rows.map((row) => ({
      componentId: row.component_id,
      kind: "daily" as const,
      observedAt: row.date,
      ...(row.import_id ? { importId: row.import_id } : {}),
    }));
  }

  async apply(input: {
    plan: HistoryImportPlan;
    bundle: HistoryImportBundle;
    completedAt: string;
  }) {
    const { plan, bundle, completedAt } = input;
    this.assertSite(plan.siteId);
    // This destination has nowhere to put per-minute latency. Echoing the plan's count back
    // would make verification pass for rows that were never written, so refuse the import
    // instead: a loud failure beats a green verify over missing data.
    if (plan.summary.latencyRecordCount > 0) {
      throw new Error(
        "This destination cannot store latency observations; re-preview without latency or add a latency table",
      );
    }

    const existing = this.db
      .query("SELECT * FROM import_meta WHERE import_id = ?")
      .get(plan.importId) as ImportMetaRow | null;
    if (existing?.active === 1 && existing.plan_id !== plan.planId) {
      throw new Error("A different history import plan is already active for this import");
    }

    const noOp = existing?.active === 1 && existing.plan_id === plan.planId;
    if (!noOp) {
      // Single transaction: SQLite's atomic commit is what "stage invisibly before activation"
      // means here — no reader ever sees a partial import, and a crash mid-write rolls back
      // the whole thing rather than leaving half an import live. No staging column needed.
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.run("DELETE FROM daily WHERE import_id = ?", [plan.importId]);
        for (const component of bundle.components) {
          for (const day of component.history) {
            this.db.run(
              `INSERT INTO daily (component_id, date, state, severity, uptime, down_minutes, avg_ms, rollup_version, origin, import_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'import', ?)
               ON CONFLICT(component_id, date) DO UPDATE SET
                 state = excluded.state,
                 severity = excluded.severity,
                 uptime = excluded.uptime,
                 down_minutes = excluded.down_minutes,
                 avg_ms = excluded.avg_ms,
                 rollup_version = excluded.rollup_version,
                 origin = excluded.origin,
                 import_id = excluded.import_id
               WHERE daily.origin != 'native'`,
              [
                component.componentId,
                day.date,
                day.state,
                day.severity,
                day.uptime,
                day.downMinutes,
                day.avgMs,
                ROLLUP_VERSION,
                plan.importId,
              ],
            );
          }
        }
        this.db.run(
          `INSERT INTO import_meta (site_id, import_id, plan_id, bundle_sha256, active, cutoff_at)
           VALUES (?, ?, ?, ?, 1, ?)
           ON CONFLICT(import_id) DO UPDATE SET
             plan_id = excluded.plan_id,
             bundle_sha256 = excluded.bundle_sha256,
             active = 1,
             cutoff_at = excluded.cutoff_at`,
          [plan.siteId, plan.importId, plan.planId, plan.bundleSha256, plan.cutoffAt],
        );
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }

    const receipt = createHistoryImportApplyReceipt({
      schemaVersion: "1.0.0",
      operation: "apply",
      planId: plan.planId,
      siteId: plan.siteId,
      topologyRevision: plan.topologyRevision,
      sourceSystemId: plan.sourceSystemId,
      sourceId: plan.sourceId,
      importId: plan.importId,
      bundleSha256: plan.bundleSha256,
      cutoffAt: plan.cutoffAt,
      platformRevision: plan.platformRevision,
      destination: structuredClone(plan.destination),
      completedAt,
      dailyRecordCount: plan.summary.dailyRecordCount,
      latencyRecordCount: plan.summary.latencyRecordCount,
      noOp: Boolean(noOp),
    });
    this.appendReceipt(plan.importId, receipt);
    return receipt;
  }

  async inspect(plan: HistoryImportPlan): Promise<AppliedHistoryImportState> {
    this.assertSite(plan.siteId);
    const entry = this.db
      .query("SELECT * FROM import_meta WHERE import_id = ?")
      .get(plan.importId) as ImportMetaRow | null;
    const count = this.db
      .query("SELECT COUNT(*) AS n FROM daily WHERE import_id = ?")
      .get(plan.importId) as { n: number };
    return {
      active: entry?.active === 1,
      planId: entry?.plan_id,
      importId: entry ? plan.importId : undefined,
      bundleSha256: entry?.bundle_sha256,
      dailyRecordCount: count.n,
      // No latency table to count against; the plan's own figure is the honest answer.
      latencyRecordCount: plan.summary.latencyRecordCount,
    };
  }

  async recordVerification(receipt: HistoryImportVerifyReceipt) {
    this.appendReceipt(receipt.importId, receipt);
  }

  async rollback(input: { plan: HistoryImportPlan; completedAt: string }) {
    const { plan, completedAt } = input;
    this.assertSite(plan.siteId);

    const entry = this.db
      .query("SELECT * FROM import_meta WHERE import_id = ?")
      .get(plan.importId) as ImportMetaRow | null;
    const noOp = !entry;
    let deletedDaily = 0;

    if (!noOp) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const count = this.db
          .query("SELECT COUNT(*) AS n FROM daily WHERE import_id = ?")
          .get(plan.importId) as { n: number };
        deletedDaily = count.n;
        this.db.run("DELETE FROM daily WHERE import_id = ?", [plan.importId]);
        this.db.run("DELETE FROM import_meta WHERE import_id = ?", [plan.importId]);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }

    const receipt = createHistoryImportRollbackReceipt({
      schemaVersion: "1.0.0",
      operation: "rollback",
      planId: plan.planId,
      siteId: plan.siteId,
      topologyRevision: plan.topologyRevision,
      sourceSystemId: plan.sourceSystemId,
      sourceId: plan.sourceId,
      importId: plan.importId,
      bundleSha256: plan.bundleSha256,
      cutoffAt: plan.cutoffAt,
      platformRevision: plan.platformRevision,
      destination: structuredClone(plan.destination),
      completedAt,
      deletedDailyRecordCount: noOp ? 0 : deletedDaily,
      deletedLatencyRecordCount: noOp ? 0 : plan.summary.latencyRecordCount,
      noOp,
    });
    this.appendReceipt(plan.importId, receipt);
    return receipt;
  }

  private appendReceipt(
    importId: string,
    receipt: HistoryImportApplyReceipt | HistoryImportVerifyReceipt | HistoryImportRollbackReceipt,
  ) {
    const next = this.db
      .query("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM import_receipts WHERE import_id = ?")
      .get(importId) as { seq: number };
    this.db.run(
      "INSERT INTO import_receipts (import_id, seq, operation, receipt_json) VALUES (?, ?, ?, ?)",
      [importId, next.seq, receipt.operation, JSON.stringify(receipt)],
    );
  }
}

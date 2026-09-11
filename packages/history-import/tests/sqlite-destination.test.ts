import { describe, expect, test } from "bun:test";
import { createHistoryImportBundle } from "@uptime-status/domain";
import { MonitorStore } from "@uptime-status/monitor";
import {
  applyHistoryImport,
  previewHistoryImport,
  rollbackHistoryImport,
  SqliteHistoryDestination,
  verifyAppliedHistoryImport,
} from "../src";

async function setup(siteId = "site-a") {
  const destination = await SqliteHistoryDestination.open(":memory:", siteId);
  const bundle = createHistoryImportBundle({
    schemaVersion: "1.0.0",
    siteId,
    topologyRevision: "topology-001",
    source: { systemId: "uptime-kuma", sourceId: "primary" },
    extraction: {
      adapterId: "uptime-kuma-sqlite",
      adapterVersion: "1.0.0",
      artifactKind: "sqlite-backup",
      artifactSha256: "a".repeat(64),
      cutoffAt: "2026-09-10T00:00:00Z",
      exportedAt: "2026-09-10T00:05:00Z",
      sourceTimeZone: "UTC",
    },
    components: [
      {
        componentId: "api",
        sourceBinding: { sourceId: "primary", entityType: "monitor", externalId: "11" },
        coverage: { startsOn: "2026-09-08", endsOn: "2026-09-09" },
        history: [
          {
            date: "2026-09-08",
            state: "operational",
            severity: "none",
            uptime: 100,
            downMinutes: 0,
            avgMs: 75,
          },
          {
            date: "2026-09-09",
            state: "operational",
            severity: "none",
            uptime: 100,
            downMinutes: 0,
            avgMs: 80,
          },
        ],
      },
    ],
  });
  const bundleSha256 = "b".repeat(64);
  const plan = previewHistoryImport({
    bundle,
    bundleSha256,
    platformRevision: "revision-001",
    destination: { adapterId: destination.adapterId, destinationId: destination.destinationId },
    createdAt: "2026-09-11T10:00:00.000Z",
  });
  return { destination, bundle, bundleSha256, plan };
}

function receiptOps(destination: SqliteHistoryDestination, importId: string) {
  return (
    destination.db
      .query("SELECT operation FROM import_receipts WHERE import_id = ? ORDER BY seq ASC")
      .all(importId) as { operation: string }[]
  ).map((row) => row.operation);
}

describe("sqlite history destination", () => {
  test("apply is idempotent and writes rows once", async () => {
    const context = await setup();
    const first = await applyHistoryImport({ ...context, completedAt: "2026-09-11T10:05:00.000Z" });
    const repeated = await applyHistoryImport({
      ...context,
      completedAt: "2026-09-11T10:06:00.000Z",
    });

    expect(first.noOp).toBe(false);
    expect(repeated.noOp).toBe(true);

    const rows = context.destination.db
      .query(
        "SELECT date, origin, import_id FROM daily WHERE component_id = 'api' ORDER BY date ASC",
      )
      .all() as { date: string; origin: string; import_id: string }[];
    expect(rows).toEqual([
      { date: "2026-09-08", origin: "import", import_id: context.bundle.importId },
      { date: "2026-09-09", origin: "import", import_id: context.bundle.importId },
    ]);
  });

  test("rollback never deletes a native day written by the live monitor", async () => {
    const context = await setup();
    const store = new MonitorStore(context.destination.db);
    store.recordCheck({
      componentId: "api",
      observedAt: Date.parse("2026-09-05T00:10:00Z") / 1000,
      status: 1,
    });
    store.rollUpDay("api", Date.parse("2026-09-05T00:00:00Z") / 1000);

    await applyHistoryImport({ ...context, completedAt: "2026-09-11T10:05:00.000Z" });
    await rollbackHistoryImport({ ...context, completedAt: "2026-09-11T10:07:00.000Z" });

    const remaining = context.destination.db
      .query("SELECT date, origin FROM daily ORDER BY date ASC")
      .all() as { date: string; origin: string }[];
    expect(remaining).toEqual([{ date: "2026-09-05", origin: "native" }]);
  });

  test("rollback is scoped, idempotent, and receipts land in the expected sequence", async () => {
    const context = await setup();
    await applyHistoryImport({ ...context, completedAt: "2026-09-11T10:05:00.000Z" });
    await verifyAppliedHistoryImport({ ...context, completedAt: "2026-09-11T10:06:00.000Z" });
    const first = await rollbackHistoryImport({
      ...context,
      completedAt: "2026-09-11T10:07:00.000Z",
    });
    const repeated = await rollbackHistoryImport({
      ...context,
      completedAt: "2026-09-11T10:08:00.000Z",
    });

    expect(first).toMatchObject({ deletedDailyRecordCount: 2, noOp: false });
    expect(repeated).toMatchObject({ deletedDailyRecordCount: 0, noOp: true });

    const remaining = context.destination.db.query("SELECT COUNT(*) AS n FROM daily").get() as {
      n: number;
    };
    expect(remaining.n).toBe(0);
    expect(receiptOps(context.destination, context.bundle.importId)).toEqual([
      "apply",
      "verify",
      "rollback",
      "rollback",
    ]);
  });

  test("rejects importing a different site's bundle into a bound database", async () => {
    const context = await setup("site-a");
    const other = await setup("site-b");

    await expect(
      applyHistoryImport({
        plan: other.plan,
        bundle: other.bundle,
        bundleSha256: other.bundleSha256,
        destination: context.destination,
        completedAt: "2026-09-11T10:05:00.000Z",
      }),
    ).rejects.toThrow('cannot import site "site-b"');
  });

  test("inspect counts are read live from the table, not cached", async () => {
    const context = await setup();
    await applyHistoryImport({ ...context, completedAt: "2026-09-11T10:05:00.000Z" });

    const before = await context.destination.inspect(context.plan);
    expect(before.dailyRecordCount).toBe(2);

    context.destination.db.run("DELETE FROM daily WHERE date = '2026-09-08'");

    const after = await context.destination.inspect(context.plan);
    expect(after.dailyRecordCount).toBe(1);
    expect(after.active).toBe(true);
    expect(after.planId).toBe(context.plan.planId);
    expect(after.bundleSha256).toBe(context.plan.bundleSha256);
  });

  test("refuses a bundle carrying latency rather than verifying rows it cannot store", async () => {
    const destination = await SqliteHistoryDestination.open(":memory:", "site-a");
    const bundle = createHistoryImportBundle({
      schemaVersion: "1.0.0",
      siteId: "site-a",
      topologyRevision: "topology-001",
      source: { systemId: "uptime-kuma", sourceId: "primary" },
      extraction: {
        adapterId: "uptime-kuma-sqlite",
        adapterVersion: "1.0.0",
        artifactKind: "sqlite-backup",
        artifactSha256: "a".repeat(64),
        cutoffAt: "2026-09-10T00:00:00Z",
        exportedAt: "2026-09-10T00:05:00Z",
        sourceTimeZone: "UTC",
      },
      components: [
        {
          componentId: "api",
          sourceBinding: { sourceId: "primary", entityType: "monitor", externalId: "11" },
          coverage: { startsOn: "2026-09-09", endsOn: "2026-09-09" },
          history: [
            {
              date: "2026-09-09",
              state: "operational",
              severity: "none",
              uptime: 100,
              downMinutes: 0,
              avgMs: 80,
            },
          ],
          latency: [{ observedAt: "2026-09-09T23:00:00Z", avgMs: 81, sampleCount: 3 }],
        },
      ],
    });
    const bundleSha256 = "b".repeat(64);
    const plan = previewHistoryImport({
      bundle,
      bundleSha256,
      platformRevision: "revision-001",
      destination: { adapterId: destination.adapterId, destinationId: destination.destinationId },
      createdAt: "2026-09-11T10:00:00.000Z",
    });
    expect(plan.summary.latencyRecordCount).toBeGreaterThan(0);

    await expect(
      applyHistoryImport({
        plan,
        bundle,
        bundleSha256,
        destination,
        completedAt: "2026-09-11T10:05:00.000Z",
      }),
    ).rejects.toThrow("cannot store latency");
  });
});

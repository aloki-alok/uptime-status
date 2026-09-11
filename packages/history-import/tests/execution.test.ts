import { describe, expect, test } from "bun:test";
import {
  createHistoryImportApplyReceipt,
  createHistoryImportBundle,
  createHistoryImportPlan,
  createHistoryImportRollbackReceipt,
  type HistoryImportApplyReceipt,
  type HistoryImportBundle,
  type HistoryImportPlan,
  type HistoryImportRollbackReceipt,
} from "@uptime-status/domain";
import {
  applyHistoryImport,
  type HistoryImportDestination,
  rollbackHistoryImport,
  verifyAppliedHistoryImport,
} from "../src/execution";

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

function planFor(input: HistoryImportBundle = bundle) {
  return createHistoryImportPlan({
    schemaVersion: "1.0.0",
    siteId: input.siteId,
    topologyRevision: input.topologyRevision,
    sourceSystemId: input.source.systemId,
    sourceId: input.source.sourceId,
    importId: input.importId,
    bundleSha256: "b".repeat(64),
    cutoffAt: input.extraction.cutoffAt,
    platformRevision: "revision-001",
    destination: { adapterId: "test", destinationId: "history-a" },
    createdAt: "2026-09-11T10:00:00.000Z",
    summary: {
      componentCount: 1,
      dailyRecordCount: 1,
      latencyRecordCount: 1,
      gapCount: 0,
      collisionCount: 0,
      unsupportedRecordCount: 0,
      proposedWriteCount: 2,
    },
    components: [
      {
        componentId: "api",
        coverage: { startsOn: "2026-09-09", endsOn: "2026-09-09" },
        dailyRecordCount: 1,
        latencyRecordCount: 1,
        gaps: [],
        collisions: [],
      },
    ],
  });
}

class RecordingDestination implements HistoryImportDestination {
  readonly adapterId = "test";
  readonly destinationId = "history-a";
  active = false;
  storedPlanId?: string;
  storedImportId?: string;
  daily = 0;
  latency = 0;
  readonly operations: string[] = [];
  readonly receipts: Array<
    HistoryImportApplyReceipt | HistoryImportRollbackReceipt | { operation: "verify" }
  > = [];

  async listExisting() {
    return [];
  }

  async apply({
    plan,
    bundle: input,
    completedAt,
  }: {
    plan: HistoryImportPlan;
    bundle: HistoryImportBundle;
    completedAt: string;
  }) {
    this.operations.push("stage", "activate");
    const noOp = this.active && this.storedPlanId === plan.planId;
    this.storedPlanId = plan.planId;
    this.storedImportId = input.importId;
    this.daily = input.components.reduce((sum, component) => sum + component.history.length, 0);
    this.latency = input.components.reduce(
      (sum, component) => sum + (component.latency?.length ?? 0),
      0,
    );
    this.active = true;
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
      destination: plan.destination,
      completedAt,
      dailyRecordCount: this.daily,
      latencyRecordCount: this.latency,
      noOp,
    });
    this.receipts.push(receipt);
    return receipt;
  }

  async inspect() {
    return {
      active: this.active,
      planId: this.storedPlanId,
      importId: this.storedImportId,
      bundleSha256: planFor().bundleSha256,
      dailyRecordCount: this.daily,
      latencyRecordCount: this.latency,
    };
  }

  async recordVerification(receipt: { operation: "verify" }) {
    this.receipts.push(receipt);
  }

  async rollback({ plan, completedAt }: { plan: HistoryImportPlan; completedAt: string }) {
    this.operations.push("deactivate", "delete-import-records");
    const noOp = !this.active && this.daily === 0 && this.latency === 0;
    const result = createHistoryImportRollbackReceipt({
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
      destination: plan.destination,
      completedAt,
      deletedDailyRecordCount: this.daily,
      deletedLatencyRecordCount: this.latency,
      noOp,
    });
    this.active = false;
    this.daily = 0;
    this.latency = 0;
    this.receipts.push(result);
    return result;
  }
}

describe("history import execution", () => {
  test("stages before activation, verifies exact bindings, and rolls back only imported rows", async () => {
    const destination = new RecordingDestination();
    const plan = planFor();
    const applied = await applyHistoryImport({
      plan,
      bundle,
      bundleSha256: plan.bundleSha256,
      destination,
      completedAt: "2026-09-11T10:05:00.000Z",
    });
    expect(destination.operations).toEqual(["stage", "activate"]);
    expect(applied.noOp).toBe(false);

    const verified = await verifyAppliedHistoryImport({
      plan,
      bundle,
      bundleSha256: plan.bundleSha256,
      destination,
      completedAt: "2026-09-11T10:06:00.000Z",
    });
    expect(verified.dailyRecordCount).toBe(1);

    const rolledBack = await rollbackHistoryImport({
      plan,
      bundle,
      bundleSha256: plan.bundleSha256,
      destination,
      completedAt: "2026-09-11T10:07:00.000Z",
    });
    expect(destination.operations.slice(-2)).toEqual(["deactivate", "delete-import-records"]);
    expect(rolledBack.deletedLatencyRecordCount).toBe(1);
    expect(destination.receipts).toHaveLength(3);
  });

  test("fails closed before writes on collisions, digest drift, or destination drift", async () => {
    const destination = new RecordingDestination();
    const plan = planFor();
    await expect(
      applyHistoryImport({
        plan: {
          ...plan,
          summary: { ...plan.summary, collisionCount: 1 },
        },
        bundle,
        bundleSha256: plan.bundleSha256,
        destination,
        completedAt: "2026-09-11T10:05:00.000Z",
      }),
    ).rejects.toThrow();
    await expect(
      applyHistoryImport({
        plan,
        bundle,
        bundleSha256: "c".repeat(64),
        destination,
        completedAt: "2026-09-11T10:05:00.000Z",
      }),
    ).rejects.toThrow("bundle digest");
    Object.defineProperty(destination, "destinationId", { value: "other" });
    await expect(
      applyHistoryImport({
        plan,
        bundle,
        bundleSha256: plan.bundleSha256,
        destination,
        completedAt: "2026-09-11T10:05:00.000Z",
      }),
    ).rejects.toThrow("destination");
    expect(destination.operations).toEqual([]);
  });
});

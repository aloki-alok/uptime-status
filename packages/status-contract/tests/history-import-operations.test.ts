import { describe, expect, test } from "bun:test";
import {
  createHistoryImportApplyReceipt,
  createHistoryImportPlan,
  createHistoryImportRollbackReceipt,
  createHistoryImportVerifyReceipt,
  validateHistoryImportApplyReceipt,
  validateHistoryImportPlan,
  validateHistoryImportRollbackReceipt,
  validateHistoryImportVerifyReceipt,
} from "../src/history-import-operations";

const binding = {
  siteId: "site-a",
  topologyRevision: "topology-001",
  sourceSystemId: "uptime-kuma",
  sourceId: "primary",
  importId: "a".repeat(64),
  bundleSha256: "b".repeat(64),
  cutoffAt: "2026-09-10T00:00:00Z",
  platformRevision: "914abbd4cc9120736f9ee8ffad9d16fd7c2aee35",
  destination: { adapterId: "memory", destinationId: "preview-history" },
};

const summary = {
  componentCount: 1,
  dailyRecordCount: 2,
  latencyRecordCount: 1,
  gapCount: 1,
  collisionCount: 1,
  unsupportedRecordCount: 0,
  proposedWriteCount: 3,
};

describe("history import operation contracts", () => {
  test("creates a strict deterministic preview plan", () => {
    const content = {
      schemaVersion: "1.0.0" as const,
      ...binding,
      createdAt: "2026-09-11T10:00:00.000Z",
      summary,
      components: [
        {
          componentId: "api",
          coverage: { startsOn: "2026-09-07", endsOn: "2026-09-09" },
          dailyRecordCount: 2,
          latencyRecordCount: 1,
          gaps: ["2026-09-08"],
          collisions: [{ kind: "daily" as const, observedAt: "2026-09-07" }],
        },
      ],
    };
    const first = createHistoryImportPlan(content);
    const second = createHistoryImportPlan(structuredClone(content));
    expect(first).toEqual(second);
    expect(validateHistoryImportPlan(first)).toBe(true);
    expect(validateHistoryImportPlan({ ...first, planId: "f".repeat(64) })).toBe(false);
    expect(validateHistoryImportPlan({ ...first, unexpected: true })).toBe(false);
  });

  test("creates operation-specific immutable receipts bound to the reviewed plan", () => {
    const plan = createHistoryImportPlan({
      schemaVersion: "1.0.0",
      ...binding,
      createdAt: "2026-09-11T10:00:00.000Z",
      summary,
      components: [
        {
          componentId: "api",
          coverage: { startsOn: "2026-09-07", endsOn: "2026-09-09" },
          dailyRecordCount: 2,
          latencyRecordCount: 1,
          gaps: ["2026-09-08"],
          collisions: [{ kind: "daily", observedAt: "2026-09-07" }],
        },
      ],
    });
    const common = {
      schemaVersion: "1.0.0" as const,
      ...binding,
      planId: plan.planId,
      completedAt: "2026-09-11T10:05:00.000Z",
    };
    const applied = createHistoryImportApplyReceipt({
      ...common,
      operation: "apply",
      dailyRecordCount: 2,
      latencyRecordCount: 1,
      noOp: false,
    });
    const verified = createHistoryImportVerifyReceipt({
      ...common,
      operation: "verify",
      dailyRecordCount: 2,
      latencyRecordCount: 1,
    });
    const rolledBack = createHistoryImportRollbackReceipt({
      ...common,
      operation: "rollback",
      deletedDailyRecordCount: 2,
      deletedLatencyRecordCount: 1,
      noOp: false,
    });

    expect(validateHistoryImportApplyReceipt(applied, plan)).toBe(true);
    expect(validateHistoryImportVerifyReceipt(verified, plan)).toBe(true);
    expect(validateHistoryImportRollbackReceipt(rolledBack, plan)).toBe(true);
    expect(applied.receiptId).not.toBe(verified.receiptId);
    expect(validateHistoryImportApplyReceipt({ ...applied, operation: "verify" })).toBe(false);
    expect(validateHistoryImportVerifyReceipt({ ...verified, importId: "c".repeat(64) })).toBe(
      false,
    );
    expect(
      validateHistoryImportVerifyReceipt(
        createHistoryImportVerifyReceipt({
          ...common,
          operation: "verify",
          dailyRecordCount: 1,
          latencyRecordCount: 1,
        }),
        plan,
      ),
    ).toBe(false);
    expect(validateHistoryImportApplyReceipt(applied, { ...plan, sourceId: "secondary" })).toBe(
      false,
    );
  });
});

import {
  createHistoryImportVerifyReceipt,
  type HistoryImportApplyReceipt,
  type HistoryImportBundle,
  type HistoryImportPlan,
  type HistoryImportRollbackReceipt,
  type HistoryImportVerifyReceipt,
  validateHistoryImportApplyReceipt,
  validateHistoryImportBundle,
  validateHistoryImportPlan,
  validateHistoryImportRollbackReceipt,
  validateHistoryImportVerifyReceipt,
} from "@uptime-status/domain";
import type { ExistingHistoryRecord } from "./preview";

export type AppliedHistoryImportState = {
  active: boolean;
  planId?: string;
  importId?: string;
  bundleSha256?: string;
  dailyRecordCount: number;
  latencyRecordCount: number;
};

export type HistoryImportDestination = {
  readonly adapterId: string;
  readonly destinationId: string;
  listExisting(siteId: string, sourceId: string): Promise<ExistingHistoryRecord[]>;
  apply(input: {
    plan: HistoryImportPlan;
    bundle: HistoryImportBundle;
    completedAt: string;
  }): Promise<HistoryImportApplyReceipt>;
  inspect(plan: HistoryImportPlan): Promise<AppliedHistoryImportState>;
  recordVerification(receipt: HistoryImportVerifyReceipt): Promise<void>;
  rollback(input: {
    plan: HistoryImportPlan;
    completedAt: string;
  }): Promise<HistoryImportRollbackReceipt>;
};

type ExecutionInput = {
  plan: HistoryImportPlan;
  bundle: HistoryImportBundle;
  bundleSha256: string;
  destination: HistoryImportDestination;
  completedAt: string;
};

function assertExecutionInput(input: ExecutionInput) {
  if (!validateHistoryImportPlan(input.plan)) throw new Error("The history import plan is invalid");
  if (!validateHistoryImportBundle(input.bundle)) {
    throw new Error("The history import bundle is invalid");
  }
  if (input.bundleSha256 !== input.plan.bundleSha256) {
    throw new Error("The history import bundle digest does not match the reviewed plan");
  }
  if (
    input.destination.adapterId !== input.plan.destination.adapterId ||
    input.destination.destinationId !== input.plan.destination.destinationId
  ) {
    throw new Error("The history import destination does not match the reviewed plan");
  }
  if (
    input.bundle.siteId !== input.plan.siteId ||
    input.bundle.topologyRevision !== input.plan.topologyRevision ||
    input.bundle.source.systemId !== input.plan.sourceSystemId ||
    input.bundle.source.sourceId !== input.plan.sourceId ||
    input.bundle.importId !== input.plan.importId ||
    input.bundle.extraction.cutoffAt !== input.plan.cutoffAt
  ) {
    throw new Error("The history import bundle does not match the reviewed plan");
  }
  if (input.plan.summary.collisionCount !== 0) {
    throw new Error("The history import plan contains collisions and cannot be applied");
  }
}

export async function applyHistoryImport(input: ExecutionInput) {
  assertExecutionInput(input);
  const receipt = await input.destination.apply({
    plan: input.plan,
    bundle: input.bundle,
    completedAt: input.completedAt,
  });
  if (!validateHistoryImportApplyReceipt(receipt, input.plan)) {
    throw new Error("The history import destination returned an invalid apply receipt");
  }
  return receipt;
}

export async function verifyAppliedHistoryImport(input: ExecutionInput) {
  assertExecutionInput(input);
  const state = await input.destination.inspect(input.plan);
  if (
    !state.active ||
    state.planId !== input.plan.planId ||
    state.importId !== input.plan.importId ||
    state.bundleSha256 !== input.plan.bundleSha256 ||
    state.dailyRecordCount !== input.plan.summary.dailyRecordCount ||
    state.latencyRecordCount !== input.plan.summary.latencyRecordCount
  ) {
    throw new Error("The applied history does not exactly match the reviewed plan and bundle");
  }
  const receipt = createHistoryImportVerifyReceipt({
    schemaVersion: "1.0.0",
    operation: "verify",
    planId: input.plan.planId,
    siteId: input.plan.siteId,
    topologyRevision: input.plan.topologyRevision,
    sourceSystemId: input.plan.sourceSystemId,
    sourceId: input.plan.sourceId,
    importId: input.plan.importId,
    bundleSha256: input.plan.bundleSha256,
    cutoffAt: input.plan.cutoffAt,
    platformRevision: input.plan.platformRevision,
    destination: structuredClone(input.plan.destination),
    completedAt: input.completedAt,
    dailyRecordCount: state.dailyRecordCount,
    latencyRecordCount: state.latencyRecordCount,
  });
  if (!validateHistoryImportVerifyReceipt(receipt, input.plan)) {
    throw new Error("The history import verification receipt is invalid");
  }
  await input.destination.recordVerification(receipt);
  return receipt;
}

export async function rollbackHistoryImport(input: ExecutionInput) {
  assertExecutionInput(input);
  const receipt = await input.destination.rollback({
    plan: input.plan,
    completedAt: input.completedAt,
  });
  if (!validateHistoryImportRollbackReceipt(receipt, input.plan)) {
    throw new Error("The history import destination returned an invalid rollback receipt");
  }
  return receipt;
}

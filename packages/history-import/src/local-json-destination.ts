import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  createHistoryImportApplyReceipt,
  createHistoryImportRollbackReceipt,
  type HistoryImportBundle,
  type HistoryImportPlan,
  type HistoryImportVerifyReceipt,
} from "@uptime-status/domain";
import type { AppliedHistoryImportState, HistoryImportDestination } from "./execution";
import type { ExistingHistoryRecord } from "./preview";

const STATE_FILE = "history-store.json";
const MALFORMED = "The local JSON destination state is malformed";

type StoredRecord = {
  importId: string;
  siteId: string;
  sourceId: string;
  componentId: string;
  kind: "daily" | "latency";
  observedAt: string;
  active: boolean;
  payload: unknown;
};

type StoredReceipt = { operation: "apply" | "verify" | "rollback" } & Record<string, unknown>;

type StoredImport = {
  planId: string;
  bundleSha256: string;
  active: boolean;
  bundle?: HistoryImportBundle;
  receipts: StoredReceipt[];
};

type StoreState = {
  schemaVersion: "1.0.0";
  destinationId: string;
  revision: number;
  records: StoredRecord[];
  imports: Record<string, StoredImport>;
};

function assertState(value: unknown): StoreState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(MALFORMED);
  const state = value as Record<string, unknown>;
  if (
    state.schemaVersion !== "1.0.0" ||
    typeof state.destinationId !== "string" ||
    !Number.isSafeInteger(state.revision) ||
    !Array.isArray(state.records) ||
    !state.imports ||
    typeof state.imports !== "object" ||
    Array.isArray(state.imports)
  ) {
    throw new Error(MALFORMED);
  }
  return value as StoreState;
}

function recordsFor(bundle: HistoryImportBundle): StoredRecord[] {
  const records: StoredRecord[] = [];
  for (const component of bundle.components) {
    for (const entry of component.history) {
      records.push({
        importId: bundle.importId,
        siteId: bundle.siteId,
        sourceId: bundle.source.sourceId,
        componentId: component.componentId,
        kind: "daily",
        observedAt: entry.date,
        active: false,
        payload: entry,
      });
    }
    for (const entry of component.latency ?? []) {
      records.push({
        importId: bundle.importId,
        siteId: bundle.siteId,
        sourceId: bundle.source.sourceId,
        componentId: component.componentId,
        kind: "latency",
        observedAt: entry.observedAt,
        active: false,
        payload: entry,
      });
    }
  }
  return records;
}

function countByKind(records: StoredRecord[]) {
  return {
    daily: records.filter((record) => record.kind === "daily").length,
    latency: records.filter((record) => record.kind === "latency").length,
  };
}

/**
 * Provider-neutral reference destination backed by one JSON file.
 *
 * Apply stages rows invisibly and activates them in a second durable write, and rollback
 * deactivates before deleting, so an interrupted operation is resumable rather than half-visible.
 *
 * ponytail: single-writer. Concurrent processes on one directory would race; take a lock file
 * if this ever runs outside a single operator CLI invocation.
 */
export class LocalJsonHistoryDestination implements HistoryImportDestination {
  readonly adapterId = "local-json";

  private constructor(
    readonly destinationId: string,
    private readonly statePath: string,
  ) {}

  static async open(directory: string) {
    const root = resolve(directory);
    await mkdir(root, { recursive: true });
    const statePath = join(root, STATE_FILE);
    const destinationId = createHash("sha256").update(root).digest("hex");
    try {
      assertState(JSON.parse(await readFile(statePath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const initial: StoreState = {
        schemaVersion: "1.0.0",
        destinationId,
        revision: 0,
        records: [],
        imports: {},
      };
      await writeFile(statePath, `${JSON.stringify(initial, null, 2)}\n`, "utf8");
    }
    return new LocalJsonHistoryDestination(destinationId, statePath);
  }

  private async read() {
    return assertState(JSON.parse(await readFile(this.statePath, "utf8")));
  }

  /** Rename is atomic on POSIX, so a reader never observes a half-written state. */
  private async write(state: StoreState, { bumpRevision = false } = {}) {
    const next = { ...state, revision: bumpRevision ? state.revision + 1 : state.revision };
    const temporary = `${this.statePath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await rename(temporary, this.statePath);
    return next;
  }

  async listExisting(siteId: string, sourceId: string): Promise<ExistingHistoryRecord[]> {
    const state = await this.read();
    return state.records
      .filter((record) => record.active && record.siteId === siteId && record.sourceId === sourceId)
      .map(({ componentId, kind, observedAt, importId }) => ({
        componentId,
        kind,
        observedAt,
        importId,
      }))
      .sort(
        (left, right) =>
          left.componentId.localeCompare(right.componentId) ||
          left.kind.localeCompare(right.kind) ||
          left.observedAt.localeCompare(right.observedAt),
      );
  }

  async apply(input: {
    plan: HistoryImportPlan;
    bundle: HistoryImportBundle;
    completedAt: string;
  }) {
    const { plan, bundle, completedAt } = input;
    let state = await this.read();
    const existing = state.imports[plan.importId];
    if (existing && existing.active && existing.planId !== plan.planId) {
      throw new Error("A different history import plan is already active for this import");
    }

    const noOp = Boolean(existing?.active) && existing?.planId === plan.planId;
    if (!noOp) {
      const staged = recordsFor(bundle);
      state = await this.write(
        {
          ...state,
          records: [
            ...state.records.filter((record) => record.importId !== plan.importId),
            ...staged,
          ],
          imports: {
            ...state.imports,
            [plan.importId]: {
              planId: plan.planId,
              bundleSha256: plan.bundleSha256,
              active: false,
              bundle,
              receipts: existing?.receipts ?? [],
            },
          },
        },
        { bumpRevision: true },
      );

      state = await this.write(
        {
          ...state,
          records: state.records.map((record) =>
            record.importId === plan.importId ? { ...record, active: true } : record,
          ),
          imports: {
            ...state.imports,
            [plan.importId]: { ...state.imports[plan.importId], active: true },
          },
        },
        { bumpRevision: true },
      );
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
      noOp,
    });
    await this.appendReceipt(state, plan.importId, receipt as unknown as StoredReceipt);
    return receipt;
  }

  async inspect(plan: HistoryImportPlan): Promise<AppliedHistoryImportState> {
    const state = await this.read();
    const entry = state.imports[plan.importId];
    const active = state.records.filter(
      (record) => record.importId === plan.importId && record.active,
    );
    const counts = countByKind(active);
    return {
      active: Boolean(entry?.active),
      planId: entry?.planId,
      importId: entry ? plan.importId : undefined,
      bundleSha256: entry?.bundleSha256,
      dailyRecordCount: counts.daily,
      latencyRecordCount: counts.latency,
    };
  }

  async recordVerification(receipt: HistoryImportVerifyReceipt) {
    const state = await this.read();
    await this.appendReceipt(state, receipt.importId, receipt as unknown as StoredReceipt);
  }

  async rollback(input: { plan: HistoryImportPlan; completedAt: string }) {
    const { plan, completedAt } = input;
    let state = await this.read();
    const tagged = state.records.filter((record) => record.importId === plan.importId);
    const entry = state.imports[plan.importId];
    const noOp = !entry?.active && tagged.length === 0;
    const deleted = countByKind(tagged);

    if (!noOp) {
      state = await this.write(
        {
          ...state,
          records: state.records.map((record) =>
            record.importId === plan.importId ? { ...record, active: false } : record,
          ),
          imports: {
            ...state.imports,
            [plan.importId]: { ...state.imports[plan.importId], active: false },
          },
        },
        { bumpRevision: true },
      );

      const retained = { ...state.imports[plan.importId] };
      retained.bundle = undefined;
      state = await this.write(
        {
          ...state,
          records: state.records.filter((record) => record.importId !== plan.importId),
          imports: { ...state.imports, [plan.importId]: retained },
        },
        { bumpRevision: true },
      );
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
      deletedDailyRecordCount: noOp ? 0 : deleted.daily,
      deletedLatencyRecordCount: noOp ? 0 : deleted.latency,
      noOp,
    });
    await this.appendReceipt(state, plan.importId, receipt as unknown as StoredReceipt);
    return receipt;
  }

  private async appendReceipt(state: StoreState, importId: string, receipt: StoredReceipt) {
    const entry = state.imports[importId];
    if (!entry) throw new Error("The history import is not known to this destination");
    await this.write({
      ...state,
      imports: {
        ...state.imports,
        [importId]: { ...entry, receipts: [...entry.receipts, receipt] },
      },
    });
  }
}

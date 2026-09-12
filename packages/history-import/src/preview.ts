import {
  createHistoryImportPlan,
  type HistoryImportBundle,
  type HistoryImportPlan,
  validateHistoryImportBundle,
  validateHistoryImportPlan,
} from "@uptime-status/domain";

export type ExistingHistoryRecord = {
  componentId: string;
  kind: "daily" | "latency";
  observedAt: string;
  /** Which import wrote this row, when one did. A destination reports it so preview can tell
   *  an import's own rows apart from a genuine collision with someone else's. */
  importId?: string;
};

export type HistoryImportPreviewInput = {
  bundle: HistoryImportBundle;
  bundleSha256: string;
  platformRevision: string;
  destination: { adapterId: string; destinationId: string };
  createdAt: string;
  existing?: ExistingHistoryRecord[];
};

const SHA256 = /^[a-f0-9]{64}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function calendarGaps(startsOn: string, endsOn: string, present: Set<string>) {
  const gaps: string[] = [];
  let current = Date.parse(`${startsOn}T00:00:00Z`);
  const end = Date.parse(`${endsOn}T00:00:00Z`);
  while (current <= end) {
    const date = new Date(current).toISOString().slice(0, 10);
    if (!present.has(date)) gaps.push(date);
    current += 86_400_000;
  }
  return gaps;
}

function recordKey(record: ExistingHistoryRecord) {
  return `${record.componentId}\u0000${record.kind}\u0000${record.observedAt}`;
}

function validDay(value: string) {
  if (!DAY.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function assertExistingRecords(bundle: HistoryImportBundle, records: ExistingHistoryRecord[]) {
  const components = new Set(bundle.components.map((component) => component.componentId));
  const keys = new Set<string>();
  for (const record of records) {
    const validInstant =
      record.kind === "daily"
        ? validDay(record.observedAt)
        : !Number.isNaN(Date.parse(record.observedAt));
    const key = recordKey(record);
    if (!components.has(record.componentId) || !validInstant || keys.has(key)) {
      throw new Error("The existing history record set is invalid");
    }
    keys.add(key);
  }
  return keys;
}

export function previewHistoryImport(input: HistoryImportPreviewInput): HistoryImportPlan {
  if (!validateHistoryImportBundle(input.bundle)) {
    throw new Error("The history import bundle is invalid");
  }
  if (!SHA256.test(input.bundleSha256)) {
    throw new Error("The bundle SHA-256 is invalid");
  }
  // Re-previewing an applied import must not find it colliding with itself: an operator runs
  // preview again for every verify and rollback, and its own rows are not a conflict.
  const foreign = (input.existing ?? []).filter(
    (record) => record.importId !== input.bundle.importId,
  );
  const existing = assertExistingRecords(input.bundle, foreign);
  const components = [...input.bundle.components]
    .sort((first, second) => first.componentId.localeCompare(second.componentId))
    .map((component) => {
      const gaps = calendarGaps(
        component.coverage.startsOn,
        component.coverage.endsOn,
        new Set(component.history.map((day) => day.date)),
      );
      const collisions = [
        ...component.history
          .filter((day) =>
            existing.has(
              recordKey({
                componentId: component.componentId,
                kind: "daily",
                observedAt: day.date,
              }),
            ),
          )
          .map((day) => ({ kind: "daily" as const, observedAt: day.date })),
        ...(component.latency ?? [])
          .filter((point) =>
            existing.has(
              recordKey({
                componentId: component.componentId,
                kind: "latency",
                observedAt: point.observedAt,
              }),
            ),
          )
          .map((point) => ({ kind: "latency" as const, observedAt: point.observedAt })),
      ];
      return {
        componentId: component.componentId,
        coverage: structuredClone(component.coverage),
        dailyRecordCount: component.history.length,
        latencyRecordCount: component.latency?.length ?? 0,
        gaps,
        collisions,
      };
    });
  const totals = components.reduce(
    (value, component) => ({
      daily: value.daily + component.dailyRecordCount,
      latency: value.latency + component.latencyRecordCount,
      gaps: value.gaps + component.gaps.length,
      collisions: value.collisions + component.collisions.length,
    }),
    { daily: 0, latency: 0, gaps: 0, collisions: 0 },
  );
  const plan = createHistoryImportPlan({
    schemaVersion: "1.0.0",
    siteId: input.bundle.siteId,
    topologyRevision: input.bundle.topologyRevision,
    sourceSystemId: input.bundle.source.systemId,
    sourceId: input.bundle.source.sourceId,
    importId: input.bundle.importId,
    bundleSha256: input.bundleSha256,
    cutoffAt: input.bundle.extraction.cutoffAt,
    platformRevision: input.platformRevision,
    destination: structuredClone(input.destination),
    createdAt: input.createdAt,
    summary: {
      componentCount: components.length,
      dailyRecordCount: totals.daily,
      latencyRecordCount: totals.latency,
      gapCount: totals.gaps,
      collisionCount: totals.collisions,
      unsupportedRecordCount: 0,
      proposedWriteCount: totals.daily + totals.latency,
    },
    components,
  });
  if (!validateHistoryImportPlan(plan)) throw new Error("The history import preview is invalid");
  return plan;
}

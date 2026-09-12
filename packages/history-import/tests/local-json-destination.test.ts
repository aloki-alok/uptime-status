import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHistoryImportBundle } from "@uptime-status/domain";
import {
  applyHistoryImport,
  LocalJsonHistoryDestination,
  previewHistoryImport,
  rollbackHistoryImport,
  verifyAppliedHistoryImport,
} from "../src";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "uptime-status-history-destination-"));
  directories.push(directory);
  const destination = await LocalJsonHistoryDestination.open(directory);
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
  return { directory, destination, bundle, bundleSha256, plan };
}

describe("local JSON history destination", () => {
  test("atomically activates an import and makes repeated apply idempotent", async () => {
    const context = await setup();
    const first = await applyHistoryImport({
      ...context,
      completedAt: "2026-09-11T10:05:00.000Z",
    });
    const repeated = await applyHistoryImport({
      ...context,
      completedAt: "2026-09-11T10:06:00.000Z",
    });
    expect(first.noOp).toBe(false);
    expect(repeated.noOp).toBe(true);
    expect(await context.destination.listExisting("site-a", "primary")).toEqual([
      {
        componentId: "api",
        kind: "daily",
        observedAt: "2026-09-09",
        importId: context.bundle.importId,
      },
    ]);
    expect(
      JSON.parse(await readFile(join(context.directory, "history-store.json"), "utf8")),
    ).toMatchObject({ schemaVersion: "1.0.0", revision: 2 });
  });

  test("deactivates before deleting tagged rows, remains resumable, and preserves receipts", async () => {
    const context = await setup();
    await applyHistoryImport({
      ...context,
      completedAt: "2026-09-11T10:05:00.000Z",
    });
    await verifyAppliedHistoryImport({
      ...context,
      completedAt: "2026-09-11T10:06:00.000Z",
    });
    const first = await rollbackHistoryImport({
      ...context,
      completedAt: "2026-09-11T10:07:00.000Z",
    });
    const repeated = await rollbackHistoryImport({
      ...context,
      completedAt: "2026-09-11T10:08:00.000Z",
    });
    expect(first).toMatchObject({ deletedDailyRecordCount: 1, noOp: false });
    expect(repeated).toMatchObject({ deletedDailyRecordCount: 0, noOp: true });
    expect(await context.destination.listExisting("site-a", "primary")).toEqual([]);
    const state = JSON.parse(await readFile(join(context.directory, "history-store.json"), "utf8"));
    const imported = state.imports[context.bundle.importId];
    expect(imported.bundle).toBeUndefined();
    expect(imported.receipts.map((receipt: { operation: string }) => receipt.operation)).toEqual([
      "apply",
      "verify",
      "rollback",
      "rollback",
    ]);
  });

  test("fails closed when the destination state is malformed", async () => {
    const context = await setup();
    await Bun.write(join(context.directory, "history-store.json"), "{}\n");
    await expect(context.destination.listExisting("site-a", "primary")).rejects.toThrow(
      "destination state",
    );
  });
});

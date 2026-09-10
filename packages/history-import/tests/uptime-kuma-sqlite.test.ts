import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type HistoryExtractionRequest,
  HistoryExtractorRegistry,
  HistoryImportInspector,
  UptimeKumaSqliteExtractor,
} from "../src";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function fixture(options: { omitImportant?: boolean; walMode?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "uptime-kuma-sqlite-"));
  directories.push(directory);
  const path = join(directory, "kuma.sqlite");
  const database = new Database(path, { create: true, strict: true });
  if (options.walMode) database.run("PRAGMA journal_mode = WAL");
  database.run("CREATE TABLE monitor (id INTEGER PRIMARY KEY)");
  database.run(
    `CREATE TABLE heartbeat (
      id INTEGER PRIMARY KEY,
      monitor_id INTEGER NOT NULL,
      important BOOLEAN NOT NULL,
      status SMALLINT NOT NULL,
      time DATETIME NOT NULL
    )`,
  );
  database.run(
    `CREATE TABLE stat_daily (
      id INTEGER PRIMARY KEY,
      monitor_id INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      ping REAL NOT NULL,
      up INTEGER NOT NULL,
      down INTEGER NOT NULL,
      extras TEXT
    )`,
  );
  database.run("INSERT INTO monitor (id) VALUES (11)");
  const insertDaily = database.prepare(
    "INSERT INTO stat_daily (monitor_id, timestamp, ping, up, down, extras) VALUES (?, ?, ?, ?, ?, ?)",
  );
  insertDaily.run(11, 1_788_220_800, 120.125, 100, 1, null);
  insertDaily.run(11, 1_788_307_200, 140, 100, 1, null);
  insertDaily.run(11, 1_788_393_600, 0, 0, 0, JSON.stringify({ maintenance: 2 }));
  insertDaily.run(11, 1_788_480_000, 99, 10, 0, null);
  const insertHeartbeat = database.prepare(
    "INSERT INTO heartbeat (monitor_id, important, status, time) VALUES (?, 1, ?, ?)",
  );
  insertHeartbeat.run(11, 1, "2026-08-31 23:50:00");
  insertHeartbeat.run(11, 0, "2026-09-01 00:10:00");
  insertHeartbeat.run(11, 1, "2026-09-01 00:20:00");
  insertHeartbeat.run(11, 0, "2026-09-02 00:10:00");
  insertHeartbeat.run(11, 1, "2026-09-02 00:11:00");
  if (options.omitImportant) {
    database.run("DROP TABLE heartbeat");
    database.run(
      "CREATE TABLE heartbeat (id INTEGER PRIMARY KEY, monitor_id INTEGER, status INTEGER, time DATETIME)",
    );
  }
  if (options.walMode) database.run("PRAGMA wal_checkpoint(TRUNCATE)");
  database.close();
  if (options.walMode) {
    await rm(`${path}-shm`, { force: true });
    await rm(`${path}-wal`, { force: true });
  }

  const bytes = await readFile(path);
  const request: HistoryExtractionRequest = {
    siteId: "example-service",
    topologyRevision: "topology-001",
    source: {
      systemId: "uptime-kuma",
      sourceId: "primary-monitor",
      systemVersion: "2.2.0",
      schemaVersion: "kuma-2.2.0",
    },
    artifact: {
      kind: "sqlite-backup",
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      cutoffAt: "2026-09-04T00:00:00Z",
      exportedAt: "2026-09-04T00:05:00Z",
      sourceTimeZone: "UTC",
    },
    mappings: [{ componentId: "public-api", entityType: "monitor", externalId: "11" }],
  };
  return request;
}

describe("Uptime Kuma 2.2 SQLite history extraction", () => {
  test("reads a self-contained WAL-mode backup without sidecar files", async () => {
    const inspector = new HistoryImportInspector(
      new HistoryExtractorRegistry([new UptimeKumaSqliteExtractor()]),
    );
    const request = await fixture({ walMode: true });

    const bundle = await inspector.inspect("uptime-kuma-sqlite", request);

    expect(bundle.components[0].componentId).toBe("public-api");
  });

  test("reproduces UTC buckets and confirmed-down outage semantics", async () => {
    const inspector = new HistoryImportInspector(
      new HistoryExtractorRegistry([new UptimeKumaSqliteExtractor()]),
    );
    const request = await fixture();
    const first = await inspector.inspect("uptime-kuma-sqlite", request);
    const repeated = await inspector.inspect("uptime-kuma-sqlite", request);

    expect(repeated).toEqual(first);
    expect(first.components[0].coverage).toEqual({
      startsOn: "2026-09-01",
      endsOn: "2026-09-03",
    });
    expect(first.components[0].history).toEqual([
      {
        date: "2026-09-01",
        state: "major_outage",
        severity: "major",
        uptime: 99.306,
        downMinutes: 10,
        avgMs: 120.13,
      },
      {
        date: "2026-09-02",
        state: "degraded",
        severity: "minor",
        uptime: 99.931,
        downMinutes: 1,
        avgMs: 140,
      },
      {
        date: "2026-09-03",
        state: "maintenance",
        severity: "none",
        uptime: 100,
        downMinutes: 0,
        avgMs: null,
      },
    ]);
  });

  test("rejects unsupported source versions, schema drift, and unmapped monitors", async () => {
    const extractor = new UptimeKumaSqliteExtractor();
    const request = await fixture({ omitImportant: true });
    await expect(extractor.extract(request)).rejects.toThrow(
      "Unsupported Uptime Kuma SQLite schema",
    );

    const valid = await fixture();
    await expect(
      extractor.extract({
        ...valid,
        source: { ...valid.source, systemVersion: "2.1.0" },
      }),
    ).rejects.toThrow("not supported");
    await expect(
      extractor.extract({
        ...valid,
        mappings: [{ componentId: "missing", entityType: "monitor", externalId: "99" }],
      }),
    ).rejects.toThrow("does not exist");
  });
});

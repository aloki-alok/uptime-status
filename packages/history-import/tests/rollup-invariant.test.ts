import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MonitorStore } from "@uptime-status/monitor";
import {
  type HistoryExtractionRequest,
  HistoryExtractorRegistry,
  HistoryImportInspector,
  UptimeKumaSqliteExtractor,
} from "../src";

/**
 * The invariant this whole design exists to protect: a day migrated from Uptime Kuma and a day
 * measured by our own prober must be indistinguishable on the page.
 *
 * The 90-day bar is one continuous strip. If the two paths disagree, the migration cutover
 * becomes a visible step change that nobody can explain, and the entire history stops being
 * trustworthy. Both paths call the same rollup, so this test's job is to prove the ADAPTERS
 * around it agree too: Kuma derives intervals from `important` heartbeats and counts from
 * `stat_daily`, while the prober derives both from its own raw checks.
 *
 * One reality, encoded two ways. The rows must match field for field.
 */

const DAY_START = 1_788_220_800; // 2026-09-01T00:00:00Z
const DAY_DATE = "2026-09-01";
const MINUTE = 60;
const RESPONSE_MS = 100;

// The outage: down from 00:10:00 until 00:30:00. Twenty minutes, comfortably past the 600s
// threshold that separates a minor blip from a major outage.
const DOWN_FROM_MINUTE = 10;
const DOWN_UNTIL_MINUTE = 30;
const CHECKS_PER_DAY = 1440;
const DOWN_CHECKS = DOWN_UNTIL_MINUTE - DOWN_FROM_MINUTE;
const UP_CHECKS = CHECKS_PER_DAY - DOWN_CHECKS;

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

function isDown(minute: number) {
  return minute >= DOWN_FROM_MINUTE && minute < DOWN_UNTIL_MINUTE;
}

function kumaTime(seconds: number) {
  return new Date(seconds * 1000).toISOString().replace("T", " ").slice(0, 19);
}

/** The same reality as Kuma stores it: daily aggregates plus state-change heartbeats. */
async function migratedDay() {
  const directory = await mkdtemp(join(tmpdir(), "rollup-invariant-kuma-"));
  directories.push(directory);
  const path = join(directory, "kuma.sqlite");
  const database = new Database(path, { create: true, strict: true });
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
  database
    .prepare(
      "INSERT INTO stat_daily (monitor_id, timestamp, ping, up, down, extras) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(11, DAY_START, RESPONSE_MS, UP_CHECKS, DOWN_CHECKS, null);

  // Kuma records a heartbeat only where the state CHANGES, so the outage is two rows.
  const insertHeartbeat = database.prepare(
    "INSERT INTO heartbeat (monitor_id, important, status, time) VALUES (?, 1, ?, ?)",
  );
  insertHeartbeat.run(11, 0, kumaTime(DAY_START + DOWN_FROM_MINUTE * MINUTE));
  insertHeartbeat.run(11, 1, kumaTime(DAY_START + DOWN_UNTIL_MINUTE * MINUTE));
  database.close();

  const bytes = await readFile(path);
  const request: HistoryExtractionRequest = {
    siteId: "site-a",
    topologyRevision: "topology-001",
    source: {
      systemId: "uptime-kuma",
      sourceId: "primary",
      systemVersion: "2.2.0",
      schemaVersion: "kuma-2.2.0",
    },
    artifact: {
      kind: "sqlite-backup",
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      cutoffAt: "2026-09-02T00:00:00Z",
      exportedAt: "2026-09-02T00:05:00Z",
      sourceTimeZone: "UTC",
    },
    mappings: [{ componentId: "api", entityType: "monitor", externalId: "11" }],
  };

  const inspector = new HistoryImportInspector(
    new HistoryExtractorRegistry([new UptimeKumaSqliteExtractor()]),
  );
  const bundle = await inspector.inspect("uptime-kuma-sqlite", request);
  const day = bundle.components[0]?.history.find((entry) => entry.date === DAY_DATE);
  if (!day) throw new Error("the migrated bundle is missing the day under test");
  return day;
}

/** The same reality as our prober sees it: one check per minute, all 1440 of them. */
function probedDay() {
  const store = new MonitorStore(new Database(":memory:"));
  for (let minute = 0; minute < CHECKS_PER_DAY; minute += 1) {
    const down = isDown(minute);
    store.recordCheck({
      componentId: "api",
      observedAt: DAY_START + minute * MINUTE,
      status: down ? 0 : 1,
      // A failed check has no meaningful response time, which is also why Kuma's daily ping
      // only averages successful beats.
      responseMs: down ? null : RESPONSE_MS,
    });
  }
  store.rollUpDay("api", DAY_START);
  const row = store.readDays("api", DAY_DATE, DAY_DATE)[0];
  if (!row) throw new Error("the probed store is missing the day under test");
  return row;
}

describe("migrated and probed days are indistinguishable", () => {
  test("the same outage produces the same daily row through both paths", async () => {
    const migrated = await migratedDay();
    const probed = probedDay();

    // Stated explicitly rather than only compared, so a future change that breaks BOTH paths
    // in the same direction still fails here.
    expect(migrated.state).toBe("major_outage");
    expect(migrated.severity).toBe("major");
    expect(migrated.downMinutes).toBe(DOWN_CHECKS);
    expect(migrated.uptime).toBeCloseTo(100 - (DOWN_CHECKS * MINUTE * 100) / 86_400, 3);

    expect(probed.state).toBe(migrated.state);
    expect(probed.severity).toBe(migrated.severity);
    expect(probed.down_minutes).toBe(migrated.downMinutes);
    expect(probed.uptime).toBe(migrated.uptime);
    expect(probed.avg_ms).toBe(migrated.avgMs);
  });

  test("a clean day matches through both paths", async () => {
    const store = new MonitorStore(new Database(":memory:"));
    for (let minute = 0; minute < CHECKS_PER_DAY; minute += 1) {
      store.recordCheck({
        componentId: "api",
        observedAt: DAY_START + minute * MINUTE,
        status: 1,
        responseMs: RESPONSE_MS,
      });
    }
    store.rollUpDay("api", DAY_START);
    const probed = store.readDays("api", DAY_DATE, DAY_DATE)[0];

    expect(probed?.state).toBe("operational");
    expect(probed?.severity).toBe("none");
    expect(probed?.uptime).toBe(100);
    expect(probed?.down_minutes).toBe(0);
  });

  test("a sub-threshold blip is minor through the probed path, not major", () => {
    const store = new MonitorStore(new Database(":memory:"));
    for (let minute = 0; minute < CHECKS_PER_DAY; minute += 1) {
      // Five minutes is well under the 600s sustained-down threshold.
      const down = minute >= 10 && minute < 15;
      store.recordCheck({
        componentId: "api",
        observedAt: DAY_START + minute * MINUTE,
        status: down ? 0 : 1,
        responseMs: down ? null : RESPONSE_MS,
      });
    }
    store.rollUpDay("api", DAY_START);
    const probed = store.readDays("api", DAY_DATE, DAY_DATE)[0];

    expect(probed?.severity).toBe("minor");
    expect(probed?.down_minutes).toBe(5);
  });
});

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { CHECK_RETENTION_DAYS, MonitorStore } from "../src/store";

const DAY = 86_400;
const START = 1_788_220_800; // 2026-09-01T00:00:00Z (UTC day boundary)

function newStore() {
  return new MonitorStore(new Database(":memory:"));
}

describe("MonitorStore", () => {
  test("records checks", () => {
    const store = newStore();
    store.recordCheck({ componentId: "c1", observedAt: START, status: 1, responseMs: 120 });
    const row = store.db.query("SELECT * FROM checks WHERE component_id = ?").get("c1") as {
      status: number;
      response_ms: number;
    };
    expect(row.status).toBe(1);
    expect(row.response_ms).toBe(120);
  });

  test("rolls up a fully-up day", () => {
    const store = newStore();
    store.recordCheck({ componentId: "c1", observedAt: START, status: 1, responseMs: 100 });
    store.recordCheck({
      componentId: "c1",
      observedAt: START + DAY - 60,
      status: 1,
      responseMs: 140,
    });

    const result = store.rollUpDay("c1", START);

    expect(result.state).toBe("operational");
    expect(result.severity).toBe("none");
    expect(result.uptime).toBe(100);
    expect(result.downMinutes).toBe(0);
    expect(result.avgMs).toBe(120);

    const [row] = store.readDays("c1", "2026-09-01", "2026-09-01");
    expect(row.origin).toBe("native");
    expect(row.rollup_version).toBe(1);
    expect(row.state).toBe("operational");
  });

  test("rolls up a day with a sustained outage", () => {
    const store = newStore();
    store.recordCheck({ componentId: "c1", observedAt: START, status: 1, responseMs: 100 });
    store.recordCheck({ componentId: "c1", observedAt: START + 200, status: 0, responseMs: null });
    store.recordCheck({
      componentId: "c1",
      observedAt: START + 200 + 700,
      status: 1,
      responseMs: 100,
    });

    const result = store.rollUpDay("c1", START);

    expect(result.severity).toBe("major");
    expect(result.state).toBe("major_outage");
    expect(result.downMinutes).toBe(Math.round(700 / 60));
  });

  test("prune returns pre-delete counts and deletes the right rows", () => {
    const store = newStore();
    const oldDate = "2020-01-01";
    const recentDate = new Date().toISOString().slice(0, 10);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const oldCheckTs = nowSeconds - 400 * DAY;
    const recentCheckTs = nowSeconds - 1 * DAY;

    store.db.run(
      `INSERT INTO daily (component_id, date, state, severity, uptime, down_minutes, avg_ms, rollup_version, origin, import_id)
       VALUES ('c1', ?, 'operational', 'none', 100, 0, 100, 1, 'native', NULL)`,
      [oldDate],
    );
    store.db.run(
      `INSERT INTO daily (component_id, date, state, severity, uptime, down_minutes, avg_ms, rollup_version, origin, import_id)
       VALUES ('c1', ?, 'operational', 'none', 100, 0, 100, 1, 'native', NULL)`,
      [recentDate],
    );
    store.recordCheck({ componentId: "c1", observedAt: oldCheckTs, status: 1, responseMs: 100 });
    store.recordCheck({ componentId: "c1", observedAt: recentCheckTs, status: 1, responseMs: 100 });

    const result = store.prune({ dailyDays: 30 });

    expect(result).toEqual({ daily: 1, checks: 1 });
    expect(store.readDays("c1", "2000-01-01", "2999-01-01")).toHaveLength(1);
    const remainingChecks = store.db.query("SELECT COUNT(*) AS n FROM checks").get() as {
      n: number;
    };
    expect(remainingChecks.n).toBe(1);
  });

  test("prune keeps checks inside CHECK_RETENTION_DAYS and drops those outside", () => {
    const store = newStore();
    const nowSeconds = Math.floor(Date.now() / 1000);
    store.recordCheck({
      componentId: "c1",
      observedAt: nowSeconds - (CHECK_RETENTION_DAYS - 1) * DAY,
      status: 1,
      responseMs: 100,
    });
    store.recordCheck({
      componentId: "c1",
      observedAt: nowSeconds - (CHECK_RETENTION_DAYS + 1) * DAY,
      status: 1,
      responseMs: 100,
    });

    expect(store.prune({ dailyDays: 360 }).checks).toBe(1);
    const remaining = store.db.query("SELECT COUNT(*) AS n FROM checks").get() as { n: number };
    expect(remaining.n).toBe(1);
  });

  test("prune does not delete a day inside the retention window", () => {
    const store = newStore();
    const recentDate = new Date().toISOString().slice(0, 10);
    store.db.run(
      `INSERT INTO daily (component_id, date, state, severity, uptime, down_minutes, avg_ms, rollup_version, origin, import_id)
       VALUES ('c1', ?, 'operational', 'none', 100, 0, 100, 1, 'native', NULL)`,
      [recentDate],
    );

    const result = store.prune({ dailyDays: 30 });

    expect(result.daily).toBe(0);
    expect(store.readDays("c1", "2000-01-01", "2999-01-01")).toHaveLength(1);
  });

  test("a native rollup does not overwrite an imported day at/below the cutoff", () => {
    const store = newStore();
    store.db.run(
      `INSERT INTO daily (component_id, date, state, severity, uptime, down_minutes, avg_ms, rollup_version, origin, import_id)
       VALUES ('c1', '2026-09-01', 'major_outage', 'major', 42, 500, 90, 1, 'import', 'imp-1')`,
    );

    store.recordCheck({ componentId: "c1", observedAt: START, status: 1, responseMs: 100 });
    store.recordCheck({
      componentId: "c1",
      observedAt: START + DAY - 60,
      status: 1,
      responseMs: 100,
    });
    store.rollUpDay("c1", START);

    const [row] = store.readDays("c1", "2026-09-01", "2026-09-01");
    expect(row.origin).toBe("import");
    expect(row.import_id).toBe("imp-1");
    expect(row.state).toBe("major_outage");
    expect(row.uptime).toBe(42);
  });
});

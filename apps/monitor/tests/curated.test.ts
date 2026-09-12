import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { type Incident, type Maintenance, validateStatusSnapshot } from "@uptime-status/domain";
import { MonitorStore } from "@uptime-status/monitor";
import { buildSnapshotFromStore } from "@uptime-status/snapshot";
import { CuratedStore } from "../src/curated";
import { testSite } from "./fixtures";

const site = testSite();
const component = site.components[0].componentId;
const startedAt = "2026-09-12T09:00:00.000Z";
const incident: Incident = {
  slug: "api-latency-2026-09-12",
  revision: 1,
  title: "API latency",
  state: "investigating",
  impact: "degraded",
  affectedComponents: [component],
  startedAt,
  updates: [
    {
      id: "initial",
      state: "investigating",
      message: "Requests are slower than usual.",
      publishedAt: startedAt,
    },
  ],
};

describe("curated notices", () => {
  test("a published incident becomes live, then resolved history, without losing monitor checks", () => {
    const monitor = new MonitorStore(new Database(":memory:"));
    monitor.recordCheck({
      componentId: component,
      observedAt: Date.parse(startedAt) / 1000,
      status: 1,
      responseMs: 120,
    });
    monitor.rollUpDay(component, Date.parse("2026-09-12T00:00:00Z") / 1000);
    const curated = new CuratedStore(monitor.db, site);
    curated.save("incident", incident, null, "test-operator", "open");

    const live = buildSnapshotFromStore({
      store: monitor,
      site,
      curated: curated.all(),
      now: () => new Date("2026-09-12T09:00:30Z"),
    });
    expect(validateStatusSnapshot(live)).toBe(true);
    expect(live.activeIncidents[0].title).toBe("API latency");
    expect(live.overallStatus).toBe("degraded");
    expect(live.components[0].history).toHaveLength(90);

    const resolved: Incident = {
      ...incident,
      revision: 2,
      state: "resolved",
      resolvedAt: "2026-09-12T09:10:00.000Z",
      updates: [
        ...incident.updates,
        {
          id: "resolved",
          state: "resolved",
          message: "Latency is back to normal.",
          publishedAt: "2026-09-12T09:10:00.000Z",
        },
      ],
    };
    curated.save("incident", resolved, 1, "test-operator", "resolve");
    const history = buildSnapshotFromStore({
      store: monitor,
      site,
      curated: curated.all(),
      now: () => new Date("2026-09-12T09:10:30Z"),
    });
    expect(validateStatusSnapshot(history)).toBe(true);
    expect(history.activeIncidents).toHaveLength(0);
    expect(history.recentEvents[0]).toEqual(resolved);
    expect(history.sourceRevision).not.toBe(live.sourceRevision);
    expect(monitor.db.query("SELECT COUNT(*) AS n FROM curated_audit").get()).toEqual({ n: 2 });
  });

  test("a stale revision cannot overwrite an operator's newer publication", () => {
    const monitor = new MonitorStore(new Database(":memory:"));
    const curated = new CuratedStore(monitor.db, site);
    curated.save("incident", incident, null, "operator-a", "open");
    const next = { ...incident, revision: 2, title: "API latency is improving" };
    curated.save("incident", next, 1, "operator-b", "update");
    expect(() =>
      curated.save("incident", { ...next, title: "Stale edit" }, 1, "operator-a", "update"),
    ).toThrow();
    expect((curated.get("incident", incident.slug) as Incident).title).toBe(
      "API latency is improving",
    );
    expect(monitor.db.query("SELECT COUNT(*) AS n FROM curated_audit").get()).toEqual({ n: 2 });
  });

  test("a scheduled maintenance window activates and ends without masking an outage", () => {
    const monitor = new MonitorStore(new Database(":memory:"));
    monitor.recordCheck({
      componentId: component,
      observedAt: Date.parse("2026-09-12T10:30:00Z") / 1000,
      status: 1,
      responseMs: 120,
    });
    monitor.rollUpDay(component, Date.parse("2026-09-12T00:00:00Z") / 1000);
    const curated = new CuratedStore(monitor.db, site);
    const maintenance: Maintenance = {
      slug: "api-maintenance-2026-09-12",
      revision: 1,
      title: "API maintenance",
      state: "scheduled",
      expectedImpact: "Some requests may be slow.",
      affectedComponents: [component],
      startsAt: "2026-09-12T10:00:00.000Z",
      endsAt: "2026-09-12T11:00:00.000Z",
      sourceTimeZone: "UTC",
      updates: [
        {
          id: "scheduled",
          state: "scheduled",
          message: "Planned API work.",
          publishedAt: "2026-09-12T09:00:00.000Z",
        },
      ],
    };
    curated.save("maintenance", maintenance, null, "test-operator", "schedule");

    const active = buildSnapshotFromStore({
      store: monitor,
      site,
      curated: curated.all(),
      now: () => new Date("2026-09-12T10:30:30Z"),
    });
    expect(active.scheduledMaintenance[0].state).toBe("active");
    expect(active.overallStatus).toBe("maintenance");
    curated.save(
      "incident",
      {
        ...incident,
        startedAt: "2026-09-12T10:00:00.000Z",
        updates: [{ ...incident.updates[0], publishedAt: "2026-09-12T10:00:00.000Z" }],
      },
      null,
      "test-operator",
      "open",
    );
    const outage = buildSnapshotFromStore({
      store: monitor,
      site,
      curated: curated.all(),
      now: () => new Date("2026-09-12T10:30:30Z"),
    });
    expect(outage.overallStatus).toBe("degraded");
    const ended = buildSnapshotFromStore({
      store: monitor,
      site,
      curated: curated.all(),
      now: () => new Date("2026-09-12T11:00:30Z"),
    });
    expect(ended.scheduledMaintenance).toHaveLength(0);
    expect((ended.recentEvents[0] as Maintenance).state).toBe("completed");
    expect(validateStatusSnapshot(ended)).toBe(true);
  });
});

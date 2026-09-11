import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  PUBLIC_HISTORY_WINDOW_DAYS,
  type SiteConfig,
  validateStatusSnapshot,
} from "@uptime-status/domain";
import { MonitorStore, ROLLUP_VERSION } from "@uptime-status/monitor";
import { buildSnapshotFromStore } from "../src/store-publisher";

function newStore() {
  return new MonitorStore(new Database(":memory:"));
}

function site(count: number, staleAfterSeconds = 120): SiteConfig {
  const componentIds = Array.from({ length: count }, (_, index) => `component-${index + 1}`);
  return {
    schemaVersion: "1.0.0",
    deploymentMode: "example",
    siteId: "example-site",
    displayName: "Example Site",
    legalName: "Example Site",
    locale: "en",
    timeZone: "UTC",
    domains: { primary: "status.example.com" },
    brand: {
      homeUrl: "https://example.com",
      logoLightPath: "./assets/logo-light.svg",
      logoDarkPath: "./assets/logo-dark.svg",
      iconLightPath: "./assets/icon-light.svg",
      iconDarkPath: "./assets/icon-dark.svg",
      faviconPath: "./assets/favicon.svg",
      logoAlt: "Example Site",
    },
    presentation: {
      statusCopy: {
        operational: "All systems operational",
        degraded: "Some systems are degraded",
        partialOutage: "Some services are unavailable",
        majorOutage: "Major service outage",
        maintenance: "Maintenance in progress",
        unknown: "Status data is delayed",
      },
      semanticColors: {
        operational: "#16805c",
        maintenance: "#2f6feb",
        degraded: "#a56712",
        outage: "#b7433c",
        unknown: "#65716e",
      },
    },
    monitoring: {
      pollIntervalSeconds: 60,
      staleAfterSeconds,
      sources: [{ sourceId: "native", adapter: "fixture", fixture: "generated" }],
    },
    components: componentIds.map((componentId, index) => ({
      componentId,
      name: `Component ${index + 1}`,
      group: index === 0 ? "Core" : "Supporting",
      sourceId: "native",
      monitorRef: `monitor-${index + 1}`,
      showLatency: index === 0,
    })),
    subscriptions: {
      enabled: false,
      disabledReason: "delivery-not-configured",
      doubleOptIn: true,
    },
  };
}

function sec(iso: string) {
  return Math.floor(Date.parse(iso) / 1000);
}

function insertDaily(
  store: MonitorStore,
  componentId: string,
  date: string,
  overrides: {
    state?: string;
    severity?: string;
    uptime?: number | null;
    downMinutes?: number;
    avgMs?: number | null;
    rollupVersion?: number;
  } = {},
) {
  const {
    state = "operational",
    severity = "none",
    uptime = 100,
    downMinutes = 0,
    avgMs = 100,
    rollupVersion = ROLLUP_VERSION,
  } = overrides;
  store.db.run(
    `INSERT INTO daily (component_id, date, state, severity, uptime, down_minutes, avg_ms, rollup_version, origin, import_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'native', NULL)`,
    [componentId, date, state, severity, uptime, downMinutes, avgMs, rollupVersion],
  );
}

describe("buildSnapshotFromStore", () => {
  test("produces exactly PUBLIC_HISTORY_WINDOW_DAYS entries per component across five components", () => {
    const store = newStore();
    const config = site(5);
    const now = () => new Date("2026-09-10T12:00:00.000Z");

    const snapshot = buildSnapshotFromStore({ store, site: config, now });

    expect(snapshot.components).toHaveLength(5);
    expect(snapshot.components.map((component) => component.slug)).toEqual([
      "component-1",
      "component-2",
      "component-3",
      "component-4",
      "component-5",
    ]);
    for (const component of snapshot.components) {
      expect(component.history).toHaveLength(PUBLIC_HISTORY_WINDOW_DAYS);
    }
    expect(validateStatusSnapshot(snapshot)).toBe(true);
  });

  test("a missing day renders unknown, not operational", () => {
    const store = newStore();
    const config = site(1);
    const now = () => new Date("2026-09-10T12:00:00.000Z");

    insertDaily(store, "component-1", "2026-09-08", { state: "operational" });
    // 2026-09-09 is deliberately left absent.

    const snapshot = buildSnapshotFromStore({ store, site: config, now });
    const missingDay = snapshot.components[0]?.history.find((day) => day.date === "2026-09-09");

    expect(missingDay).toEqual({
      date: "2026-09-09",
      state: "unknown",
      severity: "unknown",
      uptime: null,
      downMinutes: 0,
      avgMs: null,
    });
    expect(validateStatusSnapshot(snapshot)).toBe(true);
  });

  test("a row with a stale rollup_version renders unknown", () => {
    const store = newStore();
    const config = site(1);
    const now = () => new Date("2026-09-10T12:00:00.000Z");

    insertDaily(store, "component-1", "2026-09-10", {
      state: "operational",
      severity: "none",
      uptime: 100,
      rollupVersion: ROLLUP_VERSION + 1,
    });

    const snapshot = buildSnapshotFromStore({ store, site: config, now });
    const today = snapshot.components[0]?.history.at(-1);

    expect(today?.date).toBe("2026-09-10");
    expect(today?.state).toBe("unknown");
    expect(today?.severity).toBe("unknown");
    expect(today?.uptime).toBeNull();
    expect(snapshot.components[0]?.state).toBe("unknown");
    expect(validateStatusSnapshot(snapshot)).toBe(true);
  });

  test("latency respects the 60-minute window and reports real sample counts", () => {
    const store = newStore();
    const config = site(1);
    const now = () => new Date("2026-09-10T10:00:50.000Z");

    store.recordCheck({
      componentId: "component-1",
      observedAt: sec("2026-09-10T08:00:00.000Z"), // outside the window: must be excluded
      status: 1,
      responseMs: 999,
    });
    store.recordCheck({
      componentId: "component-1",
      observedAt: sec("2026-09-10T09:58:10.000Z"),
      status: 1,
      responseMs: 100,
    });
    store.recordCheck({
      componentId: "component-1",
      observedAt: sec("2026-09-10T09:58:40.000Z"), // same minute bucket as the previous check
      status: 1,
      responseMs: 200,
    });
    store.recordCheck({
      componentId: "component-1",
      observedAt: sec("2026-09-10T09:59:00.000Z"), // down: no real sample, must not fabricate a point
      status: 0,
      responseMs: null,
    });
    store.recordCheck({
      componentId: "component-1",
      observedAt: sec("2026-09-10T10:00:45.000Z"), // newest check, anchors the window
      status: 1,
      responseMs: 60,
    });

    const snapshot = buildSnapshotFromStore({ store, site: config, now });

    expect(snapshot.components[0]?.latency).toEqual([
      { observedAt: "2026-09-10T09:58:00.000Z", avgMs: 150, sampleCount: 2 },
      { observedAt: "2026-09-10T10:00:00.000Z", avgMs: 60, sampleCount: 1 },
    ]);
    expect(snapshot.components[0]?.responseTimeMs).toBe(60);
    expect(snapshot.components[0]?.latestObservedAt).toBe("2026-09-10T10:00:45.000Z");
    expect(validateStatusSnapshot(snapshot)).toBe(true);
  });

  test("a store whose newest check is hours old produces a snapshot that is not fresh", () => {
    const store = newStore();
    const config = site(1, 120);
    const now = () => new Date("2026-09-10T12:00:00.000Z");

    store.recordCheck({
      componentId: "component-1",
      observedAt: sec("2026-09-10T09:00:00.000Z"),
      status: 1,
      responseMs: 90,
    });
    insertDaily(store, "component-1", "2026-09-10", { state: "operational", severity: "none" });

    const snapshot = buildSnapshotFromStore({ store, site: config, now });

    expect(snapshot.generatedAt).toBe("2026-09-10T09:00:00.000Z");
    expect(snapshot.latestCheckAt).toBe("2026-09-10T09:00:00.000Z");
    expect(snapshot.components[0]?.state).toBe("operational");
    expect(snapshot.overallStatus).toBe("unknown");
    expect(validateStatusSnapshot(snapshot)).toBe(true);
  });

  test("two builds over an unchanged store produce the same sourceRevision", () => {
    const store = newStore();
    const config = site(3);

    store.recordCheck({
      componentId: "component-1",
      observedAt: sec("2026-09-10T09:00:00.000Z"),
      status: 1,
      responseMs: 90,
    });

    const first = buildSnapshotFromStore({
      store,
      site: config,
      now: () => new Date("2026-09-10T09:05:00.000Z"),
    });
    const second = buildSnapshotFromStore({
      store,
      site: config,
      now: () => new Date("2026-09-10T09:20:00.000Z"),
    });

    expect(second.sourceRevision).toBe(first.sourceRevision);
    expect(second.sourceRevision.length).toBeGreaterThanOrEqual(8);
  });
});

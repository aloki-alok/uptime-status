import { describe, expect, test } from "bun:test";
import { createHistoryImportBundle } from "@uptime-status/domain";
import { previewHistoryImport } from "../src/preview";

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
      coverage: { startsOn: "2026-09-07", endsOn: "2026-09-09" },
      history: [
        {
          date: "2026-09-07",
          state: "operational",
          severity: "none",
          uptime: 100,
          downMinutes: 0,
          avgMs: 80,
        },
        {
          date: "2026-09-09",
          state: "degraded",
          severity: "minor",
          uptime: 99,
          downMinutes: 14,
          avgMs: 95,
        },
      ],
      latency: [{ observedAt: "2026-09-09T23:00:00Z", avgMs: 94, sampleCount: 3 }],
    },
  ],
});

const input = {
  bundle,
  bundleSha256: "b".repeat(64),
  platformRevision: "914abbd4cc9120736f9ee8ffad9d16fd7c2aee35",
  destination: { adapterId: "memory", destinationId: "preview-history" },
  createdAt: "2026-09-11T10:00:00.000Z",
};

describe("history import preview", () => {
  test("reports deterministic counts, calendar gaps, and live collisions", () => {
    const existing = [
      { componentId: "api", kind: "daily" as const, observedAt: "2026-09-07" },
      {
        componentId: "api",
        kind: "latency" as const,
        observedAt: "2026-09-09T23:00:00Z",
      },
      { componentId: "api", kind: "daily" as const, observedAt: "2026-09-10" },
    ];
    const first = previewHistoryImport({ ...input, existing });
    const repeated = previewHistoryImport({ ...input, existing: [...existing].reverse() });

    expect(first).toEqual(repeated);
    expect(first.summary).toEqual({
      componentCount: 1,
      dailyRecordCount: 2,
      latencyRecordCount: 1,
      gapCount: 1,
      collisionCount: 2,
      unsupportedRecordCount: 0,
      proposedWriteCount: 3,
    });
    expect(first.components[0].gaps).toEqual(["2026-09-08"]);
    expect(first.components[0].collisions).toEqual([
      { kind: "daily", observedAt: "2026-09-07" },
      { kind: "latency", observedAt: "2026-09-09T23:00:00Z" },
    ]);
  });

  test("fails closed on invalid inputs before planning", () => {
    expect(() => previewHistoryImport({ ...input, bundleSha256: "bad" })).toThrow("bundle SHA-256");
    expect(() =>
      previewHistoryImport({
        ...input,
        existing: [{ componentId: "other", kind: "daily", observedAt: "2026-09-07" }],
      }),
    ).toThrow("existing history record");
    expect(() =>
      previewHistoryImport({
        ...input,
        existing: [{ componentId: "api", kind: "daily", observedAt: "2026-02-30" }],
      }),
    ).toThrow("existing history record");
  });
});

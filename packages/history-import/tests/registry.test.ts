import { describe, expect, test } from "bun:test";
import { createHistoryImportBundle } from "@uptime-status/domain";
import { type HistoryExtractionRequest, HistoryExtractorRegistry } from "../src";

const request: HistoryExtractionRequest = {
  siteId: "example-service",
  topologyRevision: "topology-001",
  source: {
    systemId: "uptime-kuma",
    sourceId: "primary-monitor",
    systemVersion: "2.2.0",
    schemaVersion: "10",
  },
  artifact: {
    kind: "sqlite-backup",
    path: "/private/offline/kuma.sqlite",
    sha256: "b".repeat(64),
    cutoffAt: "2026-09-09T10:00:00Z",
    exportedAt: "2026-09-09T10:05:00Z",
    sourceTimeZone: "UTC",
  },
  mappings: [{ componentId: "public-api", entityType: "monitor", externalId: "11" }],
};

function bundle(overrides: Record<string, unknown> = {}) {
  return createHistoryImportBundle({
    schemaVersion: "1.0.0",
    siteId: request.siteId,
    topologyRevision: request.topologyRevision,
    source: request.source,
    extraction: {
      adapterId: "uptime-kuma-sqlite",
      adapterVersion: "1.0.0",
      artifactKind: request.artifact.kind,
      artifactSha256: request.artifact.sha256,
      cutoffAt: request.artifact.cutoffAt,
      exportedAt: request.artifact.exportedAt,
      sourceTimeZone: request.artifact.sourceTimeZone,
    },
    components: [
      {
        componentId: "public-api",
        sourceBinding: {
          sourceId: request.source.sourceId,
          entityType: "monitor",
          externalId: "11",
        },
        coverage: { startsOn: "2026-09-07", endsOn: "2026-09-08" },
        history: [
          {
            date: "2026-09-07",
            state: "operational",
            severity: "none",
            uptime: 100,
            downMinutes: 0,
            avgMs: 121,
          },
          {
            date: "2026-09-08",
            state: "degraded",
            severity: "minor",
            uptime: 99.8,
            downMinutes: 3,
            avgMs: 149,
          },
        ],
      },
    ],
    ...overrides,
  } as never);
}

describe("history extractor registry", () => {
  test("selects an installed extractor and validates its normalized output", async () => {
    const registry = new HistoryExtractorRegistry([
      {
        id: "uptime-kuma-sqlite",
        version: "1.0.0",
        extract: async () => bundle(),
      },
    ]);

    expect(registry.ids()).toEqual(["uptime-kuma-sqlite"]);
    expect((await registry.extract("uptime-kuma-sqlite", request)).siteId).toBe("example-service");
  });

  test("rejects missing, duplicate, invalid, and boundary-changing extractors", async () => {
    expect(
      () =>
        new HistoryExtractorRegistry([
          { id: "same", version: "1", extract: async () => bundle() },
          { id: "same", version: "2", extract: async () => bundle() },
        ]),
    ).toThrow("Duplicate history extractor");

    const missing = new HistoryExtractorRegistry([]);
    await expect(missing.extract("missing", request)).rejects.toThrow("not installed");

    const invalid = new HistoryExtractorRegistry([
      { id: "invalid", version: "1.0.0", extract: async () => ({}) },
    ]);
    await expect(invalid.extract("invalid", request)).rejects.toThrow("invalid bundle");

    const changed = new HistoryExtractorRegistry([
      {
        id: "uptime-kuma-sqlite",
        version: "1.0.0",
        extract: async () =>
          bundle({
            components: [
              {
                ...bundle().components[0],
                sourceBinding: {
                  ...bundle().components[0].sourceBinding,
                  externalId: "99",
                },
              },
            ],
          }),
      },
    ]);
    await expect(changed.extract("uptime-kuma-sqlite", request)).rejects.toThrow(
      "immutable import boundary",
    );
  });

  test("validates before extraction and isolates immutable boundaries from adapter mutation", async () => {
    let called = false;
    const guarded = new HistoryExtractorRegistry([
      {
        id: "uptime-kuma-sqlite",
        version: "1.0.0",
        extract: async (input) => {
          called = true;
          expect(Object.isFrozen(input)).toBe(true);
          expect(Object.isFrozen(input.artifact)).toBe(true);
          try {
            input.siteId = "changed-site";
            input.artifact.sha256 = "c".repeat(64);
            input.mappings[0].externalId = "99";
          } catch {
            // Frozen input is expected to reject writes in strict mode.
          }
          return bundle();
        },
      },
    ]);

    await expect(
      guarded.extract("uptime-kuma-sqlite", {
        ...request,
        artifact: { ...request.artifact, path: "relative.sqlite" },
      }),
    ).rejects.toThrow("request is invalid");
    expect(called).toBe(false);

    expect((await guarded.extract("uptime-kuma-sqlite", request)).siteId).toBe(request.siteId);
    expect(request.artifact.sha256).toBe("b".repeat(64));
    expect(request.mappings[0].externalId).toBe("11");
  });
});

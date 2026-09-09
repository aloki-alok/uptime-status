import { describe, expect, test } from "bun:test";
import {
  createHistoryImportBundle,
  type HistoryImportBundle,
  type HistoryImportBundleContent,
  historyImportId,
  validateHistoryImportBundle,
} from "../src/history-import";

const bundle = createHistoryImportBundle({
  schemaVersion: "1.0.0",
  siteId: "site-a",
  topologyRevision: "topology-001",
  source: {
    systemId: "uptime-kuma",
    sourceId: "primary-monitor",
    systemVersion: "2.2.0",
    schemaVersion: "10",
  },
  extraction: {
    adapterId: "uptime-kuma-sqlite",
    adapterVersion: "1.0.0",
    artifactKind: "sqlite-backup",
    artifactSha256: "b".repeat(64),
    cutoffAt: "2026-09-09T10:00:00Z",
    exportedAt: "2026-09-09T10:05:00Z",
    sourceTimeZone: "UTC",
  },
  components: [
    {
      componentId: "public-api",
      sourceBinding: {
        sourceId: "primary-monitor",
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
      latency: [
        { observedAt: "2026-09-08T09:58:00Z", avgMs: 118, p95Ms: 149 },
        { observedAt: "2026-09-08T09:59:00Z", avgMs: 120, p95Ms: 151 },
      ],
    },
  ],
});

function sign(value: HistoryImportBundle | HistoryImportBundleContent) {
  const { importId: _importId, ...content } = value as HistoryImportBundle;
  return createHistoryImportBundle(content);
}

describe("history import bundle", () => {
  test("accepts a private provider-neutral history bundle", () => {
    expect(validateHistoryImportBundle(bundle)).toBe(true);
    expect(historyImportId(bundle)).toBe(bundle.importId);
  });

  test("rejects forged IDs and produces stable canonical IDs", () => {
    expect(validateHistoryImportBundle({ ...bundle, importId: "a".repeat(64) })).toBe(false);
    const reordered = {
      ...bundle,
      extraction: {
        sourceTimeZone: bundle.extraction.sourceTimeZone,
        exportedAt: bundle.extraction.exportedAt,
        cutoffAt: bundle.extraction.cutoffAt,
        artifactSha256: bundle.extraction.artifactSha256,
        artifactKind: bundle.extraction.artifactKind,
        adapterVersion: bundle.extraction.adapterVersion,
        adapterId: bundle.extraction.adapterId,
      },
    };
    expect(historyImportId(reordered)).toBe(bundle.importId);
  });

  test("rejects unknown fields and duplicate mappings", () => {
    expect(
      validateHistoryImportBundle(sign({ ...bundle, monitorUrl: "https://private.test" } as never)),
    ).toBe(false);
    expect(
      validateHistoryImportBundle(
        sign({
          ...bundle,
          components: [bundle.components[0], { ...bundle.components[0], componentId: "website" }],
        }),
      ),
    ).toBe(false);
  });

  test("rejects observations after the backup cutoff and unordered history", () => {
    expect(
      validateHistoryImportBundle(
        sign({
          ...bundle,
          components: [
            {
              ...bundle.components[0],
              latency: [{ observedAt: "2026-09-09T10:01:00Z", avgMs: 120, p95Ms: 151 }],
            },
          ],
        }),
      ),
    ).toBe(false);
    expect(
      validateHistoryImportBundle(
        sign({
          ...bundle,
          components: [
            { ...bundle.components[0], history: [...bundle.components[0].history].reverse() },
          ],
        }),
      ),
    ).toBe(false);
  });

  test("orders latency by the represented instant, not timestamp text", () => {
    expect(
      validateHistoryImportBundle(
        sign({
          ...bundle,
          components: [
            {
              ...bundle.components[0],
              latency: [
                { observedAt: "2026-09-08T10:00:00+01:00", avgMs: 118, p95Ms: 149 },
                { observedAt: "2026-09-08T09:30:00Z", avgMs: 120, p95Ms: 151 },
              ],
            },
          ],
        }),
      ),
    ).toBe(true);
    expect(
      validateHistoryImportBundle(
        sign({
          ...bundle,
          components: [
            {
              ...bundle.components[0],
              latency: [
                { observedAt: "2026-09-08T09:30:00Z", avgMs: 118, p95Ms: 149 },
                { observedAt: "2026-09-08T10:00:00+01:00", avgMs: 120, p95Ms: 151 },
              ],
            },
          ],
        }),
      ),
    ).toBe(false);
  });

  test("rejects invalid source time zones and pre-cutoff export timestamps", () => {
    expect(
      validateHistoryImportBundle(
        sign({
          ...bundle,
          extraction: { ...bundle.extraction, sourceTimeZone: "Not/A_Timezone" },
        }),
      ),
    ).toBe(false);
    expect(
      validateHistoryImportBundle(
        sign({
          ...bundle,
          extraction: { ...bundle.extraction, exportedAt: "2026-09-09T09:59:00Z" },
        }),
      ),
    ).toBe(false);
  });

  test("accepts open adapter identifiers and rejects mismatched source bindings", () => {
    expect(
      validateHistoryImportBundle(
        sign({
          ...bundle,
          extraction: {
            ...bundle.extraction,
            adapterId: "uptime-kuma-mariadb",
            artifactKind: "sql-dump",
          },
        }),
      ),
    ).toBe(true);
    expect(
      validateHistoryImportBundle(
        sign({
          ...bundle,
          components: [
            {
              ...bundle.components[0],
              sourceBinding: { ...bundle.components[0].sourceBinding, sourceId: "another-source" },
            },
          ],
        }),
      ),
    ).toBe(false);
  });

  test("requires coverage to match the imported daily range", () => {
    expect(
      validateHistoryImportBundle(
        sign({
          ...bundle,
          components: [
            {
              ...bundle.components[0],
              coverage: { startsOn: "2026-09-06", endsOn: "2026-09-08" },
            },
          ],
        }),
      ),
    ).toBe(false);
  });
});

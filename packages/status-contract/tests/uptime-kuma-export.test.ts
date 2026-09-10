import { describe, expect, test } from "bun:test";
import type { UptimeKumaExport } from "../src/uptime-kuma-export";
import { uptimeKumaSourceRevision, validateUptimeKumaExport } from "../src/uptime-kuma-export";

const DAY_MS = 86_400_000;
const generatedAt = "2026-09-11T05:30:05.000Z";

function history() {
  const end = Date.parse("2026-09-11T00:00:00.000Z");
  return Array.from({ length: 90 }, (_, index) => ({
    date: new Date(end - (89 - index) * DAY_MS).toISOString().slice(0, 10),
    state: "operational" as const,
    severity: "none" as const,
    uptime: index === 89 ? null : 100,
    downMinutes: 0,
    avgMs: 80 + index / 10,
  }));
}

async function validExport(): Promise<UptimeKumaExport> {
  const value: UptimeKumaExport = {
    schemaVersion: "1.0.0",
    generatedAt,
    latestCheckAt: "2026-09-11T05:29:54.000Z",
    sourceRevision: "0".repeat(64),
    components: Array.from({ length: 5 }, (_, index) => ({
      componentId: `source-${index + 1}`,
      state: "operational" as const,
      latestCheckAt: new Date(Date.parse("2026-09-11T05:29:58.000Z") - index * 1000).toISOString(),
      responseTimeMs: 80 + index,
      latency: [
        {
          observedAt: "2026-09-11T05:28:00.000Z",
          avgMs: 79 + index,
          sampleCount: 1,
        },
        {
          observedAt: "2026-09-11T05:29:00.000Z",
          avgMs: 80 + index,
          sampleCount: 2,
        },
      ],
      history: history(),
    })),
  };
  value.sourceRevision = await uptimeKumaSourceRevision(value);
  return value;
}

describe("private Uptime Kuma export contract", () => {
  test("accepts five mapped components with truthful sparse monitoring data", async () => {
    const value = await validExport();

    expect(
      await validateUptimeKumaExport(
        value,
        value.components.map((component) => component.componentId),
      ),
    ).toBe(true);
    expect(JSON.stringify(value)).not.toMatch(/url|message|secret|monitorId/i);
  });

  test("keeps the source revision stable when component order changes", async () => {
    const value = await validExport();
    const reordered = { ...value, components: [...value.components].reverse() };

    expect(await uptimeKumaSourceRevision(reordered)).toBe(value.sourceRevision);
    expect(
      await validateUptimeKumaExport(
        reordered,
        value.components.map(({ componentId }) => componentId),
      ),
    ).toBe(true);
  });

  test("excludes generatedAt and sourceRevision from the canonical content hash", async () => {
    const value = await validExport();
    const metadataOnlyChange = {
      ...value,
      generatedAt: "2026-09-11T05:30:06.000Z",
      sourceRevision: "f".repeat(64),
    };

    expect(await uptimeKumaSourceRevision(metadataOnlyChange)).toBe(value.sourceRevision);
  });

  test("rejects unknown fields, wrong mappings, and a forged content revision", async () => {
    const unknownField = { ...(await validExport()), internalUrl: "https://private.example.test" };
    const wrongMapping = await validExport();
    const forgedRevision = await validExport();
    forgedRevision.components[0].responseTimeMs = 999;

    expect(await validateUptimeKumaExport(unknownField)).toBe(false);
    expect(await validateUptimeKumaExport(wrongMapping, ["different-source"])).toBe(false);
    expect(await validateUptimeKumaExport(forgedRevision)).toBe(false);
  });

  test("rejects false freshness and malformed minute buckets", async () => {
    const falseFreshness = await validExport();
    falseFreshness.latestCheckAt = falseFreshness.components[0].latestCheckAt;
    falseFreshness.sourceRevision = await uptimeKumaSourceRevision(falseFreshness);
    const filledGap = await validExport();
    filledGap.components[0].latency[0].observedAt = "2026-09-11T04:29:00.000Z";
    filledGap.sourceRevision = await uptimeKumaSourceRevision(filledGap);

    expect(await validateUptimeKumaExport(falseFreshness)).toBe(false);
    expect(await validateUptimeKumaExport(filledGap)).toBe(false);
  });

  test("rejects optimistic or internally inconsistent history", async () => {
    const missingDay = await validExport();
    missingDay.components[0].history[1].date = missingDay.components[0].history[0].date;
    missingDay.sourceRevision = await uptimeKumaSourceRevision(missingDay);
    const falseOutage = await validExport();
    falseOutage.components[0].history[20] = {
      ...falseOutage.components[0].history[20],
      state: "major_outage",
      severity: "major",
      downMinutes: 2,
    };
    falseOutage.sourceRevision = await uptimeKumaSourceRevision(falseOutage);

    expect(await validateUptimeKumaExport(missingDay)).toBe(false);
    expect(await validateUptimeKumaExport(falseOutage)).toBe(false);
  });
});

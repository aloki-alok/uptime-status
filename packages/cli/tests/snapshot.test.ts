import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { type StatusSnapshot, validateStatusSnapshot } from "@uptime-status/domain/snapshot";
import { createProbeSnapshot } from "../src/snapshot";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function setup() {
  const directory = mkdtempSync(resolve(tmpdir(), "uptime-status-probe-"));
  temporaryDirectories.push(directory);
  const sitePath = resolve(directory, "status.config.json");
  const outputPath = resolve(directory, "current.json");
  const config = {
    schemaVersion: "1.0.0",
    deploymentMode: "production",
    siteId: "test-site",
    displayName: "Test site",
    legalName: "Test site",
    locale: "en-US",
    timeZone: "UTC",
    domains: { primary: "status.example.com" },
    brand: {
      homeUrl: "https://example.com",
      logoLightPath: "./favicon.svg",
      logoDarkPath: "./favicon.svg",
      iconLightPath: "./favicon.svg",
      iconDarkPath: "./favicon.svg",
      faviconPath: "./favicon.svg",
      logoAlt: "Test site",
    },
    presentation: {
      statusCopy: {
        operational: "Operational",
        degraded: "Degraded",
        partialOutage: "Partial outage",
        majorOutage: "Outage",
        maintenance: "Maintenance",
        unknown: "Delayed",
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
      staleAfterSeconds: 120,
      sources: [{ sourceId: "web", adapter: "https", url: "https://example.com/" }],
    },
    components: [
      {
        componentId: "website",
        name: "Website",
        group: "Website",
        sourceId: "web",
        monitorRef: "primary",
        showLatency: true,
      },
    ],
    subscriptions: { enabled: false, disabledReason: "not-ready", doubleOptIn: true },
  };
  writeFileSync(sitePath, JSON.stringify(config));
  return { sitePath, outputPath };
}

describe("snapshot probe command", () => {
  test("writes one truthful observation with unknown earlier history", async () => {
    const paths = setup();
    const moments = [new Date("2026-09-09T12:00:20Z"), new Date("2026-09-09T12:00:20.125Z")];
    const result = await createProbeSnapshot({
      ...paths,
      fetch: async () => new Response("ok", { status: 200 }),
      now: () => moments.shift() ?? new Date("2026-09-09T12:00:20.125Z"),
    });
    const snapshot = JSON.parse(readFileSync(paths.outputPath, "utf8")) as StatusSnapshot;

    expect(validateStatusSnapshot(snapshot)).toBe(true);
    expect(result.snapshot.components[0].latency).toEqual([
      { observedAt: "2026-09-09T12:00:00.000Z", avgMs: 125, sampleCount: 1 },
    ]);
    expect(
      snapshot.components[0].history.slice(0, -1).every((day) => day.state === "unknown"),
    ).toBe(true);
  });

  test("refuses to overwrite an existing snapshot", async () => {
    const paths = setup();
    writeFileSync(paths.outputPath, "keep");
    await expect(createProbeSnapshot(paths)).rejects.toThrow("Refusing to overwrite");
    expect(readFileSync(paths.outputPath, "utf8")).toBe("keep");
  });
});

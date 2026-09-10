import { describe, expect, test } from "bun:test";
import {
  type SiteConfig,
  type StatusSnapshot,
  type UptimeKumaExport,
  uptimeKumaSourceRevision,
} from "@uptime-status/domain";
import {
  NoLastKnownGoodKumaSnapshotError,
  publishUptimeKumaSnapshot,
  type UptimeKumaPublisherConfig,
} from "../src/uptime-kuma-publisher";

const DAY_MS = 86_400_000;
const publicAliases = Array.from({ length: 5 }, (_, index) => `public-${index + 1}`);

function site(): SiteConfig {
  return {
    schemaVersion: "1.0.0",
    deploymentMode: "production",
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
      staleAfterSeconds: 120,
      sources: [
        {
          sourceId: "kuma",
          adapter: "uptime-kuma",
          connection: { provider: "environment", reference: "KUMA_EXPORT_CONNECTION" },
        },
      ],
    },
    components: publicAliases.map((componentId, index) => ({
      componentId,
      name: `Public component ${index + 1}`,
      group: index < 3 ? "Core" : "Supporting",
      sourceId: "kuma",
      monitorRef: `private:kuma-monitor:${index + 101}`,
      showLatency: index === 0,
    })),
    subscriptions: {
      enabled: false,
      disabledReason: "delivery-not-configured",
      doubleOptIn: true,
    },
  };
}

function history(endDate: string) {
  const end = Date.parse(`${endDate}T00:00:00.000Z`);
  return Array.from({ length: 90 }, (_, index) => ({
    date: new Date(end - (89 - index) * DAY_MS).toISOString().slice(0, 10),
    state: "operational" as const,
    severity: "none" as const,
    uptime: index === 89 ? null : 100,
    downMinutes: 0,
    avgMs: 75 + index / 10,
  }));
}

async function sourceExport(generatedAt = "2026-09-11T05:30:05.000Z"): Promise<UptimeKumaExport> {
  const value: UptimeKumaExport = {
    schemaVersion: "1.0.0",
    generatedAt,
    latestCheckAt: "2026-09-11T05:29:54.000Z",
    sourceRevision: "0".repeat(64),
    components: publicAliases.map((componentId, index) => ({
      componentId,
      state: "operational" as const,
      latestCheckAt: new Date(Date.parse("2026-09-11T05:29:58.000Z") - index * 1000).toISOString(),
      responseTimeMs: 80 + index,
      latency: [
        { observedAt: "2026-09-11T05:28:00.000Z", avgMs: 79 + index, sampleCount: 1 },
        { observedAt: "2026-09-11T05:29:00.000Z", avgMs: 80 + index, sampleCount: 2 },
      ],
      history: history(generatedAt.slice(0, 10)),
    })),
  };
  value.sourceRevision = await uptimeKumaSourceRevision(value);
  return value;
}

function config(): UptimeKumaPublisherConfig {
  return {
    site: site(),
    sourceId: "kuma",
    endpointUrl: "https://monitor.internal.example/api/status-export/v1/public",
    authorization: "Bearer private-token-value-with-32-characters",
  };
}

function jsonResponse(value: unknown, status = 200) {
  return Response.json(value, { status });
}

describe("Uptime Kuma export publisher", () => {
  test("validates the raw export and maps public aliases independently of monitorRef", async () => {
    const published: StatusSnapshot[] = [];
    const source = await sourceExport();
    let requestInit: RequestInit | undefined;
    const result = await publishUptimeKumaSnapshot(config(), {
      readCurrent: async () => null,
      publish: async (snapshot) => {
        published.push(snapshot);
      },
      fetch: async (_url, init) => {
        requestInit = init;
        return jsonResponse(source);
      },
      now: () => new Date("2026-09-11T05:30:06.000Z"),
    });

    expect(result.kind).toBe("published");
    expect(result.snapshot.latestCheckAt).toBe(source.latestCheckAt);
    expect(result.snapshot.components.map((component) => component.slug)).toEqual(
      site().components.map((component) => component.componentId),
    );
    expect(result.snapshot.components[0].name).toBe("Public component 1");
    expect(result.snapshot.components[0].latency).toEqual(source.components[0].latency);
    expect(result.snapshot.components[1].latency).toBeNull();
    expect(published).toEqual([result.snapshot]);
    expect(requestInit?.redirect).toBe("manual");
    expect(new Headers(requestInit?.headers).get("authorization")).toBe(
      "Bearer private-token-value-with-32-characters",
    );
    expect(JSON.stringify(result.snapshot)).not.toMatch(
      /private-token|monitor\.internal|private:kuma-monitor/,
    );
  });

  test("publishes stale source data only with an unknown overall status", async () => {
    const source = await sourceExport();
    const result = await publishUptimeKumaSnapshot(config(), {
      readCurrent: async () => null,
      publish: async () => {},
      fetch: async () => jsonResponse(source),
      now: () => new Date("2026-09-11T05:33:00.000Z"),
    });

    expect(result.snapshot.overallStatus).toBe("unknown");
    expect(result.snapshot.components.every((component) => component.state === "operational")).toBe(
      true,
    );
  });

  test("retains the exact last-known-good snapshot for unavailable or invalid exports", async () => {
    const firstSource = await sourceExport();
    const first = await publishUptimeKumaSnapshot(config(), {
      readCurrent: async () => null,
      publish: async () => {},
      fetch: async () => jsonResponse(firstSource),
      now: () => new Date("2026-09-11T05:30:06.000Z"),
    });
    const cases: Array<() => Promise<Response>> = [
      async () => {
        throw new TypeError("network unavailable");
      },
      async () => jsonResponse({ error: "upstream failure" }, 503),
      async () => new Response("not-json", { status: 200 }),
      async () => jsonResponse({ data: firstSource }),
      async () => jsonResponse({ ...firstSource, privateUrl: "https://internal.example" }),
      async () =>
        new Response("{}", {
          status: 200,
          headers: { "content-length": "1048577" },
        }),
    ];

    for (const fetcher of cases) {
      const published: StatusSnapshot[] = [];
      const result = await publishUptimeKumaSnapshot(config(), {
        readCurrent: async () => first.snapshot,
        publish: async (snapshot) => {
          published.push(snapshot);
        },
        fetch: fetcher,
        now: () => new Date("2026-09-11T05:31:06.000Z"),
      });
      expect(result).toEqual({
        kind: "retained",
        snapshot: first.snapshot,
        reason: "source-unavailable",
      });
      expect(published).toHaveLength(0);
    }
  });

  test("fails closed before the first valid export and rejects non-monotonic publication", async () => {
    await expect(
      publishUptimeKumaSnapshot(config(), {
        readCurrent: async () => null,
        publish: async () => {},
        fetch: async () => new Response("not-json", { status: 200 }),
      }),
    ).rejects.toBeInstanceOf(NoLastKnownGoodKumaSnapshotError);

    const source = await sourceExport();
    const first = await publishUptimeKumaSnapshot(config(), {
      readCurrent: async () => null,
      publish: async () => {},
      fetch: async () => jsonResponse(source),
      now: () => new Date("2026-09-11T05:30:06.000Z"),
    });
    const result = await publishUptimeKumaSnapshot(config(), {
      readCurrent: async () => first.snapshot,
      publish: async () => {
        throw new Error("must not publish");
      },
      fetch: async () => jsonResponse(source),
      now: () => new Date("2026-09-11T05:31:06.000Z"),
    });

    expect(result).toEqual({
      kind: "retained",
      snapshot: first.snapshot,
      reason: "non-monotonic-export",
    });
  });

  test("rejects malformed endpoint and bearer configuration before fetching", async () => {
    const fetcher = async () => {
      throw new Error("must not fetch");
    };
    await expect(
      publishUptimeKumaSnapshot(
        {
          ...config(),
          endpointUrl: "https://monitor.internal.example/api/status-export/v1evil/all",
        },
        { readCurrent: async () => null, publish: async () => {}, fetch: fetcher },
      ),
    ).rejects.toThrow("private versioned HTTPS URL");
    await expect(
      publishUptimeKumaSnapshot(
        { ...config(), authorization: "Bearer short" },
        { readCurrent: async () => null, publish: async () => {}, fetch: fetcher },
      ),
    ).rejects.toThrow("authorization value is invalid");
  });
});

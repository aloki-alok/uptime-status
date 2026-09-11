import { describe, expect, test } from "bun:test";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import type { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import {
  type SiteConfig,
  type UptimeKumaExport,
  uptimeKumaSourceRevision,
} from "@uptime-status/domain";
import { createAwsSnapshotHandler } from "../src/aws-handler";

const DAY_MS = 86_400_000;
const TOKEN = "private-token-value-with-at-least-32-characters";

function site(): SiteConfig {
  return {
    schemaVersion: "1.0.0",
    deploymentMode: "production",
    siteId: "example-site",
    displayName: "Example site",
    legalName: "Example site",
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
      logoAlt: "Example site",
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
          connection: { provider: "aws-secrets-manager", reference: "monitoring-secret" },
        },
      ],
    },
    components: [
      {
        componentId: "api",
        name: "API",
        group: "Services",
        sourceId: "kuma",
        monitorRef: "private:monitor:1",
        showLatency: true,
      },
    ],
    subscriptions: {
      enabled: false,
      disabledReason: "delivery-not-configured",
      doubleOptIn: true,
    },
  };
}

function history() {
  const end = Date.parse("2026-09-11T00:00:00.000Z");
  return Array.from({ length: 90 }, (_, index) => ({
    date: new Date(end - (89 - index) * DAY_MS).toISOString().slice(0, 10),
    state: "operational" as const,
    severity: "none" as const,
    uptime: index === 89 ? null : 100,
    downMinutes: 0,
    avgMs: 45,
  }));
}

async function sourceExport(): Promise<UptimeKumaExport> {
  const value: UptimeKumaExport = {
    schemaVersion: "1.0.0",
    generatedAt: "2026-09-11T05:30:05.000Z",
    latestCheckAt: "2026-09-11T05:29:58.000Z",
    sourceRevision: "0".repeat(64),
    components: [
      {
        componentId: "api",
        state: "operational",
        latestCheckAt: "2026-09-11T05:29:58.000Z",
        responseTimeMs: 45,
        latency: [{ observedAt: "2026-09-11T05:29:00.000Z", avgMs: 45, sampleCount: 1 }],
        history: history(),
      },
    ],
  };
  value.sourceRevision = await uptimeKumaSourceRevision(value);
  return value;
}

function secretString() {
  return JSON.stringify({
    schemaVersion: "1.0.0",
    endpointUrl: "https://monitor.example.com/api/status-export/v1/all",
    bearerToken: TOKEN,
  });
}

function environment() {
  return {
    STATUS_BUCKET: "status-bucket",
    MONITORING_SECRET_ARN:
      "arn:aws:secretsmanager:ap-south-1:123456789012:secret:monitoring-abc123",
    STATUS_SITE_CONFIG: JSON.stringify(site()),
    STATUS_SOURCE_ID: "kuma",
  };
}

describe("AWS snapshot handler", () => {
  test("reads one managed secret and publishes immutable state before current state", async () => {
    const commands: unknown[] = [];
    const s3 = {
      send: async (command: unknown) => {
        commands.push(command);
        if (command instanceof GetObjectCommand) {
          const error = Object.assign(new Error("missing"), { name: "NoSuchKey" });
          throw error;
        }
        return {};
      },
    };
    const secretCommands: unknown[] = [];
    const secrets = {
      send: async (command: unknown) => {
        secretCommands.push(command);
        return { SecretString: secretString() };
      },
    };
    const source = await sourceExport();
    const handler = createAwsSnapshotHandler(
      s3 as never,
      secrets as never,
      environment(),
      async () => Response.json(source),
      () => new Date("2026-09-11T05:30:06.000Z"),
    );
    const result = await handler();

    expect(result.kind).toBe("published");
    expect(secretCommands).toHaveLength(1);
    expect((secretCommands[0] as GetSecretValueCommand).input.SecretId).toContain("monitoring");
    const writes = commands.filter((command) => command instanceof PutObjectCommand);
    expect(writes).toHaveLength(2);
    expect((writes[0] as PutObjectCommand).input).toMatchObject({
      Key: `snapshots/${source.sourceRevision}.json`,
      IfNoneMatch: "*",
    });
    expect((writes[1] as PutObjectCommand).input).toMatchObject({
      Bucket: "status-bucket",
      Key: "current.json",
      CacheControl: "no-cache, no-store, must-revalidate",
      ServerSideEncryption: "AES256",
    });
  });

  test("does not replace current state when the immutable revision already exists", async () => {
    const commands: unknown[] = [];
    const existing = Object.assign(new Error("exists"), { name: "PreconditionFailed" });
    const s3 = {
      send: async (command: unknown) => {
        commands.push(command);
        if (command instanceof GetObjectCommand) {
          const error = Object.assign(new Error("missing"), { name: "NoSuchKey" });
          throw error;
        }
        if (command instanceof PutObjectCommand && command.input.Key?.startsWith("snapshots/")) {
          throw existing;
        }
        return {};
      },
    };
    const source = await sourceExport();
    const handler = createAwsSnapshotHandler(
      s3 as never,
      { send: async () => ({ SecretString: secretString() }) } as never,
      environment(),
      async () => Response.json(source),
      () => new Date("2026-09-11T05:30:06.000Z"),
    );

    await expect(handler()).resolves.toMatchObject({ kind: "published" });
    expect(commands.filter((command) => command instanceof PutObjectCommand)).toHaveLength(2);
  });

  test("retains current state without writes when Kuma is unavailable", async () => {
    const source = await sourceExport();
    const first = await createAwsSnapshotHandler(
      {
        send: async (command: unknown) => {
          if (command instanceof GetObjectCommand) {
            const error = Object.assign(new Error("missing"), { name: "NoSuchKey" });
            throw error;
          }
          return {};
        },
      } as never,
      { send: async () => ({ SecretString: secretString() }) } as never,
      environment(),
      async () => Response.json(source),
      () => new Date("2026-09-11T05:30:06.000Z"),
    )();

    const writes: unknown[] = [];
    const retained = await createAwsSnapshotHandler(
      {
        send: async (command: unknown) => {
          if (command instanceof PutObjectCommand) writes.push(command);
          if (command instanceof GetObjectCommand) {
            return { Body: { transformToString: async () => JSON.stringify(first.snapshot) } };
          }
          return {};
        },
      } as never,
      { send: async () => ({ SecretString: secretString() }) } as never,
      environment(),
      async () => new Response(null, { status: 503 }),
      () => new Date("2026-09-11T05:31:06.000Z"),
    )();

    expect(retained).toEqual({
      kind: "retained",
      snapshot: first.snapshot,
      reason: "source-unavailable",
    });
    expect(writes).toHaveLength(0);
  });

  test("fails before S3 access when configuration or secret content is invalid", async () => {
    expect(() =>
      createAwsSnapshotHandler(
        { send: async () => ({}) } as never,
        { send: async () => ({}) } as never,
        {},
      ),
    ).toThrow("STATUS_BUCKET is required");

    const commands: unknown[] = [];
    const handler = createAwsSnapshotHandler(
      { send: async (command: unknown) => commands.push(command) } as never,
      { send: async () => ({ SecretString: '{"bearerToken":"secret"}' }) } as never,
      environment(),
    );

    await expect(handler()).rejects.toThrow("invalid shape");
    expect(commands).toHaveLength(0);

    const binaryOnly = createAwsSnapshotHandler(
      { send: async (command: unknown) => commands.push(command) } as never,
      { send: async () => ({ SecretBinary: new Uint8Array([1, 2, 3]) }) } as never,
      environment(),
    );
    await expect(binaryOnly()).rejects.toThrow("monitoring secret is missing");
    expect(commands).toHaveLength(0);
  });
});

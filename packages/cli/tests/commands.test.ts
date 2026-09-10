import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { buildSite, doctorSite, initSite } from "../src/commands";

const temporaryDirectories: string[] = [];

function temporaryDirectory() {
  const directory = mkdtempSync(resolve(tmpdir(), "uptime-status-cli-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("init", () => {
  test("copies the neutral package template", () => {
    const destination = resolve(temporaryDirectory(), "site");
    initSite(destination);
    const config = JSON.parse(readFileSync(resolve(destination, "status.config.json"), "utf8"));
    expect(config.siteId).toBe("change-me");
    expect(config.deploymentMode).toBe("production");
    expect(existsSync(resolve(destination, "assets/favicon.svg"))).toBe(true);
  });

  test("refuses to overwrite an existing path", () => {
    const destination = temporaryDirectory();
    const marker = resolve(destination, "keep.txt");
    writeFileSync(marker, "unchanged");
    expect(() => initSite(destination)).toThrow("Refusing to overwrite");
    expect(readFileSync(marker, "utf8")).toBe("unchanged");
  });
});

describe("doctor", () => {
  test("checks Bun, config, assets, and environment secret references", () => {
    const destination = resolve(temporaryDirectory(), "site");
    initSite(destination);
    const sitePath = resolve(destination, "status.config.json");
    const passing = doctorSite({
      sitePath,
      bunVersion: "1.3.14",
      expectedBunVersion: "1.3.14",
      environment: { UPTIME_KUMA_CONNECTION: "https://monitor.example.test" },
    });
    expect(passing.every((check) => check.ok)).toBe(true);

    const failing = doctorSite({
      sitePath,
      bunVersion: "1.3.13",
      expectedBunVersion: "1.3.14",
      environment: {},
    });
    expect(failing.find((check) => check.name === "Bun version")?.ok).toBe(false);
    expect(failing.find((check) => check.name.startsWith("Secret "))?.ok).toBe(false);
  });

  test("reports a missing referenced asset", () => {
    const destination = resolve(temporaryDirectory(), "site");
    initSite(destination);
    rmSync(resolve(destination, "assets/favicon.svg"));
    const checks = doctorSite({
      sitePath: resolve(destination, "status.config.json"),
      bunVersion: "1.3.14",
      expectedBunVersion: "1.3.14",
      environment: { UPTIME_KUMA_CONNECTION: "set" },
    });
    expect(checks.find((check) => check.name === "Asset brand.faviconPath")?.ok).toBe(false);
  });

  test("checks Resend environment secret references", () => {
    const destination = resolve(temporaryDirectory(), "site");
    initSite(destination);
    const sitePath = resolve(destination, "status.config.json");
    const config = JSON.parse(readFileSync(sitePath, "utf8"));
    config.subscriptions = {
      enabled: true,
      doubleOptIn: true,
      notificationFanoutEnabled: false,
      delivery: {
        provider: "resend",
        connection: { provider: "environment", reference: "RESEND_API_KEY" },
        senderEmail: "status@example.com",
      },
      confirmationTtlSeconds: 86_400,
      resendCooldownSeconds: 900,
    };
    writeFileSync(sitePath, JSON.stringify(config));

    const missing = doctorSite({
      sitePath,
      bunVersion: "1.3.14",
      expectedBunVersion: "1.3.14",
      environment: {},
    });
    const present = doctorSite({
      sitePath,
      bunVersion: "1.3.14",
      expectedBunVersion: "1.3.14",
      environment: { RESEND_API_KEY: "set" },
    });

    expect(
      missing.find((check) => check.name === "Secret subscriptions.delivery.connection")?.ok,
    ).toBe(false);
    expect(
      present.find((check) => check.name === "Secret subscriptions.delivery.connection")?.ok,
    ).toBe(true);
  });
});

describe("build", () => {
  test("passes explicit absolute site and snapshot paths to the web build", async () => {
    const directory = temporaryDirectory();
    const destination = resolve(directory, "site");
    initSite(destination);
    const sitePath = resolve(destination, "status.config.json");
    const snapshotPath = resolve(directory, "snapshot.json");
    writeFileSync(snapshotPath, "{}");
    let invocation: Parameters<NonNullable<Parameters<typeof buildSite>[1]>>[0] | undefined;

    await buildSite({ sitePath, snapshotPath }, async (input) => {
      invocation = input;
      return 0;
    });

    expect(invocation?.command).toEqual(["bun", "run", "build"]);
    expect(invocation?.environment.STATUS_SITE_CONFIG).toBe(sitePath);
    expect(invocation?.environment.STATUS_SNAPSHOT_PATH).toBe(snapshotPath);
    expect(invocation?.cwd.endsWith("/apps/web")).toBe(true);
  });

  test("clears an inherited snapshot when no snapshot is supplied", async () => {
    const directory = temporaryDirectory();
    const destination = resolve(directory, "site");
    initSite(destination);
    let snapshot: string | undefined;
    await buildSite({ sitePath: resolve(destination, "status.config.json") }, async (input) => {
      snapshot = input.environment.STATUS_SNAPSHOT_PATH;
      return 0;
    });
    expect(snapshot).toBe("");
  });

  test("surfaces a failed web build", async () => {
    const destination = resolve(temporaryDirectory(), "site");
    initSite(destination);
    expect(
      buildSite({ sitePath: resolve(destination, "status.config.json") }, async () => 7),
    ).rejects.toThrow("exit code 7");
  });
});

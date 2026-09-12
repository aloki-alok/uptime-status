import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createHistoryImportBundle } from "@uptime-status/domain";
import { initSite } from "../src/commands";
import { run } from "../src/index";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function setup() {
  const directory = mkdtempSync(resolve(tmpdir(), "uptime-status-history-exec-"));
  temporaryDirectories.push(directory);
  const siteDirectory = resolve(directory, "site");
  initSite(siteDirectory);
  const sitePath = resolve(siteDirectory, "status.config.json");
  const config = JSON.parse(readFileSync(sitePath, "utf8"));

  const bundle = createHistoryImportBundle({
    schemaVersion: "1.0.0",
    siteId: config.siteId,
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
        componentId: "website",
        sourceBinding: { sourceId: "primary", entityType: "monitor", externalId: "11" },
        coverage: { startsOn: "2026-09-08", endsOn: "2026-09-09" },
        history: [
          {
            date: "2026-09-08",
            state: "operational",
            severity: "none",
            uptime: 100,
            downMinutes: 0,
            avgMs: 75,
          },
          {
            date: "2026-09-09",
            state: "operational",
            severity: "none",
            uptime: 100,
            downMinutes: 0,
            avgMs: 80,
          },
        ],
      },
    ],
  });

  const bundlePath = resolve(directory, "history.bundle.json");
  writeFileSync(bundlePath, JSON.stringify(bundle));
  const databasePath = resolve(directory, "monitor.sqlite");

  return { sitePath, bundlePath, databasePath };
}

function commandArgs(
  command: string,
  paths: ReturnType<typeof setup>,
  extra: string[] = [],
): string[] {
  return [
    "history",
    command,
    "--site",
    paths.sitePath,
    "--bundle",
    paths.bundlePath,
    "--database",
    paths.databasePath,
    ...extra,
  ];
}

async function withCapturedLogs(fn: () => Promise<number>) {
  const lines: string[] = [];
  const original = console.log;
  console.log = (line: string) => {
    lines.push(line);
  };
  try {
    const exitCode = await fn();
    return { exitCode, output: lines.join("\n") };
  } finally {
    console.log = original;
  }
}

describe("history apply/verify/rollback commands", () => {
  test("apply writes rows, and a second apply reports a no-op", async () => {
    const paths = setup();

    const first = await withCapturedLogs(() => run(commandArgs("apply", paths)));
    expect(first.exitCode).toBe(0);
    expect(first.output).toContain("Daily rows written: 2");
    expect(first.output).toContain("History import applied.");

    const second = await withCapturedLogs(() => run(commandArgs("apply", paths)));
    expect(second.exitCode).toBe(0);
    expect(second.output).toContain("No-op: this import was already applied.");
  });

  test("verify succeeds after apply", async () => {
    const paths = setup();
    await run(commandArgs("apply", paths));

    const result = await withCapturedLogs(() => run(commandArgs("verify", paths)));
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Daily rows confirmed: 2");
    expect(result.output).toContain("Verified");
  });

  test("rollback without --yes deletes nothing and exits 0", async () => {
    const paths = setup();
    await run(commandArgs("apply", paths));

    const dryRun = await withCapturedLogs(() => run(commandArgs("rollback", paths)));
    expect(dryRun.exitCode).toBe(0);
    expect(dryRun.output).toContain("Daily rows that would be deleted: 2");
    expect(dryRun.output).toContain("Dry run: re-run with --yes");

    // A follow-up apply should still see the original import as already applied, proving
    // the dry run deleted nothing.
    const followUpApply = await withCapturedLogs(() => run(commandArgs("apply", paths)));
    expect(followUpApply.output).toContain("No-op");
  });

  test("rollback with --yes deletes the rows", async () => {
    const paths = setup();
    await run(commandArgs("apply", paths));

    const result = await withCapturedLogs(() => run(commandArgs("rollback", paths, ["--yes"])));
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Daily rows deleted: 2");
    expect(result.output).toContain("Rolled back.");

    // A follow-up apply should write fresh rows again, proving the rollback actually deleted them.
    const followUpApply = await withCapturedLogs(() => run(commandArgs("apply", paths)));
    expect(followUpApply.output).toContain("Daily rows written: 2");
    expect(followUpApply.output).toContain("History import applied.");
  });

  test("a missing required option produces a clear error, not a stack trace", async () => {
    const paths = setup();
    await expect(
      run(["history", "apply", "--bundle", paths.bundlePath, "--database", paths.databasePath]),
    ).rejects.toThrow("requires --site");
  });
});

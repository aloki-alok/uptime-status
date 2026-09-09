import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { validateHistoryImportBundle } from "@uptime-status/domain";
import { initSite } from "../src/commands";
import { inspectHistory } from "../src/history";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function setup() {
  const directory = mkdtempSync(resolve(tmpdir(), "uptime-status-history-cli-"));
  temporaryDirectories.push(directory);
  const siteDirectory = resolve(directory, "site");
  initSite(siteDirectory);
  const sitePath = resolve(siteDirectory, "status.config.json");
  const config = JSON.parse(readFileSync(sitePath, "utf8"));
  config.components[0].monitorRef = "11";
  writeFileSync(sitePath, JSON.stringify(config));

  const artifactPath = resolve(directory, "kuma-backup.sqlite");
  const database = new Database(artifactPath, { create: true, strict: true });
  database.run("CREATE TABLE monitor (id INTEGER PRIMARY KEY)");
  database.run(
    "CREATE TABLE heartbeat (id INTEGER PRIMARY KEY, monitor_id INTEGER, important BOOLEAN, status INTEGER, time DATETIME)",
  );
  database.run(
    "CREATE TABLE stat_daily (id INTEGER PRIMARY KEY, monitor_id INTEGER, timestamp INTEGER, ping REAL, up INTEGER, down INTEGER, extras TEXT)",
  );
  database.run("INSERT INTO monitor (id) VALUES (11)");
  database.run(
    "INSERT INTO stat_daily (monitor_id, timestamp, ping, up, down, extras) VALUES (11, 1788220800, 88.5, 100, 0, NULL)",
  );
  database.close();
  return {
    directory,
    sitePath,
    artifactPath,
    outputPath: resolve(directory, "history.bundle.json"),
  };
}

describe("history inspect command", () => {
  test("creates a private sanitized bundle from an offline SQLite backup", async () => {
    const paths = setup();
    const result = await inspectHistory({
      sitePath: paths.sitePath,
      sourceId: "primary",
      artifactPath: paths.artifactPath,
      cutoffAt: "2026-09-02T00:00:00Z",
      exportedAt: "2026-09-02T00:05:00Z",
      sourceVersion: "2.2.0",
      outputPath: paths.outputPath,
    });
    const bundle = JSON.parse(readFileSync(paths.outputPath, "utf8"));
    expect(validateHistoryImportBundle(bundle)).toBe(true);
    expect(bundle.importId).toBe(result.importId);
    expect(bundle.components[0].history[0]).toMatchObject({
      date: "2026-09-01",
      state: "operational",
      uptime: 100,
      avgMs: 88.5,
    });
    expect(JSON.stringify(bundle)).not.toContain("status.example.test");
    expect(existsSync(paths.outputPath)).toBe(true);

    await expect(
      inspectHistory({
        sitePath: paths.sitePath,
        sourceId: "primary",
        artifactPath: paths.artifactPath,
        cutoffAt: "2026-09-02T00:00:00Z",
        exportedAt: "2026-09-02T00:05:00Z",
        sourceVersion: "2.2.0",
        outputPath: paths.outputPath,
      }),
    ).rejects.toThrow("Refusing to overwrite");
  });
});

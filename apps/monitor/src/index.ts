// Entry point: `bun apps/monitor/src/index.ts`. Reads config from the environment, validates
// the site config before anything else touches the network or the database, then wires the
// real store/sink/scheduler via createMonitorApp and keeps the process alive until SIGINT/SIGTERM.
import { type SiteConfig, siteConfigIssues } from "@uptime-status/domain";
import { MonitorStore } from "@uptime-status/monitor";
import { createMonitorApp } from "./app";
import { createFilesystemSink } from "./sink";

function log(line: Record<string, unknown>) {
  console.log(JSON.stringify(line));
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is required`);
    process.exit(1);
  }
  return value;
}

async function readSiteConfig(path: string): Promise<SiteConfig> {
  let text: string;
  try {
    text = await Bun.file(path).text();
  } catch (err) {
    console.error(`could not read STATUS_SITE_CONFIG at ${path}: ${errorMessage(err)}`);
    process.exit(1);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    console.error(`STATUS_SITE_CONFIG at ${path} is not valid JSON: ${errorMessage(err)}`);
    process.exit(1);
  }
  const issues = siteConfigIssues(parsed);
  if (issues.length > 0) {
    console.error(`STATUS_SITE_CONFIG at ${path} failed validation:`);
    for (const issue of issues) console.error(`  ${issue.path}: ${issue.message}`);
    process.exit(1);
  }
  return parsed as SiteConfig;
}

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

async function main() {
  const siteConfigPath = requireEnv("STATUS_SITE_CONFIG");
  const databasePath = requireEnv("STATUS_DATABASE");
  const outputDir = requireEnv("STATUS_OUTPUT_DIR");
  const publishIntervalSeconds = Number(process.env.STATUS_PUBLISH_INTERVAL_SECONDS ?? 60);

  const site = await readSiteConfig(siteConfigPath);
  const store = new MonitorStore(databasePath);
  const sink = createFilesystemSink(outputDir);

  const app = createMonitorApp({ site, store, sink, publishIntervalSeconds, log });
  app.start();
  log({ kind: "monitor.started", targets: app.targets.length, publishIntervalSeconds });

  let shuttingDown = false;
  function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    log({ kind: "monitor.stopping", signal });
    app.stop();
    store.db.close();
    process.exit(0);
  }
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

if (import.meta.main) {
  main();
}

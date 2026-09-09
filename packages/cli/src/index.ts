#!/usr/bin/env bun
import {
  buildSite,
  doctorSite,
  formatIssues,
  initSite,
  resolveExplicitPath,
  validateSiteFile,
} from "./commands";
import { inspectHistory } from "./history";
import { createProbeSnapshot } from "./snapshot";

export const HELP = `Usage: uptime-status <command> [options]

Commands:
  init [directory]                     Create a site directory (default: ./status-site)
  validate <status.config.json>        Validate JSON structure and semantic rules
  build --site <path> [--snapshot <path>]
                                      Build the static site for one site
  doctor <status.config.json>          Check Bun, config, assets, and environment secrets
  snapshot probe --site <path> --out <path>
                                      Probe a direct HTTPS source and write the first snapshot
  history inspect --site <path> --source <id> --artifact <path>
                  --cutoff <ISO time> --exported <ISO time>
                  --source-version <version> --out <path>
                                      Create a sanitized bundle from an offline Kuma backup
  help                                 Show this help
`;

function option(args: string[], name: string) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a path`);
  return value;
}

function requiredOption(args: string[], name: string) {
  const value = option(args, name);
  if (!value) throw new Error(`history inspect requires ${name} <value>`);
  return value;
}

export async function run(args: string[]) {
  const [command, ...rest] = args;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(HELP);
    return 0;
  }

  if (command === "init") {
    if (rest.length > 1) throw new Error("init accepts at most one directory");
    const destination = initSite(rest[0] ?? "status-site");
    console.log(`Created site template at ${destination}`);
    return 0;
  }

  if (command === "validate") {
    if (rest.length !== 1) throw new Error("validate requires one site configuration path");
    const result = validateSiteFile(resolveExplicitPath(rest[0]));
    if (!result.ok) {
      console.error(formatIssues(result.issues));
      return 1;
    }
    console.log(`Valid site configuration: ${resolveExplicitPath(rest[0])}`);
    return 0;
  }

  if (command === "doctor") {
    if (rest.length !== 1) throw new Error("doctor requires one site configuration path");
    const checks = doctorSite({ sitePath: resolveExplicitPath(rest[0]) });
    for (const check of checks) {
      console.log(`${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.message}`);
    }
    return checks.every((check) => check.ok) ? 0 : 1;
  }

  if (command === "build") {
    const sitePath = option(rest, "--site");
    if (!sitePath) throw new Error("build requires --site <path>");
    const snapshotPath = option(rest, "--snapshot");
    const allowed = new Set(["--site", sitePath, "--snapshot", snapshotPath]);
    const unknown = rest.find((argument) => !allowed.has(argument));
    if (unknown) throw new Error(`unknown build argument: ${unknown}`);
    const output = await buildSite({ sitePath, snapshotPath });
    console.log(`Built static site at ${output}`);
    return 0;
  }

  if (command === "history" && rest[0] === "inspect") {
    const historyArgs = rest.slice(1);
    const names = [
      "--site",
      "--source",
      "--artifact",
      "--cutoff",
      "--exported",
      "--source-version",
      "--out",
    ];
    const values = Object.fromEntries(
      names.map((name) => [name, requiredOption(historyArgs, name)]),
    );
    if (historyArgs.length !== names.length * 2) {
      throw new Error("history inspect accepts only the documented options");
    }
    const result = await inspectHistory({
      sitePath: values["--site"],
      sourceId: values["--source"],
      artifactPath: values["--artifact"],
      cutoffAt: values["--cutoff"],
      exportedAt: values["--exported"],
      sourceVersion: values["--source-version"],
      outputPath: values["--out"],
    });
    console.log(`History bundle written to ${result.outputPath}`);
    console.log(`Import ID: ${result.importId}`);
    console.log(`Artifact SHA-256: ${result.artifactSha256}`);
    console.log(`Components: ${result.componentCount}`);
    console.log(`Daily rows: ${result.dayCount}`);
    console.log("No source credentials or private monitor fields were written to the bundle.");
    return 0;
  }

  if (command === "snapshot" && rest[0] === "probe") {
    const snapshotArgs = rest.slice(1);
    const sitePath = requiredOption(snapshotArgs, "--site");
    const outputPath = requiredOption(snapshotArgs, "--out");
    if (snapshotArgs.length !== 4) {
      throw new Error("snapshot probe accepts only --site <path> and --out <path>");
    }
    const result = await createProbeSnapshot({ sitePath, outputPath });
    console.log(`Snapshot written to ${result.outputPath}`);
    console.log(`Source revision: ${result.snapshot.sourceRevision}`);
    return 0;
  }

  throw new Error(`Unknown command: ${command}`);
}

if (import.meta.main) {
  try {
    process.exitCode = await run(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}

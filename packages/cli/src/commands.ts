import { cpSync, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { SiteConfig } from "@uptime-status/domain";
import { parseAndValidateSite, type ValidationIssue, type ValidationResult } from "./validation";

const packageRoot = resolve(import.meta.dir, "..");
const platformRoot = resolve(packageRoot, "../..");
const templateRoot = resolve(packageRoot, "templates");

function supportedBunVersion() {
  const manifest = JSON.parse(readFileSync(resolve(platformRoot, "package.json"), "utf8")) as {
    packageManager?: string;
  };
  const match = manifest.packageManager?.match(/^bun@(.+)$/);
  if (!match) throw new Error("Root packageManager must pin a Bun version");
  return match[1];
}

export type Check = {
  name: string;
  ok: boolean;
  message: string;
};

export function initSite(destination: string) {
  const target = resolve(destination);
  if (existsSync(target)) throw new Error(`Refusing to overwrite existing path: ${target}`);
  cpSync(templateRoot, target, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  return target;
}

export function validateSiteFile(path: string): ValidationResult {
  const absolute = resolve(path);
  try {
    return parseAndValidateSite(readFileSync(absolute, "utf8"));
  } catch (error) {
    return {
      ok: false,
      issues: [
        {
          kind: "json",
          path: "/",
          message: error instanceof Error ? error.message : `could not read ${absolute}`,
        },
      ],
    };
  }
}

function assetEntries(config: SiteConfig): Array<[string, string]> {
  const assets: Array<[string, string]> = [
    ["brand.logoLightPath", config.brand.logoLightPath],
    ["brand.logoDarkPath", config.brand.logoDarkPath],
    ["brand.iconLightPath", config.brand.iconLightPath],
    ["brand.iconDarkPath", config.brand.iconDarkPath],
    ["brand.faviconPath", config.brand.faviconPath],
  ];
  if (config.subscriptions.enabled && config.subscriptions.templates?.logoPath) {
    assets.push(["subscriptions.templates.logoPath", config.subscriptions.templates.logoPath]);
  }
  if (config.subscriptions.enabled && config.subscriptions.templates?.headerMedia) {
    assets.push([
      "subscriptions.templates.headerMedia.path",
      config.subscriptions.templates.headerMedia.path,
    ]);
  }
  return assets;
}

function environmentSecretEntries(config: SiteConfig): Array<[string, string]> {
  const secrets: Array<[string, string]> = [];
  config.monitoring.sources.forEach((source, index) => {
    if (source.adapter === "uptime-kuma" && source.connection.provider === "environment") {
      secrets.push([`monitoring.sources.${index}.connection`, source.connection.reference]);
    }
  });
  if (
    config.subscriptions.enabled &&
    config.subscriptions.delivery.provider === "smtp" &&
    config.subscriptions.delivery.connection.provider === "environment"
  ) {
    secrets.push([
      "subscriptions.delivery.connection",
      config.subscriptions.delivery.connection.reference,
    ]);
  }
  return secrets;
}

export function doctorSite(options: {
  sitePath: string;
  environment?: Record<string, string | undefined>;
  bunVersion?: string;
  expectedBunVersion?: string;
}): Check[] {
  const checks: Check[] = [];
  const expected = options.expectedBunVersion ?? supportedBunVersion();
  const current = options.bunVersion ?? Bun.version;
  checks.push({
    name: "Bun version",
    ok: current === expected,
    message: current === expected ? current : `expected ${expected}, found ${current}`,
  });

  const result = validateSiteFile(options.sitePath);
  if (!result.ok) {
    checks.push({
      name: "Site configuration",
      ok: false,
      message: formatIssues(result.issues),
    });
    return checks;
  }
  checks.push({ name: "Site configuration", ok: true, message: "valid" });

  const configDirectory = dirname(resolve(options.sitePath));
  for (const [name, relativePath] of assetEntries(result.config)) {
    const path = resolve(configDirectory, relativePath);
    let ok = false;
    try {
      ok = path.startsWith(`${configDirectory}/`) && statSync(path).isFile();
    } catch {
      ok = false;
    }
    checks.push({
      name: `Asset ${name}`,
      ok,
      message: ok ? path : `missing or not a file: ${path}`,
    });
  }

  const environment = options.environment ?? process.env;
  for (const [name, variable] of environmentSecretEntries(result.config)) {
    const present =
      typeof environment[variable] === "string" && environment[variable]?.trim() !== "";
    checks.push({
      name: `Secret ${name}`,
      ok: present,
      message: present ? `${variable} is set` : `${variable} is not set`,
    });
  }
  return checks;
}

export type BuildRunner = (input: {
  command: string[];
  cwd: string;
  environment: Record<string, string | undefined>;
}) => Promise<number>;

const defaultBuildRunner: BuildRunner = async ({ command, cwd, environment }) => {
  const child = Bun.spawn(command, {
    cwd,
    env: environment,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return child.exited;
};

export async function buildSite(
  options: { sitePath: string; snapshotPath?: string },
  runner: BuildRunner = defaultBuildRunner,
) {
  const sitePath = resolve(options.sitePath);
  const validation = validateSiteFile(sitePath);
  if (!validation.ok) throw new Error(formatIssues(validation.issues));
  const snapshotPath = options.snapshotPath ? resolve(options.snapshotPath) : "";
  const code = await runner({
    command: ["bun", "run", "build"],
    cwd: resolve(platformRoot, "apps/web"),
    environment: {
      ...process.env,
      STATUS_SITE_CONFIG: sitePath,
      STATUS_SNAPSHOT_PATH: snapshotPath,
    },
  });
  if (code !== 0) throw new Error(`Web build failed with exit code ${code}`);
  return resolve(platformRoot, "apps/web/dist");
}

export function formatIssues(issues: ValidationIssue[]) {
  return issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n");
}

export function resolveExplicitPath(value: string) {
  return isAbsolute(value) ? value : resolve(value);
}

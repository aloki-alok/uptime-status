import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  createStatusFixture,
  type SiteConfig,
  type StatusSnapshot,
  validateSiteConfig,
  validateStatusSnapshot,
} from "@uptime-status/domain";

const defaultSitePath = resolve(process.cwd(), "../../examples/status.config.json");

function selectedPath(environmentName: string, fallback?: string) {
  const configured = process.env[environmentName];
  if (!configured) {
    if (fallback) return fallback;
    throw new Error(`${environmentName} is required for this deployment`);
  }
  return isAbsolute(configured) ? configured : resolve(process.cwd(), configured);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

const sitePath = selectedPath("STATUS_SITE_CONFIG", defaultSitePath);
const siteInput = readJson(sitePath);

if (!validateSiteConfig(siteInput)) {
  throw new Error(`Invalid site configuration: ${sitePath}`);
}

export const site: SiteConfig = siteInput;

function loadSnapshot(): StatusSnapshot {
  const snapshotPath = process.env.STATUS_SNAPSHOT_PATH;
  if (!snapshotPath) {
    if (site.deploymentMode !== "example") {
      throw new Error("STATUS_SNAPSHOT_PATH is required for a production deployment");
    }
    return createStatusFixture({ site });
  }

  const input = readJson(selectedPath("STATUS_SNAPSHOT_PATH"));
  if (!validateStatusSnapshot(input)) {
    throw new Error(`Invalid status snapshot: ${snapshotPath}`);
  }

  const expected = site.components.map((component) => component.componentId).sort();
  const actual = input.components.map((component) => component.slug).sort();
  if (expected.length !== actual.length || expected.some((slug, index) => slug !== actual[index])) {
    throw new Error("Status snapshot components do not match the selected site");
  }

  return input;
}

export const snapshot = loadSnapshot();

export function siteAssetPath(relativePath: string) {
  const root = dirname(sitePath);
  const absolute = resolve(root, relativePath);
  if (absolute === root || !absolute.startsWith(`${root}/`)) {
    throw new Error("Site asset path escapes the site directory");
  }
  return absolute;
}

export function siteVariant() {
  const selected = site.presentation.bannerVariant ?? "classic";
  return { classic: "ledger", compact: "signal", plain: "brief" }[selected] as
    | "ledger"
    | "signal"
    | "brief";
}

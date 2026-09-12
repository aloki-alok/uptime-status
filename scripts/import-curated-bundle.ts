import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { CuratedStore } from "../apps/monitor/src/curated";
import {
  type Incident,
  type Maintenance,
  type SiteConfig,
  validateIncident,
  validateMaintenance,
  validateSiteConfig,
} from "../packages/status-contract/src/index";

type Bundle = {
  schemaVersion: "1.0.0";
  incidents: Incident[];
  maintenances: Maintenance[];
};

function option(name: string) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name}`);
  return resolve(process.argv[index + 1]);
}

async function main() {
  const siteInput: unknown = await Bun.file(option("--site")).json();
  if (!validateSiteConfig(siteInput)) throw new Error("Site configuration is invalid");
  const site = siteInput as SiteConfig;
  const bundleInput: unknown = await Bun.file(option("--bundle")).json();
  if (
    !bundleInput ||
    typeof bundleInput !== "object" ||
    !Array.isArray((bundleInput as Bundle).incidents) ||
    !Array.isArray((bundleInput as Bundle).maintenances) ||
    (bundleInput as Bundle).schemaVersion !== "1.0.0"
  ) {
    throw new Error("Curated bundle is invalid");
  }
  const bundle = bundleInput as Bundle;
  const slugs = new Set(site.components.map((component) => component.componentId));
  for (const incident of bundle.incidents) {
    if (!validateIncident(incident, slugs, false) || incident.state !== "resolved") {
      throw new Error(`Historical incident is invalid: ${incident.slug}`);
    }
  }
  for (const maintenance of bundle.maintenances) {
    if (!validateMaintenance(maintenance, slugs) || maintenance.state !== "completed") {
      throw new Error(`Historical maintenance is invalid: ${maintenance.slug}`);
    }
  }
  const keys = [
    ...bundle.incidents.map((event) => `incident:${event.slug}`),
    ...bundle.maintenances.map((event) => `maintenance:${event.slug}`),
  ];
  if (new Set(keys).size !== keys.length) throw new Error("Curated bundle has duplicate slugs");

  const databasePath = option("--database");
  if (!existsSync(databasePath)) throw new Error("Destination database does not exist");
  const apply = process.argv.includes("--apply");
  const db = new Database(databasePath, { readonly: !apply });
  try {
    const events = [
      ...bundle.incidents.map((event) => ({ kind: "incident" as const, event })),
      ...bundle.maintenances.map((event) => ({ kind: "maintenance" as const, event })),
    ];
    for (const { kind, event } of events) {
      const existing = db
        .query("SELECT 1 FROM curated_events WHERE kind = ? AND slug = ?")
        .get(kind, event.slug);
      if (existing) throw new Error(`${kind} ${event.slug} already exists`);
      console.log(`${kind}\t${event.slug}\t${event.title}`);
    }
    if (!apply) {
      console.log(`Dry run: ${events.length} historical notices. Pass --apply to write.`);
      return;
    }
    const store = new CuratedStore(db, site);
    db.transaction(() => {
      for (const { kind, event } of events) {
        store.save(kind, event, null, "legacy-import", "import");
      }
    })();
    console.log(`Imported ${events.length} historical notices.`);
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

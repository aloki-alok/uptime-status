import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateHistoryImportBundle } from "@uptime-status/domain";
import {
  applyHistoryImport,
  type ExistingHistoryRecord,
  HistoryExtractorRegistry,
  HistoryImportInspector,
  previewHistoryImport,
  rollbackHistoryImport,
  SqliteHistoryDestination,
  UptimeKumaSqliteExtractor,
  verifyAppliedHistoryImport,
} from "@uptime-status/history-import";
import { formatIssues, validateSiteFile } from "./commands";

export type HistoryInspectOptions = {
  sitePath: string;
  sourceId: string;
  artifactPath: string;
  cutoffAt: string;
  exportedAt: string;
  sourceVersion: string;
  outputPath: string;
};

/**
 * A manual CLI-driven import has no CI/CD pipeline revision to bind to, so this stands in for
 * one. apply/verify/rollback must be given the same value (the default, or a matching
 * --platform-revision) or the plan they rebuild will not match what an earlier command applied.
 */
export const DEFAULT_HISTORY_PLATFORM_REVISION = "cli-manual-import";

export type HistoryExecutionOptions = {
  sitePath: string;
  bundlePath: string;
  databasePath: string;
  platformRevision?: string;
};

async function prepareHistoryImport(options: HistoryExecutionOptions) {
  const sitePath = resolve(options.sitePath);
  const bundlePath = resolve(options.bundlePath);
  const databasePath = resolve(options.databasePath);

  const validation = validateSiteFile(sitePath);
  if (!validation.ok) throw new Error(formatIssues(validation.issues));

  const bundleBytes = readFileSync(bundlePath);
  const bundleSha256 = createHash("sha256").update(bundleBytes).digest("hex");
  const bundle: unknown = JSON.parse(bundleBytes.toString("utf8"));
  if (!validateHistoryImportBundle(bundle)) {
    throw new Error(`Not a valid history import bundle: ${bundlePath}`);
  }

  const destination = await SqliteHistoryDestination.open(databasePath, validation.config.siteId);
  // previewHistoryImport drops this import's own rows, so a re-preview for verify or
  // rollback does not see the import colliding with itself.
  const existing = await destination.listExisting(validation.config.siteId, bundle.source.sourceId);
  const plan = previewHistoryImport({
    bundle,
    bundleSha256,
    platformRevision: options.platformRevision ?? DEFAULT_HISTORY_PLATFORM_REVISION,
    destination: { adapterId: destination.adapterId, destinationId: destination.destinationId },
    // Deterministic across separate CLI invocations of apply/verify/rollback: derived from the
    // bundle itself rather than "now", so rebuilding the plan later yields the same plan ID.
    createdAt: bundle.extraction.exportedAt,
    existing,
  });
  return { destination, bundle, bundleSha256, plan };
}

export type HistoryApplyResult = {
  importId: string;
  componentCount: number;
  dailyRecordCount: number;
  noOp: boolean;
};

export async function applyHistoryImportCommand(
  options: HistoryExecutionOptions,
): Promise<HistoryApplyResult> {
  const { destination, bundle, bundleSha256, plan } = await prepareHistoryImport(options);
  const receipt = await applyHistoryImport({
    plan,
    bundle,
    bundleSha256,
    destination,
    completedAt: new Date().toISOString(),
  });
  return {
    importId: plan.importId,
    componentCount: plan.summary.componentCount,
    dailyRecordCount: receipt.dailyRecordCount,
    noOp: receipt.noOp,
  };
}

export type HistoryVerifyResult = {
  importId: string;
  dailyRecordCount: number;
};

export async function verifyHistoryImportCommand(
  options: HistoryExecutionOptions,
): Promise<HistoryVerifyResult> {
  const { destination, bundle, bundleSha256, plan } = await prepareHistoryImport(options);
  const receipt = await verifyAppliedHistoryImport({
    plan,
    bundle,
    bundleSha256,
    destination,
    completedAt: new Date().toISOString(),
  });
  return {
    importId: plan.importId,
    dailyRecordCount: receipt.dailyRecordCount,
  };
}

export type HistoryRollbackOptions = HistoryExecutionOptions & { confirm: boolean };

export type HistoryRollbackResult = {
  importId: string;
  dailyRecordCount: number;
  noOp: boolean;
  applied: boolean;
};

export async function rollbackHistoryImportCommand(
  options: HistoryRollbackOptions,
): Promise<HistoryRollbackResult> {
  const { destination, bundle, bundleSha256, plan } = await prepareHistoryImport(options);

  if (!options.confirm) {
    const state = await destination.inspect(plan);
    return {
      importId: plan.importId,
      dailyRecordCount: state.dailyRecordCount,
      noOp: !state.active,
      applied: false,
    };
  }

  const receipt = await rollbackHistoryImport({
    plan,
    bundle,
    bundleSha256,
    destination,
    completedAt: new Date().toISOString(),
  });
  return {
    importId: plan.importId,
    dailyRecordCount: receipt.deletedDailyRecordCount,
    noOp: receipt.noOp,
    applied: true,
  };
}

function topologyRevision(
  components: Array<{ componentId: string; sourceId: string; monitorRef: string }>,
) {
  const topology = components
    .map(({ componentId, sourceId, monitorRef }) => ({ componentId, sourceId, monitorRef }))
    .sort((first, second) => first.componentId.localeCompare(second.componentId));
  return `topology:${createHash("sha256").update(JSON.stringify(topology)).digest("hex")}`;
}

async function sha256File(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function inspectHistory(options: HistoryInspectOptions) {
  const sitePath = resolve(options.sitePath);
  const artifactPath = resolve(options.artifactPath);
  const outputPath = resolve(options.outputPath);
  if (existsSync(outputPath)) throw new Error(`Refusing to overwrite existing path: ${outputPath}`);

  const validation = validateSiteFile(sitePath);
  if (!validation.ok) throw new Error(formatIssues(validation.issues));
  const source = validation.config.monitoring.sources.find(
    (candidate) => candidate.sourceId === options.sourceId,
  );
  if (!source) throw new Error(`Monitoring source is not configured: ${options.sourceId}`);
  if (source.adapter !== "uptime-kuma") {
    throw new Error(`Monitoring source is not an Uptime Kuma source: ${options.sourceId}`);
  }

  const components = validation.config.components.filter(
    (component) => component.sourceId === options.sourceId,
  );
  if (components.length === 0) {
    throw new Error(`Monitoring source has no configured components: ${options.sourceId}`);
  }
  const artifactSha256 = await sha256File(artifactPath);
  const inspector = new HistoryImportInspector(
    new HistoryExtractorRegistry([new UptimeKumaSqliteExtractor()]),
  );
  const bundle = await inspector.inspect("uptime-kuma-sqlite", {
    siteId: validation.config.siteId,
    topologyRevision: topologyRevision(components),
    source: {
      systemId: "uptime-kuma",
      sourceId: options.sourceId,
      systemVersion: options.sourceVersion,
      schemaVersion: "kuma-2.2.0",
    },
    artifact: {
      kind: "sqlite-backup",
      path: artifactPath,
      sha256: artifactSha256,
      cutoffAt: options.cutoffAt,
      exportedAt: options.exportedAt,
      sourceTimeZone: "UTC",
    },
    mappings: components.map((component) => ({
      componentId: component.componentId,
      entityType: "monitor",
      externalId: component.monitorRef,
    })),
  });
  writeFileSync(outputPath, `${JSON.stringify(bundle, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return {
    outputPath,
    importId: bundle.importId,
    artifactSha256,
    componentCount: bundle.components.length,
    dayCount: bundle.components.reduce((total, component) => total + component.history.length, 0),
  };
}

import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SiteConfig } from "@uptime-status/domain";
import {
  type ProbePublisherDependencies,
  publishProbeSnapshot,
} from "@uptime-status/snapshot/publisher";
import { formatIssues, validateSiteFile } from "./commands";

type SnapshotProbeOptions = {
  sitePath: string;
  outputPath: string;
  fetch?: NonNullable<ProbePublisherDependencies["fetch"]>;
  now?: NonNullable<ProbePublisherDependencies["now"]>;
};

function directProbe(config: SiteConfig) {
  if (config.monitoring.sources.length !== 1 || config.components.length !== 1) {
    throw new Error("Direct snapshot probing requires exactly one source and one component");
  }
  const source = config.monitoring.sources[0];
  const component = config.components[0];
  if (source.adapter !== "https" || component.sourceId !== source.sourceId) {
    throw new Error("Direct snapshot probing requires one bound HTTPS source");
  }

  return {
    slug: component.componentId,
    name: component.name,
    group: component.group,
    url: source.url,
    timeoutMs: source.timeoutMs,
    showLatency: component.showLatency,
  };
}

export async function createProbeSnapshot(options: SnapshotProbeOptions) {
  const sitePath = resolve(options.sitePath);
  const outputPath = resolve(options.outputPath);
  if (existsSync(outputPath)) throw new Error(`Refusing to overwrite existing path: ${outputPath}`);

  const validation = validateSiteFile(sitePath);
  if (!validation.ok) throw new Error(formatIssues(validation.issues));
  let serialized = "";
  const result = await publishProbeSnapshot(directProbe(validation.config), {
    readCurrent: async () => null,
    publish: async (snapshot) => {
      serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
    },
    fetch: options.fetch,
    now: options.now,
  });
  if (result.kind !== "published" || serialized === "") {
    throw new Error("The first direct probe did not produce a snapshot");
  }
  writeFileSync(outputPath, serialized, { flag: "wx", mode: 0o600 });
  return { outputPath, snapshot: result.snapshot };
}

export type HistorySource = {
  systemId: string;
  sourceId: string;
  systemVersion?: string;
  schemaVersion?: string;
};

export type HistoryArtifact = {
  kind: string;
  path: string;
  sha256: string;
  cutoffAt: string;
  exportedAt: string;
  sourceTimeZone: string;
};

export type HistoryMapping = {
  componentId: string;
  entityType: string;
  externalId: string;
};

export type HistoryExtractionRequest = {
  siteId: string;
  topologyRevision: string;
  source: HistorySource;
  artifact: HistoryArtifact;
  mappings: HistoryMapping[];
  options?: unknown;
};

const SLUG = /^[a-z0-9-]+$/;
const REVISION = /^[A-Za-z0-9._:-]+$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ISO_DATE_TIME =
  /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).every((key) => keys.includes(key));
}

function validText(value: unknown, maximum: number, pattern?: RegExp): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length > 0 &&
    value.length <= maximum &&
    !value.includes("\0") &&
    (!pattern || pattern.test(value))
  );
}

function validInstant(value: unknown): value is string {
  return typeof value === "string" && ISO_DATE_TIME.test(value) && !Number.isNaN(Date.parse(value));
}

export function validateHistoryExtractionRequest(
  input: unknown,
): input is HistoryExtractionRequest {
  if (
    !isRecord(input) ||
    !onlyKeys(input, ["siteId", "topologyRevision", "source", "artifact", "mappings", "options"]) ||
    !validText(input.siteId, 80, SLUG) ||
    !validText(input.topologyRevision, 128, REVISION) ||
    !isRecord(input.source) ||
    !onlyKeys(input.source, ["systemId", "sourceId", "systemVersion", "schemaVersion"]) ||
    !validText(input.source.systemId, 80, SLUG) ||
    !validText(input.source.sourceId, 80, SLUG) ||
    (input.source.systemVersion !== undefined && !validText(input.source.systemVersion, 80)) ||
    (input.source.schemaVersion !== undefined && !validText(input.source.schemaVersion, 80)) ||
    !isRecord(input.artifact) ||
    !onlyKeys(input.artifact, [
      "kind",
      "path",
      "sha256",
      "cutoffAt",
      "exportedAt",
      "sourceTimeZone",
    ]) ||
    !validText(input.artifact.kind, 80, SLUG) ||
    !validText(input.artifact.path, 4096) ||
    !input.artifact.path.startsWith("/") ||
    typeof input.artifact.sha256 !== "string" ||
    !SHA256.test(input.artifact.sha256) ||
    !validInstant(input.artifact.cutoffAt) ||
    !validInstant(input.artifact.exportedAt) ||
    Date.parse(input.artifact.exportedAt) < Date.parse(input.artifact.cutoffAt) ||
    !validText(input.artifact.sourceTimeZone, 80) ||
    !Array.isArray(input.mappings) ||
    input.mappings.length < 1 ||
    input.mappings.length > 200
  ) {
    return false;
  }

  try {
    new Intl.DateTimeFormat("en", { timeZone: input.artifact.sourceTimeZone });
  } catch {
    return false;
  }

  const componentIds = new Set<string>();
  const sourceBindings = new Set<string>();
  for (const mapping of input.mappings) {
    if (
      !isRecord(mapping) ||
      !onlyKeys(mapping, ["componentId", "entityType", "externalId"]) ||
      !validText(mapping.componentId, 80, SLUG) ||
      !validText(mapping.entityType, 80, SLUG) ||
      !validText(mapping.externalId, 160)
    ) {
      return false;
    }
    const binding = `${mapping.entityType}\u0000${mapping.externalId}`;
    if (componentIds.has(mapping.componentId) || sourceBindings.has(binding)) return false;
    componentIds.add(mapping.componentId);
    sourceBindings.add(binding);
  }
  return true;
}

export function assertHistoryExtractionRequest(
  input: unknown,
): asserts input is HistoryExtractionRequest {
  if (!validateHistoryExtractionRequest(input)) {
    throw new Error("History extraction request is invalid");
  }
}

export function immutableRequest(request: HistoryExtractionRequest): HistoryExtractionRequest {
  const clone = structuredClone(request);
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  };
  freeze(clone);
  return clone;
}

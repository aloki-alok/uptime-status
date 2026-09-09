import { type HistoryImportBundle, validateHistoryImportBundle } from "@uptime-status/domain";
import {
  assertHistoryExtractionRequest,
  type HistoryExtractionRequest,
  immutableRequest,
} from "./request";

export interface HistoryExtractor {
  readonly id: string;
  readonly version: string;
  extract(request: HistoryExtractionRequest): Promise<unknown>;
}

function mappingSignatures(request: HistoryExtractionRequest) {
  return request.mappings
    .map(
      (mapping) =>
        `${mapping.componentId}\u0000${request.source.sourceId}\u0000${mapping.entityType}\u0000${mapping.externalId}`,
    )
    .sort();
}

function bundleMappingSignatures(bundle: HistoryImportBundle) {
  return bundle.components
    .map(
      (component) =>
        `${component.componentId}\u0000${component.sourceBinding.sourceId}\u0000${component.sourceBinding.entityType}\u0000${component.sourceBinding.externalId}`,
    )
    .sort();
}

function assertBoundaries(
  extractor: HistoryExtractor,
  request: HistoryExtractionRequest,
  bundle: HistoryImportBundle,
) {
  const requestedMappings = mappingSignatures(request);
  const extractedMappings = bundleMappingSignatures(bundle);
  const valid =
    bundle.siteId === request.siteId &&
    bundle.topologyRevision === request.topologyRevision &&
    bundle.source.systemId === request.source.systemId &&
    bundle.source.sourceId === request.source.sourceId &&
    bundle.source.systemVersion === request.source.systemVersion &&
    bundle.source.schemaVersion === request.source.schemaVersion &&
    bundle.extraction.adapterId === extractor.id &&
    bundle.extraction.adapterVersion === extractor.version &&
    bundle.extraction.artifactKind === request.artifact.kind &&
    bundle.extraction.artifactSha256 === request.artifact.sha256 &&
    bundle.extraction.cutoffAt === request.artifact.cutoffAt &&
    bundle.extraction.exportedAt === request.artifact.exportedAt &&
    bundle.extraction.sourceTimeZone === request.artifact.sourceTimeZone &&
    requestedMappings.length === extractedMappings.length &&
    requestedMappings.every((mapping, index) => mapping === extractedMappings[index]);

  if (!valid) throw new Error("History extractor changed an immutable import boundary");
}

export class HistoryExtractorRegistry {
  readonly #extractors = new Map<string, HistoryExtractor>();

  constructor(extractors: HistoryExtractor[]) {
    for (const extractor of extractors) {
      if (this.#extractors.has(extractor.id)) {
        throw new Error(`Duplicate history extractor: ${extractor.id}`);
      }
      this.#extractors.set(extractor.id, extractor);
    }
  }

  ids() {
    return [...this.#extractors.keys()].sort();
  }

  async extract(id: string, request: HistoryExtractionRequest): Promise<HistoryImportBundle> {
    assertHistoryExtractionRequest(request);
    const boundary = structuredClone(request);
    const extractor = this.#extractors.get(id);
    if (!extractor) throw new Error(`History extractor is not installed: ${id}`);

    const output = await extractor.extract(immutableRequest(request));
    if (!validateHistoryImportBundle(output)) {
      throw new Error(`History extractor returned an invalid bundle: ${id}`);
    }
    assertBoundaries(extractor, boundary, output);
    return output;
  }
}

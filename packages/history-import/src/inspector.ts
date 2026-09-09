import type { HistoryImportBundle } from "@uptime-status/domain";
import { sameVerifiedArtifact, verifyHistoryArtifact } from "./artifact";
import type { HistoryExtractorRegistry } from "./registry";
import type { HistoryExtractionRequest } from "./request";

export class HistoryImportInspector {
  constructor(private readonly registry: HistoryExtractorRegistry) {}

  async inspect(
    adapterId: string,
    request: HistoryExtractionRequest,
  ): Promise<HistoryImportBundle> {
    const before = await verifyHistoryArtifact(request.artifact);
    const verifiedRequest: HistoryExtractionRequest = {
      ...structuredClone(request),
      artifact: {
        ...request.artifact,
        path: before.path,
        sha256: before.sha256,
      },
    };
    const bundle = await this.registry.extract(adapterId, verifiedRequest);
    const after = await verifyHistoryArtifact(verifiedRequest.artifact);
    if (!sameVerifiedArtifact(before, after)) {
      throw new Error("History artifact changed during extraction");
    }
    return bundle;
  }
}

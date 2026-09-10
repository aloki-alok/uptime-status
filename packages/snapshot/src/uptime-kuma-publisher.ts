import {
  deriveOverallStatus,
  type SiteConfig,
  type StatusSnapshot,
  validateStatusSnapshot,
} from "@uptime-status/domain";
import {
  type UptimeKumaExport,
  validateUptimeKumaExport,
} from "@uptime-status/domain/uptime-kuma-export";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_FUTURE_SKEW_MS = 60_000;
const EXPORT_PATH = /^\/api\/status-export\/v1\/[a-z0-9][a-z0-9-]{0,63}$/;

type HttpFetcher = (url: string, init: RequestInit) => Promise<Response>;

export type UptimeKumaPublisherConfig = {
  site: SiteConfig;
  sourceId: string;
  endpointUrl: string;
  authorization: string;
  timeoutMs?: number;
};

export type UptimeKumaPublisherDependencies = {
  readCurrent: () => Promise<unknown | null>;
  publish: (snapshot: StatusSnapshot) => Promise<void>;
  fetch?: HttpFetcher;
  now?: () => Date;
};

export type UptimeKumaPublisherResult =
  | { kind: "published"; snapshot: StatusSnapshot }
  | {
      kind: "retained";
      snapshot: StatusSnapshot;
      reason: "source-unavailable" | "non-monotonic-export";
    };

export class NoLastKnownGoodKumaSnapshotError extends Error {
  constructor(options?: ErrorOptions) {
    super("The Uptime Kuma export failed and no last-known-good snapshot is available", options);
    this.name = "NoLastKnownGoodKumaSnapshotError";
  }
}

export class UptimeKumaMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UptimeKumaMappingError";
  }
}

function configuredComponents(config: UptimeKumaPublisherConfig) {
  const source = config.site.monitoring.sources.find((item) => item.sourceId === config.sourceId);
  if (source?.adapter !== "uptime-kuma") {
    throw new UptimeKumaMappingError("The selected source is not an Uptime Kuma source");
  }
  const foreign = config.site.components.find(
    (component) => component.sourceId !== config.sourceId,
  );
  if (foreign) {
    throw new UptimeKumaMappingError(
      "One Uptime Kuma export must map every component in the published snapshot",
    );
  }
  return config.site.components;
}

function assertConnection(config: UptimeKumaPublisherConfig) {
  const url = new URL(config.endpointUrl);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !EXPORT_PATH.test(url.pathname)
  ) {
    throw new TypeError("The Uptime Kuma export endpoint must be a private versioned HTTPS URL");
  }
  if (
    !/^Bearer [!-~]{32,}$/.test(config.authorization) ||
    config.authorization.length > 2048 ||
    config.authorization !== config.authorization.trim() ||
    /[\r\n]/.test(config.authorization)
  ) {
    throw new TypeError("The Uptime Kuma export authorization value is invalid");
  }
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new TypeError("The Uptime Kuma export timeout must be an integer from 100 to 60000");
  }
}

function checkedNow(now: () => Date) {
  const value = now();
  if (!Number.isFinite(value.getTime())) throw new TypeError("The publisher clock is invalid");
  return value;
}

async function boundedBody(response: Response) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let result = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) return result + decoder.decode();
    total += chunk.value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("The Uptime Kuma export is too large");
    }
    result += decoder.decode(chunk.value, { stream: true });
  }
}

function currentSnapshot(value: unknown | null, site: SiteConfig) {
  if (value === null) return null;
  if (!validateStatusSnapshot(value)) {
    throw new TypeError("The stored last-known-good snapshot is invalid");
  }
  const expected = site.components.map((component) => component.componentId).sort();
  const actual = value.components.map((component) => component.slug).sort();
  if (
    expected.length !== actual.length ||
    expected.some((componentId, index) => componentId !== actual[index])
  ) {
    throw new UptimeKumaMappingError(
      "The last-known-good snapshot does not match the configured component topology",
    );
  }
  return value;
}

async function readExport(
  config: UptimeKumaPublisherConfig,
  expectedComponentIds: readonly string[],
  fetcher: HttpFetcher,
  now: () => Date,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetcher(config.endpointUrl, {
      cache: "no-store",
      headers: {
        accept: "application/json",
        authorization: config.authorization,
      },
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
    });
    const receivedAt = checkedNow(now);
    const headerDate = Date.parse(response.headers.get("date") ?? "");
    const responseAt = Number.isFinite(headerDate) ? new Date(headerDate) : receivedAt;
    if (!response.ok) throw new Error("The Uptime Kuma export returned a non-success response");
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
      throw new Error("The Uptime Kuma export is too large");
    }
    const body = await boundedBody(response);
    const input: unknown = JSON.parse(body);
    if (!(await validateUptimeKumaExport(input, expectedComponentIds))) {
      throw new Error("The Uptime Kuma export failed validation");
    }
    const source = input as UptimeKumaExport;
    if (Date.parse(source.generatedAt) > responseAt.getTime() + MAX_FUTURE_SKEW_MS) {
      throw new Error("The Uptime Kuma export time is in the future");
    }
    return { source, responseAt };
  } finally {
    clearTimeout(timeout);
  }
}

function mapSnapshot(
  source: UptimeKumaExport,
  config: UptimeKumaPublisherConfig,
  responseAt: Date,
  previous: StatusSnapshot | null,
) {
  const exported = new Map(
    source.components.map((component) => [component.componentId, component]),
  );
  const components = config.site.components.map((configured) => {
    const component = exported.get(configured.componentId);
    if (!component) throw new UptimeKumaMappingError("The export component mapping is incomplete");
    return {
      slug: configured.componentId,
      name: configured.name,
      group: configured.group,
      state: component.state,
      latestObservedAt: component.latestCheckAt,
      responseTimeMs: component.responseTimeMs,
      latency: configured.showLatency ? component.latency : null,
      history: component.history,
    };
  });
  const activeIncidents = previous?.activeIncidents ?? [];
  const fresh =
    responseAt.getTime() - Date.parse(source.latestCheckAt) <=
    config.site.monitoring.staleAfterSeconds * 1000;
  const snapshot: StatusSnapshot = {
    schemaVersion: "1.0.0",
    generatedAt: source.generatedAt,
    latestCheckAt: source.latestCheckAt,
    sourceRevision: source.sourceRevision,
    overallStatus: deriveOverallStatus({
      isFresh: fresh,
      componentStates: components.map((component) => component.state),
      activeIncidents,
    }),
    components,
    activeIncidents,
    scheduledMaintenance: previous?.scheduledMaintenance ?? [],
    recentEvents: previous?.recentEvents ?? [],
  };
  if (!validateStatusSnapshot(snapshot)) {
    throw new TypeError("The mapped Uptime Kuma snapshot failed contract validation");
  }
  return snapshot;
}

export async function publishUptimeKumaSnapshot(
  config: UptimeKumaPublisherConfig,
  dependencies: UptimeKumaPublisherDependencies,
): Promise<UptimeKumaPublisherResult> {
  assertConnection(config);
  const configured = configuredComponents(config);
  const previous = currentSnapshot(await dependencies.readCurrent(), config.site);
  const now = dependencies.now ?? (() => new Date());

  let result: Awaited<ReturnType<typeof readExport>>;
  try {
    result = await readExport(
      config,
      configured.map((component) => component.componentId),
      dependencies.fetch ?? ((url, init) => globalThis.fetch(url, init)),
      now,
    );
  } catch (cause) {
    if (previous) {
      return { kind: "retained", snapshot: previous, reason: "source-unavailable" };
    }
    throw new NoLastKnownGoodKumaSnapshotError({ cause });
  }

  if (previous && Date.parse(result.source.generatedAt) <= Date.parse(previous.generatedAt)) {
    return { kind: "retained", snapshot: previous, reason: "non-monotonic-export" };
  }
  let snapshot: StatusSnapshot;
  try {
    snapshot = mapSnapshot(result.source, config, result.responseAt, previous);
  } catch (cause) {
    if (previous) {
      return { kind: "retained", snapshot: previous, reason: "source-unavailable" };
    }
    throw new NoLastKnownGoodKumaSnapshotError({ cause });
  }
  await dependencies.publish(snapshot);
  return { kind: "published", snapshot };
}

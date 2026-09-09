import {
  deriveOverallStatus,
  type StatusSnapshot,
  type StatusState,
  validateStatusSnapshot,
} from "@uptime-status/domain/snapshot";

const DAY_MS = 86_400_000;
const HISTORY_DAYS = 90;
const DEFAULT_TIMEOUT_MS = 10_000;
const COMPONENT_SLUG = /^[a-z0-9-]+$/;

export type ProbeComponent = {
  slug: string;
  name: string;
  group: string;
  url: string;
  timeoutMs?: number;
  showLatency?: boolean;
};

type HttpFetcher = (url: string, init: RequestInit) => Promise<Response>;

export type ProbePublisherDependencies = {
  readCurrent: () => Promise<unknown | null>;
  publish: (snapshot: StatusSnapshot) => Promise<void>;
  fetch?: HttpFetcher;
  now?: () => Date;
};

export type ProbePublisherResult =
  | {
      kind: "published";
      snapshot: StatusSnapshot;
      statusCode: number;
    }
  | {
      kind: "retained";
      snapshot: StatusSnapshot;
      reason: "probe-unavailable" | "non-monotonic-observation";
    };

export class NoLastKnownGoodSnapshotError extends Error {
  constructor(options?: ErrorOptions) {
    super("The HTTPS probe failed and no last-known-good snapshot is available", options);
    this.name = "NoLastKnownGoodSnapshotError";
  }
}

export class SnapshotTopologyError extends Error {
  constructor() {
    super("The last-known-good snapshot does not match the configured component");
    this.name = "SnapshotTopologyError";
  }
}

function assertComponent(component: ProbeComponent) {
  if (
    !COMPONENT_SLUG.test(component.slug) ||
    component.slug.length > 80 ||
    component.name.length < 1 ||
    component.name.length > 120 ||
    component.name !== component.name.trim() ||
    component.group.length < 1 ||
    component.group.length > 120 ||
    component.group !== component.group.trim()
  ) {
    throw new TypeError("The probe component configuration is invalid");
  }

  const url = new URL(component.url);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new TypeError("The probe URL must be HTTPS and contain no credentials or fragment");
  }

  const timeoutMs = component.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new TypeError("The probe timeout must be an integer from 100 to 60000 milliseconds");
  }
}

function checkedNow(now: () => Date) {
  const value = now();
  if (!Number.isFinite(value.getTime())) throw new TypeError("The publisher clock is invalid");
  return value;
}

function dateAtUtcOffset(endDate: string, offset: number) {
  const midnight = Date.parse(`${endDate}T00:00:00.000Z`);
  return new Date(midnight + offset * DAY_MS).toISOString().slice(0, 10);
}

function dailyObservation(date: string, state: StatusState) {
  return {
    date,
    state,
    severity: state === "operational" ? ("none" as const) : ("major" as const),
    // One point-in-time probe cannot establish a daily uptime percentage or outage duration.
    uptime: null,
    downMinutes: 0,
    avgMs: null,
  };
}

function createHistory(observedAt: string, state: StatusState, current: StatusSnapshot | null) {
  const endDate = observedAt.slice(0, 10);
  const previousDays = new Map(
    current?.components[0]?.history.map((day) => [day.date, day] as const) ?? [],
  );

  return Array.from({ length: HISTORY_DAYS }, (_, index) => {
    const date = dateAtUtcOffset(endDate, index - (HISTORY_DAYS - 1));
    if (date === endDate) {
      const existing = previousDays.get(date);
      if (existing && existing.state !== "unknown" && state === "operational") return existing;
      return dailyObservation(date, state);
    }

    return (
      previousDays.get(date) ?? {
        date,
        state: "unknown" as const,
        severity: "unknown" as const,
        uptime: null,
        downMinutes: 0,
        avgMs: null,
      }
    );
  });
}

function sourceRevision(observedAt: string, statusCode: number) {
  return `probe-${observedAt.replace(/[^0-9]/g, "")}-${statusCode}`;
}

function latencyHistory(
  observedAt: string,
  responseTimeMs: number,
  current: StatusSnapshot | null,
  enabled: boolean,
) {
  if (!enabled) return null;

  const bucketTime = Math.floor(Date.parse(observedAt) / 60_000) * 60_000;
  const bucketAt = new Date(bucketTime).toISOString();
  const cutoff = bucketTime - 59 * 60_000;
  const previous = (current?.components[0]?.latency ?? []).filter(
    (point) => Date.parse(point.observedAt) >= cutoff && Date.parse(point.observedAt) <= bucketTime,
  );
  const point = { observedAt: bucketAt, avgMs: responseTimeMs, p95Ms: responseTimeMs };

  if (previous.at(-1)?.observedAt === bucketAt) {
    return [...previous.slice(0, -1), point];
  }
  return [...previous, point];
}

function currentSnapshot(value: unknown | null, component: ProbeComponent) {
  if (value === null) return null;
  if (!validateStatusSnapshot(value)) {
    throw new TypeError("The stored last-known-good snapshot is invalid");
  }
  if (value.components.length !== 1 || value.components[0]?.slug !== component.slug) {
    throw new SnapshotTopologyError();
  }
  return value;
}

async function probe(component: ProbeComponent, fetcher: HttpFetcher, now: () => Date) {
  const startedAt = checkedNow(now).getTime();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), component.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetcher(component.url, {
      cache: "no-store",
      headers: { accept: "application/json, text/plain;q=0.9, */*;q=0.1" },
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
    });
    const completedAt = checkedNow(now);
    const responseTimeMs = Math.max(0, Math.round(completedAt.getTime() - startedAt));
    try {
      await response.body?.cancel();
    } catch {
      // Releasing a response body must not turn a completed probe into missing data.
    }
    return { completedAt, responseTimeMs, statusCode: response.status, healthy: response.ok };
  } finally {
    clearTimeout(timeout);
  }
}

export async function publishProbeSnapshot(
  component: ProbeComponent,
  dependencies: ProbePublisherDependencies,
): Promise<ProbePublisherResult> {
  assertComponent(component);
  const previous = currentSnapshot(await dependencies.readCurrent(), component);
  const now = dependencies.now ?? (() => new Date());

  let observation: Awaited<ReturnType<typeof probe>>;
  try {
    const fetcher = dependencies.fetch ?? ((url, init) => globalThis.fetch(url, init));
    observation = await probe(component, fetcher, now);
  } catch (cause) {
    if (previous) {
      return { kind: "retained", snapshot: previous, reason: "probe-unavailable" };
    }
    throw new NoLastKnownGoodSnapshotError({ cause });
  }

  const observedAt = observation.completedAt.toISOString();
  if (previous && Date.parse(observedAt) <= Date.parse(previous.latestCheckAt)) {
    return { kind: "retained", snapshot: previous, reason: "non-monotonic-observation" };
  }
  const state: StatusState = observation.healthy ? "operational" : "major_outage";
  const activeIncidents: StatusSnapshot["activeIncidents"] = [];
  const snapshot: StatusSnapshot = {
    schemaVersion: "1.0.0",
    generatedAt: observedAt,
    latestCheckAt: observedAt,
    sourceRevision: sourceRevision(observedAt, observation.statusCode),
    overallStatus: deriveOverallStatus({
      isFresh: true,
      componentStates: [state],
      activeIncidents,
    }),
    components: [
      {
        slug: component.slug,
        name: component.name,
        group: component.group,
        state,
        latestObservedAt: observedAt,
        responseTimeMs: observation.responseTimeMs,
        latency: latencyHistory(
          observedAt,
          observation.responseTimeMs,
          previous,
          component.showLatency ?? false,
        ),
        history: createHistory(observedAt, state, previous),
      },
    ],
    activeIncidents,
    scheduledMaintenance: [],
    recentEvents: [],
  };

  if (!validateStatusSnapshot(snapshot)) {
    throw new TypeError("The generated probe snapshot failed contract validation");
  }

  await dependencies.publish(snapshot);
  return { kind: "published", snapshot, statusCode: observation.statusCode };
}

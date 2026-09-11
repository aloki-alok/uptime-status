import type { Incident, StatusSnapshot, StatusState } from "./schema";
import type { SiteConfig } from "./site";
import { deriveOverallStatus } from "./truth";

const DAY_MS = 86_400_000;

type FixtureOptions = {
  generatedAt?: string;
  latestCheckAt?: string;
  activeIncidentImpact?: "none" | "degraded" | "partial_outage" | "major_outage";
  site?: SiteConfig;
};

const defaultComponents = [
  {
    componentId: "public-api",
    name: "Public API",
    group: "Services",
    showLatency: true,
  },
  {
    componentId: "website",
    name: "Website",
    group: "Website",
    showLatency: false,
  },
];

function createHistory(endDate: Date, seed: number) {
  return Array.from({ length: 90 }, (_, index) => {
    const date = new Date(endDate.getTime() - (89 - index) * DAY_MS);
    const hasBlip = (index + seed) % 37 === 0;
    return {
      date: date.toISOString().slice(0, 10),
      state: hasBlip ? ("degraded" as const) : ("operational" as const),
      severity: hasBlip ? ("minor" as const) : ("none" as const),
      uptime: hasBlip ? 99.82 : 100,
      downMinutes: hasBlip ? 2.6 : 0,
      avgMs: 118 + seed * 7 + (index % 9),
    };
  });
}

function createLatency(endDate: Date, baseline: number, seed: number) {
  return Array.from({ length: 60 }, (_, index) => {
    const wave = Math.sin((index + seed) / 6) * 14;
    const pulse = (index + seed * 3) % 23 === 0 ? 34 : 0;
    const avgMs = Math.round(baseline + wave + pulse + (index % 5));
    return {
      observedAt: new Date(endDate.getTime() - (59 - index) * 60_000).toISOString(),
      avgMs,
      sampleCount: 1,
    };
  });
}

export function createIncidentFixture(referenceAt: string, componentId = "public-api"): Incident {
  const endDate = new Date(referenceAt);

  return {
    slug: "elevated-api-latency",
    revision: 3,
    title: "Elevated API latency",
    state: "monitoring",
    impact: "degraded",
    affectedComponents: [componentId],
    startedAt: new Date(endDate.getTime() - 42 * 60_000).toISOString(),
    updates: [
      {
        id: "update-investigating",
        state: "investigating",
        message: "We are investigating slower API responses affecting a portion of requests.",
        publishedAt: new Date(endDate.getTime() - 42 * 60_000).toISOString(),
      },
      {
        id: "update-identified",
        state: "identified",
        message:
          "We identified capacity pressure in the API request path and applied a mitigation.",
        publishedAt: new Date(endDate.getTime() - 24 * 60_000).toISOString(),
      },
      {
        id: "update-monitoring",
        state: "monitoring",
        message: "Latency has returned to normal. We are monitoring recovery.",
        publishedAt: new Date(endDate.getTime() - 8 * 60_000).toISOString(),
        nextUpdateBy: new Date(endDate.getTime() + 22 * 60_000).toISOString(),
      },
    ],
  };
}

function createResolvedIncidentFixture(referenceAt: string, componentId: string): Incident {
  const incident = createIncidentFixture(referenceAt, componentId);
  const resolvedAt = new Date(new Date(referenceAt).getTime() - 4 * 60_000).toISOString();

  return {
    ...incident,
    state: "resolved",
    resolvedAt,
    updates: [
      ...incident.updates.map(({ nextUpdateBy: _, ...update }) => update),
      {
        id: "update-resolved",
        state: "resolved",
        message: "Response times returned to normal and the incident is resolved.",
        publishedAt: resolvedAt,
      },
    ],
  };
}

export function createStatusFixture(options: FixtureOptions = {}): StatusSnapshot {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const latestCheckAt =
    options.latestCheckAt ?? new Date(new Date(generatedAt).getTime() - 24_000).toISOString();
  const endDate = new Date(generatedAt);
  const configuredComponents = options.site?.components ?? defaultComponents;

  const components = configuredComponents.map((component, index) => ({
    slug: component.componentId,
    name: component.name,
    group: component.group,
    state: "operational" as const,
    latestObservedAt: latestCheckAt,
    responseTimeMs: 121 + index * 13,
    latency: component.showLatency
      ? createLatency(new Date(latestCheckAt), 118 + index * 12, index + 1)
      : null,
    history: createHistory(endDate, index + 1),
  }));

  const primaryComponent = components[0];
  const maintenanceComponent =
    components.find((component) => component.latency) ?? primaryComponent;

  const activeIncidents =
    options.activeIncidentImpact && options.activeIncidentImpact !== "none"
      ? [
          {
            ...createIncidentFixture(generatedAt, primaryComponent.slug),
            impact: options.activeIncidentImpact,
          },
        ]
      : [];

  const scheduledMaintenance = [
    {
      slug: "infrastructure-capacity-update",
      revision: 1,
      title: "Infrastructure capacity update",
      state: "scheduled" as const,
      expectedImpact: "Some requests may take a few seconds longer during the change.",
      affectedComponents: [maintenanceComponent.slug],
      startsAt: new Date(endDate.getTime() + 3 * DAY_MS).toISOString(),
      endsAt: new Date(endDate.getTime() + 3 * DAY_MS + 45 * 60_000).toISOString(),
      sourceTimeZone: options.site?.timeZone ?? "UTC",
      updates: [
        {
          id: "maintenance-scheduled",
          state: "scheduled" as const,
          message: "Capacity work is scheduled for this service.",
          publishedAt: generatedAt,
        },
      ],
    },
  ];

  const componentStates = components.map((component) => component.state as StatusState);

  return {
    schemaVersion: "1.0.0",
    generatedAt,
    latestCheckAt,
    sourceRevision: "fixture-20260907-a1",
    overallStatus: deriveOverallStatus({
      isFresh: true,
      componentStates,
      activeIncidents,
    }),
    components,
    activeIncidents,
    scheduledMaintenance,
    recentEvents: [createResolvedIncidentFixture(generatedAt, primaryComponent.slug)],
  };
}

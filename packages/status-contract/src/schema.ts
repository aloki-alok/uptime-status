import { FormatRegistry, type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { deriveOverallStatus } from "./truth";

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATE_TIME =
  /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

function isIsoDate(value: string) {
  const match = ISO_DATE.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));

  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

function isIsoDateTime(value: string) {
  return (
    ISO_DATE_TIME.test(value) && isIsoDate(value.slice(0, 10)) && !Number.isNaN(Date.parse(value))
  );
}

FormatRegistry.Set("date", isIsoDate);
FormatRegistry.Set("date-time", isIsoDateTime);

export const StatusStateSchema = Type.Union([
  Type.Literal("operational"),
  Type.Literal("degraded"),
  Type.Literal("partial_outage"),
  Type.Literal("major_outage"),
  Type.Literal("maintenance"),
  Type.Literal("unknown"),
]);

export const StatusSeveritySchema = Type.Union([
  Type.Literal("none"),
  Type.Literal("minor"),
  Type.Literal("major"),
  Type.Literal("unknown"),
]);

export const IncidentStateSchema = Type.Union([
  Type.Literal("investigating"),
  Type.Literal("identified"),
  Type.Literal("monitoring"),
  Type.Literal("resolved"),
]);

export const MaintenanceStateSchema = Type.Union([
  Type.Literal("scheduled"),
  Type.Literal("active"),
  Type.Literal("verifying"),
  Type.Literal("completed"),
  Type.Literal("cancelled"),
]);

export const DailyStatusSchema = Type.Object(
  {
    date: Type.String({ format: "date" }),
    state: StatusStateSchema,
    severity: StatusSeveritySchema,
    uptime: Type.Union([Type.Number({ minimum: 0, maximum: 100 }), Type.Null()]),
    downMinutes: Type.Number({ minimum: 0, maximum: 1440 }),
    avgMs: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
  },
  { additionalProperties: false },
);

export const LatencyPointSchema = Type.Object(
  {
    observedAt: Type.String({ format: "date-time" }),
    avgMs: Type.Number({ minimum: 0 }),
    p95Ms: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const ComponentSchema = Type.Object(
  {
    slug: Type.String({ minLength: 1, maxLength: 80, pattern: "^[a-z0-9-]+$" }),
    name: Type.String({ minLength: 1, maxLength: 120 }),
    group: Type.String({ minLength: 1, maxLength: 120 }),
    state: StatusStateSchema,
    latestObservedAt: Type.String({ format: "date-time" }),
    responseTimeMs: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
    latency: Type.Union([
      Type.Array(LatencyPointSchema, { minItems: 12, maxItems: 120 }),
      Type.Null(),
    ]),
    history: Type.Array(DailyStatusSchema, { minItems: 90, maxItems: 90 }),
  },
  { additionalProperties: false },
);

export const IncidentUpdateSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 120 }),
    state: IncidentStateSchema,
    message: Type.String({ minLength: 1, maxLength: 10_000 }),
    publishedAt: Type.String({ format: "date-time" }),
    nextUpdateBy: Type.Optional(Type.String({ format: "date-time" })),
  },
  { additionalProperties: false },
);

export const IncidentSchema = Type.Object(
  {
    slug: Type.String({ minLength: 1, maxLength: 120, pattern: "^[a-z0-9-]+$" }),
    revision: Type.Integer({ minimum: 1 }),
    title: Type.String({ minLength: 1, maxLength: 200 }),
    state: IncidentStateSchema,
    impact: Type.Union([
      Type.Literal("degraded"),
      Type.Literal("partial_outage"),
      Type.Literal("major_outage"),
    ]),
    affectedComponents: Type.Array(Type.String({ minLength: 1, maxLength: 80 }), {
      minItems: 1,
    }),
    startedAt: Type.String({ format: "date-time" }),
    resolvedAt: Type.Optional(Type.String({ format: "date-time" })),
    updates: Type.Array(IncidentUpdateSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);

export const MaintenanceUpdateSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 120 }),
    state: MaintenanceStateSchema,
    message: Type.String({ minLength: 1, maxLength: 10_000 }),
    publishedAt: Type.String({ format: "date-time" }),
  },
  { additionalProperties: false },
);

export const MaintenanceSchema = Type.Object(
  {
    slug: Type.String({ minLength: 1, maxLength: 120, pattern: "^[a-z0-9-]+$" }),
    revision: Type.Integer({ minimum: 1 }),
    title: Type.String({ minLength: 1, maxLength: 200 }),
    state: MaintenanceStateSchema,
    expectedImpact: Type.String({ minLength: 1, maxLength: 500 }),
    affectedComponents: Type.Array(Type.String({ minLength: 1, maxLength: 80 }), {
      minItems: 1,
    }),
    startsAt: Type.String({ format: "date-time" }),
    endsAt: Type.String({ format: "date-time" }),
    sourceTimeZone: Type.String({ minLength: 1, maxLength: 80 }),
    updates: Type.Array(MaintenanceUpdateSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);

export const StatusSnapshotSchema = Type.Object(
  {
    schemaVersion: Type.Literal("1.0.0"),
    generatedAt: Type.String({ format: "date-time" }),
    latestCheckAt: Type.String({ format: "date-time" }),
    sourceRevision: Type.String({ minLength: 8, maxLength: 128 }),
    overallStatus: StatusStateSchema,
    components: Type.Array(ComponentSchema, { minItems: 1 }),
    activeIncidents: Type.Array(IncidentSchema),
    scheduledMaintenance: Type.Array(MaintenanceSchema),
    recentEvents: Type.Array(Type.Union([IncidentSchema, MaintenanceSchema])),
  },
  { additionalProperties: false },
);

export type StatusState = Static<typeof StatusStateSchema>;
export type Incident = Static<typeof IncidentSchema>;
export type Maintenance = Static<typeof MaintenanceSchema>;
export type StatusSnapshot = Static<typeof StatusSnapshotSchema>;

function isUnique(values: string[]) {
  return new Set(values).size === values.length;
}

function isStrictlyChronological(values: string[], expectedStepMs?: number) {
  const timestamps = values.map((value) => Date.parse(value));

  return timestamps.every((timestamp, index) => {
    if (index === 0) return true;
    const step = timestamp - timestamps[index - 1];
    return expectedStepMs === undefined ? step > 0 : step === expectedStepMs;
  });
}

function referencesKnownComponents(values: string[], componentSlugs: Set<string>) {
  return isUnique(values) && values.every((slug) => componentSlugs.has(slug));
}

function hasValidIncidentSemantics(
  incident: Incident,
  componentSlugs: Set<string>,
  active: boolean,
) {
  const updateIds = incident.updates.map((update) => update.id);
  const updateTimes = incident.updates.map((update) => update.publishedAt);
  const startedAt = Date.parse(incident.startedAt);
  const resolvedAt = incident.resolvedAt ? Date.parse(incident.resolvedAt) : null;

  return (
    referencesKnownComponents(incident.affectedComponents, componentSlugs) &&
    isUnique(updateIds) &&
    isStrictlyChronological(updateTimes) &&
    incident.updates.every((update) => Date.parse(update.publishedAt) >= startedAt) &&
    (!active || (incident.state !== "resolved" && resolvedAt === null)) &&
    (resolvedAt === null || resolvedAt >= startedAt)
  );
}

function hasValidMaintenanceSemantics(maintenance: Maintenance, componentSlugs: Set<string>) {
  return (
    Date.parse(maintenance.startsAt) < Date.parse(maintenance.endsAt) &&
    referencesKnownComponents(maintenance.affectedComponents, componentSlugs) &&
    isUnique(maintenance.updates.map((update) => update.id)) &&
    isStrictlyChronological(maintenance.updates.map((update) => update.publishedAt))
  );
}

export function validateStatusSnapshot(input: unknown): input is StatusSnapshot {
  if (!Value.Check(StatusSnapshotSchema, input)) return false;

  const generatedAt = Date.parse(input.generatedAt);
  const componentSlugs = new Set(input.components.map((component) => component.slug));
  if (componentSlugs.size !== input.components.length) return false;
  if (Date.parse(input.latestCheckAt) > generatedAt) return false;

  const componentsAreValid = input.components.every((component) => {
    const historyDates = component.history.map((day) => day.date);
    const latencyTimes = component.latency?.map((point) => point.observedAt) ?? [];

    return (
      Date.parse(component.latestObservedAt) <= generatedAt &&
      isUnique(historyDates) &&
      isStrictlyChronological(historyDates, 86_400_000) &&
      (component.latency === null ||
        (isStrictlyChronological(latencyTimes, 60_000) &&
          Date.parse(latencyTimes.at(-1) ?? input.generatedAt) <= generatedAt))
    );
  });
  if (!componentsAreValid) return false;

  if (
    !input.activeIncidents.every((incident) =>
      hasValidIncidentSemantics(incident, componentSlugs, true),
    ) ||
    !input.scheduledMaintenance.every((maintenance) =>
      hasValidMaintenanceSemantics(maintenance, componentSlugs),
    )
  ) {
    return false;
  }

  const expectedStatus = deriveOverallStatus({
    isFresh: true,
    componentStates: input.components.map((component) => component.state),
    activeIncidents: input.activeIncidents,
  });
  if (input.overallStatus !== "unknown" && input.overallStatus !== expectedStatus) return false;

  return input.recentEvents.every((event) =>
    "startedAt" in event
      ? hasValidIncidentSemantics(event, componentSlugs, false)
      : hasValidMaintenanceSemantics(event, componentSlugs),
  );
}

import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SOURCE_REVISION = /^[a-f0-9]{64}$/;

const CurrentStateSchema = Type.Union([
  Type.Literal("operational"),
  Type.Literal("major_outage"),
  Type.Literal("maintenance"),
  Type.Literal("unknown"),
]);

const HistoryStateSchema = Type.Union([
  Type.Literal("operational"),
  Type.Literal("degraded"),
  Type.Literal("major_outage"),
  Type.Literal("maintenance"),
  Type.Literal("unknown"),
]);

const SeveritySchema = Type.Union([
  Type.Literal("none"),
  Type.Literal("minor"),
  Type.Literal("major"),
  Type.Literal("unknown"),
]);

const LatencyPointSchema = Type.Object(
  {
    observedAt: Type.String(),
    avgMs: Type.Number({ minimum: 0 }),
    sampleCount: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

const HistoryDaySchema = Type.Object(
  {
    date: Type.String(),
    state: HistoryStateSchema,
    severity: SeveritySchema,
    uptime: Type.Union([Type.Number({ minimum: 0, maximum: 100 }), Type.Null()]),
    downMinutes: Type.Number({ minimum: 0, maximum: 1440 }),
    avgMs: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
  },
  { additionalProperties: false },
);

const ExportComponentSchema = Type.Object(
  {
    componentId: Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z0-9][a-z0-9-]*$" }),
    state: CurrentStateSchema,
    latestCheckAt: Type.String(),
    responseTimeMs: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
    latency: Type.Array(LatencyPointSchema, { maxItems: 60 }),
    history: Type.Array(HistoryDaySchema, { minItems: 90, maxItems: 90 }),
  },
  { additionalProperties: false },
);

export const UptimeKumaExportSchema = Type.Object(
  {
    schemaVersion: Type.Literal("1.0.0"),
    generatedAt: Type.String(),
    latestCheckAt: Type.String(),
    sourceRevision: Type.String({ pattern: SOURCE_REVISION.source }),
    components: Type.Array(ExportComponentSchema, { minItems: 1, maxItems: 200 }),
  },
  { additionalProperties: false },
);

export type UptimeKumaExport = Static<typeof UptimeKumaExportSchema>;

function isUtcInstant(value: string) {
  return UTC_INSTANT.test(value) && new Date(value).toISOString() === value;
}

function isUtcDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}

function expectedDate(endDate: string, index: number) {
  const end = Date.parse(`${endDate}T00:00:00.000Z`);
  return new Date(end - (89 - index) * DAY_MS).toISOString().slice(0, 10);
}

function validHistoryDay(
  day: UptimeKumaExport["components"][number]["history"][number],
  currentDay: boolean,
) {
  const expectedSeverity = {
    operational: "none",
    maintenance: "none",
    degraded: "minor",
    major_outage: "major",
    unknown: "unknown",
  }[day.state];
  if (day.severity !== expectedSeverity) return false;
  if (day.state === "unknown") {
    return day.uptime === null && day.downMinutes === 0 && day.avgMs === null;
  }
  if (day.state === "operational" || day.state === "maintenance") {
    if (day.downMinutes !== 0) return false;
  }
  if (day.state === "major_outage" && day.downMinutes < 10) return false;
  return currentDay ? day.uptime === null : day.uptime !== null;
}

function validLatency(
  points: UptimeKumaExport["components"][number]["latency"],
  latestCheckAt: string,
) {
  const latestBucket = Math.floor(Date.parse(latestCheckAt) / MINUTE_MS) * MINUTE_MS;
  const earliestBucket = latestBucket - 59 * MINUTE_MS;
  return points.every((point, index) => {
    const observedAt = Date.parse(point.observedAt);
    return (
      isUtcInstant(point.observedAt) &&
      observedAt % MINUTE_MS === 0 &&
      observedAt >= earliestBucket &&
      observedAt <= latestBucket &&
      (index === 0 || observedAt > Date.parse(points[index - 1].observedAt))
    );
  });
}

function canonicalContent(value: UptimeKumaExport) {
  return {
    latestCheckAt: value.latestCheckAt,
    components: [...value.components]
      .sort((left, right) => left.componentId.localeCompare(right.componentId))
      .map((component) => ({
        componentId: component.componentId,
        state: component.state,
        latestCheckAt: component.latestCheckAt,
        responseTimeMs: component.responseTimeMs,
        latency: component.latency.map((point) => ({
          observedAt: point.observedAt,
          avgMs: point.avgMs,
          sampleCount: point.sampleCount,
        })),
        history: component.history.map((day) => ({
          date: day.date,
          state: day.state,
          severity: day.severity,
          uptime: day.uptime,
          downMinutes: day.downMinutes,
          avgMs: day.avgMs,
        })),
      })),
  };
}

export async function uptimeKumaSourceRevision(value: UptimeKumaExport) {
  const input = new TextEncoder().encode(JSON.stringify(canonicalContent(value)));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function validateUptimeKumaExport(
  input: unknown,
  expectedComponentIds?: readonly string[],
): Promise<boolean> {
  if (!Value.Check(UptimeKumaExportSchema, input)) return false;
  if (!isUtcInstant(input.generatedAt) || !isUtcInstant(input.latestCheckAt)) return false;
  const generatedAt = Date.parse(input.generatedAt);
  const componentIds = input.components.map((component) => component.componentId);
  if (new Set(componentIds).size !== componentIds.length) return false;
  if (expectedComponentIds) {
    const expected = [...expectedComponentIds].sort();
    if (
      new Set(expected).size !== expected.length ||
      expected.length !== componentIds.length ||
      expected.some((componentId, index) => componentId !== [...componentIds].sort()[index])
    ) {
      return false;
    }
  }

  const oldestLatestCheck = Math.min(
    ...input.components.map((component) => Date.parse(component.latestCheckAt)),
  );
  if (Date.parse(input.latestCheckAt) !== oldestLatestCheck) return false;
  const endDate = input.generatedAt.slice(0, 10);

  for (const component of input.components) {
    if (!isUtcInstant(component.latestCheckAt)) return false;
    if (Date.parse(component.latestCheckAt) > generatedAt) return false;
    if (component.state !== "operational" && component.responseTimeMs !== null) return false;
    if (!validLatency(component.latency, component.latestCheckAt)) return false;
    if (
      !component.history.every(
        (day, index) =>
          isUtcDate(day.date) &&
          day.date === expectedDate(endDate, index) &&
          validHistoryDay(day, index === 89),
      )
    ) {
      return false;
    }
    const today = component.history[89];
    if (
      (component.state === "major_outage" &&
        today.state !== "degraded" &&
        today.state !== "major_outage") ||
      (component.state === "maintenance" && today.state !== "maintenance")
    ) {
      return false;
    }
  }

  return input.sourceRevision === (await uptimeKumaSourceRevision(input));
}

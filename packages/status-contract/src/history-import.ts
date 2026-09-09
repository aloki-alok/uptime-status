import { createHash } from "node:crypto";
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { DailyStatusSchema, LatencyPointSchema } from "./schema";

const SHA256 = "^[a-f0-9]{64}$";
const SLUG = "^[a-z0-9-]+$";

export const HistoryImportBundleSchema = Type.Object(
  {
    schemaVersion: Type.Literal("1.0.0"),
    importId: Type.String({ pattern: SHA256 }),
    siteId: Type.String({ minLength: 1, maxLength: 80, pattern: SLUG }),
    topologyRevision: Type.String({ minLength: 8, maxLength: 128, pattern: "^[A-Za-z0-9._:-]+$" }),
    source: Type.Object(
      {
        systemId: Type.String({ minLength: 1, maxLength: 80, pattern: SLUG }),
        sourceId: Type.String({ minLength: 1, maxLength: 80, pattern: SLUG }),
        systemVersion: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
        schemaVersion: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
      },
      { additionalProperties: false },
    ),
    extraction: Type.Object(
      {
        adapterId: Type.String({ minLength: 1, maxLength: 120, pattern: SLUG }),
        adapterVersion: Type.String({ minLength: 1, maxLength: 80 }),
        artifactKind: Type.String({ minLength: 1, maxLength: 80, pattern: SLUG }),
        artifactSha256: Type.String({ pattern: SHA256 }),
        cutoffAt: Type.String({ format: "date-time" }),
        exportedAt: Type.String({ format: "date-time" }),
        sourceTimeZone: Type.String({ minLength: 1, maxLength: 80 }),
      },
      { additionalProperties: false },
    ),
    components: Type.Array(
      Type.Object(
        {
          componentId: Type.String({ minLength: 1, maxLength: 80, pattern: SLUG }),
          sourceBinding: Type.Object(
            {
              sourceId: Type.String({ minLength: 1, maxLength: 80, pattern: SLUG }),
              entityType: Type.String({ minLength: 1, maxLength: 80, pattern: SLUG }),
              externalId: Type.String({ minLength: 1, maxLength: 160 }),
            },
            { additionalProperties: false },
          ),
          coverage: Type.Object(
            {
              startsOn: Type.String({ format: "date" }),
              endsOn: Type.String({ format: "date" }),
            },
            { additionalProperties: false },
          ),
          history: Type.Array(DailyStatusSchema, { minItems: 1, maxItems: 3660 }),
          latency: Type.Optional(Type.Array(LatencyPointSchema, { minItems: 1, maxItems: 10080 })),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 200 },
    ),
  },
  { additionalProperties: false },
);

export type HistoryImportBundle = Static<typeof HistoryImportBundleSchema>;
export type HistoryImportBundleContent = Omit<HistoryImportBundle, "importId">;

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("History import content is not JSON serializable");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter((key) => key !== "importId" && record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`);
  return `{${entries.join(",")}}`;
}

export function historyImportId(value: HistoryImportBundle | HistoryImportBundleContent) {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

export function createHistoryImportBundle(
  content: HistoryImportBundleContent,
): HistoryImportBundle {
  return { ...content, importId: historyImportId(content) };
}

function unique(values: string[]) {
  return new Set(values).size === values.length;
}

function chronologicalDates(values: string[]) {
  return values.every((value, index) => index === 0 || value > values[index - 1]);
}

function chronologicalInstants(values: string[]) {
  const instants = values.map(Date.parse);
  return instants.every((value, index) => index === 0 || value > instants[index - 1]);
}

function completedUtcDayAtOrBefore(date: string, cutoff: number) {
  return Date.parse(`${date}T00:00:00Z`) + 86_400_000 <= cutoff;
}

export function validateHistoryImportBundle(input: unknown): input is HistoryImportBundle {
  if (!Value.Check(HistoryImportBundleSchema, input)) return false;
  if (input.importId !== historyImportId(input)) return false;

  try {
    new Intl.DateTimeFormat("en", { timeZone: input.extraction.sourceTimeZone });
  } catch {
    return false;
  }

  const cutoff = Date.parse(input.extraction.cutoffAt);
  if (Date.parse(input.extraction.exportedAt) < cutoff) return false;
  if (!unique(input.components.map((component) => component.componentId))) return false;
  if (
    !unique(
      input.components.map(
        (component) =>
          `${component.sourceBinding.sourceId}\u0000${component.sourceBinding.entityType}\u0000${component.sourceBinding.externalId}`,
      ),
    )
  ) {
    return false;
  }

  return input.components.every((component) => {
    const historyDates = component.history.map((day) => day.date);
    const latencyTimes = component.latency?.map((point) => point.observedAt) ?? [];
    return (
      component.sourceBinding.sourceId === input.source.sourceId &&
      chronologicalDates(historyDates) &&
      chronologicalInstants(latencyTimes) &&
      component.coverage.startsOn === historyDates[0] &&
      component.coverage.endsOn === historyDates.at(-1) &&
      historyDates.every((date) => completedUtcDayAtOrBefore(date, cutoff)) &&
      latencyTimes.every((observedAt) => Date.parse(observedAt) <= cutoff)
    );
  });
}

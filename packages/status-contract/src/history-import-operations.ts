import { createHash } from "node:crypto";
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import "./schema";

const SHA256 = "^[a-f0-9]{64}$";
const SLUG = "^[a-z0-9-]+$";
const REVISION = "^[A-Za-z0-9._:-]+$";

const DestinationSchema = Type.Object(
  {
    adapterId: Type.String({ minLength: 1, maxLength: 120, pattern: SLUG }),
    destinationId: Type.String({ minLength: 1, maxLength: 240 }),
  },
  { additionalProperties: false },
);

const BindingProperties = {
  siteId: Type.String({ minLength: 1, maxLength: 80, pattern: SLUG }),
  topologyRevision: Type.String({ minLength: 8, maxLength: 128, pattern: REVISION }),
  sourceSystemId: Type.String({ minLength: 1, maxLength: 80, pattern: SLUG }),
  sourceId: Type.String({ minLength: 1, maxLength: 80, pattern: SLUG }),
  importId: Type.String({ pattern: SHA256 }),
  bundleSha256: Type.String({ pattern: SHA256 }),
  cutoffAt: Type.String({ format: "date-time" }),
  platformRevision: Type.String({ minLength: 7, maxLength: 128, pattern: REVISION }),
  destination: DestinationSchema,
};

const CountSchema = Type.Integer({ minimum: 0 });

export const HistoryImportPlanSchema = Type.Object(
  {
    schemaVersion: Type.Literal("1.0.0"),
    planId: Type.String({ pattern: SHA256 }),
    ...BindingProperties,
    createdAt: Type.String({ format: "date-time" }),
    summary: Type.Object(
      {
        componentCount: CountSchema,
        dailyRecordCount: CountSchema,
        latencyRecordCount: CountSchema,
        gapCount: CountSchema,
        collisionCount: CountSchema,
        unsupportedRecordCount: CountSchema,
        proposedWriteCount: CountSchema,
      },
      { additionalProperties: false },
    ),
    components: Type.Array(
      Type.Object(
        {
          componentId: Type.String({ minLength: 1, maxLength: 80, pattern: SLUG }),
          coverage: Type.Object(
            {
              startsOn: Type.String({ format: "date" }),
              endsOn: Type.String({ format: "date" }),
            },
            { additionalProperties: false },
          ),
          dailyRecordCount: CountSchema,
          latencyRecordCount: CountSchema,
          gaps: Type.Array(Type.String({ format: "date" }), { maxItems: 3660 }),
          collisions: Type.Array(
            Type.Object(
              {
                kind: Type.Union([Type.Literal("daily"), Type.Literal("latency")]),
                observedAt: Type.String({ minLength: 10, maxLength: 35 }),
              },
              { additionalProperties: false },
            ),
            { maxItems: 13740 },
          ),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 200 },
    ),
  },
  { additionalProperties: false },
);

export type HistoryImportPlan = Static<typeof HistoryImportPlanSchema>;
export type HistoryImportPlanContent = Omit<HistoryImportPlan, "planId">;

function receiptSchema<TOperation extends "apply" | "verify" | "rollback", T extends TSchema>(
  operation: TOperation,
  result: T,
) {
  return Type.Object(
    {
      schemaVersion: Type.Literal("1.0.0"),
      receiptId: Type.String({ pattern: SHA256 }),
      operation: Type.Literal(operation),
      planId: Type.String({ pattern: SHA256 }),
      ...BindingProperties,
      completedAt: Type.String({ format: "date-time" }),
      ...result.properties,
    },
    { additionalProperties: false },
  );
}

export const HistoryImportApplyReceiptSchema = receiptSchema(
  "apply",
  Type.Object({
    dailyRecordCount: CountSchema,
    latencyRecordCount: CountSchema,
    noOp: Type.Boolean(),
  }),
);

export const HistoryImportVerifyReceiptSchema = receiptSchema(
  "verify",
  Type.Object({
    dailyRecordCount: CountSchema,
    latencyRecordCount: CountSchema,
  }),
);

export const HistoryImportRollbackReceiptSchema = receiptSchema(
  "rollback",
  Type.Object({
    deletedDailyRecordCount: CountSchema,
    deletedLatencyRecordCount: CountSchema,
    noOp: Type.Boolean(),
  }),
);

export type HistoryImportApplyReceipt = Static<typeof HistoryImportApplyReceiptSchema>;
export type HistoryImportVerifyReceipt = Static<typeof HistoryImportVerifyReceiptSchema>;
export type HistoryImportRollbackReceipt = Static<typeof HistoryImportRollbackReceiptSchema>;
export type HistoryImportApplyReceiptContent = Omit<HistoryImportApplyReceipt, "receiptId">;
export type HistoryImportVerifyReceiptContent = Omit<HistoryImportVerifyReceipt, "receiptId">;
export type HistoryImportRollbackReceiptContent = Omit<HistoryImportRollbackReceipt, "receiptId">;

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("History import operation is not JSON serializable");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
    .join(",")}}`;
}

function contentId<T extends Record<string, unknown>>(value: T, identityKey: keyof T) {
  const content = Object.fromEntries(Object.entries(value).filter(([key]) => key !== identityKey));
  return createHash("sha256").update(canonicalize(content)).digest("hex");
}

function sorted(values: string[]) {
  return values.every((value, index) => index === 0 || value > values[index - 1]);
}

function validPlanSemantics(plan: HistoryImportPlan) {
  if (!sorted(plan.components.map((component) => component.componentId))) return false;
  if (
    plan.components.some((component) => component.coverage.startsOn > component.coverage.endsOn)
  ) {
    return false;
  }
  if (
    plan.components.some(
      (component) =>
        !sorted(component.gaps) ||
        component.gaps.some(
          (date) => date < component.coverage.startsOn || date > component.coverage.endsOn,
        ) ||
        !sorted(
          component.collisions.map((collision) => `${collision.kind}\u0000${collision.observedAt}`),
        ) ||
        component.collisions.some((collision) =>
          collision.kind === "daily"
            ? collision.observedAt < component.coverage.startsOn ||
              collision.observedAt > component.coverage.endsOn
            : Date.parse(collision.observedAt) > Date.parse(plan.cutoffAt),
        ),
    )
  ) {
    return false;
  }
  const totals = plan.components.reduce(
    (value, component) => ({
      daily: value.daily + component.dailyRecordCount,
      latency: value.latency + component.latencyRecordCount,
      gaps: value.gaps + component.gaps.length,
      collisions: value.collisions + component.collisions.length,
    }),
    { daily: 0, latency: 0, gaps: 0, collisions: 0 },
  );
  return (
    plan.summary.componentCount === plan.components.length &&
    plan.summary.dailyRecordCount === totals.daily &&
    plan.summary.latencyRecordCount === totals.latency &&
    plan.summary.gapCount === totals.gaps &&
    plan.summary.collisionCount === totals.collisions &&
    plan.summary.proposedWriteCount === totals.daily + totals.latency &&
    plan.summary.unsupportedRecordCount === 0
  );
}

export function historyImportPlanId(value: HistoryImportPlan | HistoryImportPlanContent) {
  return contentId(value as unknown as Record<string, unknown>, "planId");
}

export function createHistoryImportPlan(content: HistoryImportPlanContent): HistoryImportPlan {
  return { ...content, planId: historyImportPlanId(content) };
}

export function validateHistoryImportPlan(input: unknown): input is HistoryImportPlan {
  return (
    Value.Check(HistoryImportPlanSchema, input) &&
    input.planId === historyImportPlanId(input) &&
    validPlanSemantics(input)
  );
}

function receiptId(value: Record<string, unknown>) {
  return contentId(value, "receiptId");
}

function createReceipt<T extends Record<string, unknown>>(content: T) {
  return { ...content, receiptId: receiptId(content) };
}

function validateReceipt(schema: TSchema, input: unknown) {
  return (
    Value.Check(schema, input) &&
    (input as { receiptId: string }).receiptId === receiptId(input as Record<string, unknown>)
  );
}

function receiptMatchesPlan(
  receipt: HistoryImportApplyReceipt | HistoryImportVerifyReceipt | HistoryImportRollbackReceipt,
  plan: HistoryImportPlan,
) {
  const bindingMatches =
    validateHistoryImportPlan(plan) &&
    receipt.planId === plan.planId &&
    receipt.siteId === plan.siteId &&
    receipt.topologyRevision === plan.topologyRevision &&
    receipt.sourceSystemId === plan.sourceSystemId &&
    receipt.sourceId === plan.sourceId &&
    receipt.importId === plan.importId &&
    receipt.bundleSha256 === plan.bundleSha256 &&
    receipt.cutoffAt === plan.cutoffAt &&
    receipt.platformRevision === plan.platformRevision &&
    receipt.destination.adapterId === plan.destination.adapterId &&
    receipt.destination.destinationId === plan.destination.destinationId &&
    Date.parse(receipt.completedAt) >= Date.parse(plan.createdAt);
  if (!bindingMatches) return false;
  if (receipt.operation === "rollback") {
    return receipt.noOp
      ? receipt.deletedDailyRecordCount === 0 && receipt.deletedLatencyRecordCount === 0
      : receipt.deletedDailyRecordCount === plan.summary.dailyRecordCount &&
          receipt.deletedLatencyRecordCount === plan.summary.latencyRecordCount;
  }
  return (
    receipt.dailyRecordCount === plan.summary.dailyRecordCount &&
    receipt.latencyRecordCount === plan.summary.latencyRecordCount
  );
}

export function createHistoryImportApplyReceipt(content: HistoryImportApplyReceiptContent) {
  return createReceipt(content) as HistoryImportApplyReceipt;
}

export function createHistoryImportVerifyReceipt(content: HistoryImportVerifyReceiptContent) {
  return createReceipt(content) as HistoryImportVerifyReceipt;
}

export function createHistoryImportRollbackReceipt(content: HistoryImportRollbackReceiptContent) {
  return createReceipt(content) as HistoryImportRollbackReceipt;
}

export function validateHistoryImportApplyReceipt(
  input: unknown,
  plan?: HistoryImportPlan,
): input is HistoryImportApplyReceipt {
  return (
    validateReceipt(HistoryImportApplyReceiptSchema, input) &&
    (!plan || receiptMatchesPlan(input as HistoryImportApplyReceipt, plan))
  );
}

export function validateHistoryImportVerifyReceipt(
  input: unknown,
  plan?: HistoryImportPlan,
): input is HistoryImportVerifyReceipt {
  return (
    validateReceipt(HistoryImportVerifyReceiptSchema, input) &&
    (!plan || receiptMatchesPlan(input as HistoryImportVerifyReceipt, plan))
  );
}

export function validateHistoryImportRollbackReceipt(
  input: unknown,
  plan?: HistoryImportPlan,
): input is HistoryImportRollbackReceipt {
  return (
    validateReceipt(HistoryImportRollbackReceiptSchema, input) &&
    (!plan || receiptMatchesPlan(input as HistoryImportRollbackReceipt, plan))
  );
}

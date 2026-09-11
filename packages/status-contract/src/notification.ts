import { createHash } from "node:crypto";
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const SHA256 = "^[a-f0-9]{64}$";
const SLUG = "^[a-z0-9-]+$";
const EVENT_ID = "^evt_[a-f0-9]{64}$";
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const NotificationEventTypeSchema = Type.Union([
  Type.Literal("incident_published"),
  Type.Literal("incident_updated"),
  Type.Literal("incident_resolved"),
  Type.Literal("maintenance_scheduled"),
  Type.Literal("maintenance_rescheduled"),
  Type.Literal("maintenance_started"),
  Type.Literal("maintenance_cancelled"),
  Type.Literal("maintenance_completed"),
]);

const IncidentEventTypeSchema = Type.Union([
  Type.Literal("incident_published"),
  Type.Literal("incident_updated"),
  Type.Literal("incident_resolved"),
]);

const MaintenanceEventTypeSchema = Type.Union([
  Type.Literal("maintenance_scheduled"),
  Type.Literal("maintenance_rescheduled"),
  Type.Literal("maintenance_started"),
  Type.Literal("maintenance_cancelled"),
  Type.Literal("maintenance_completed"),
]);

const CommonFields = {
  schemaVersion: Type.Literal("1.0.0"),
  eventId: Type.String({ pattern: EVENT_ID }),
  siteId: Type.String({ minLength: 1, maxLength: 80, pattern: SLUG }),
  contentRevision: Type.String({ pattern: SHA256 }),
  templateRevision: Type.Literal("1"),
  title: Type.String({ minLength: 1, maxLength: 200, pattern: "\\S" }),
  message: Type.String({ minLength: 1, maxLength: 10_000, pattern: "\\S" }),
  publishedAt: Type.String({ minLength: 24, maxLength: 24 }),
};

const SourceFields = {
  slug: Type.String({ minLength: 1, maxLength: 120, pattern: SLUG }),
  revision: Type.Integer({ minimum: 1 }),
  updateId: Type.Optional(
    Type.String({ minLength: 1, maxLength: 120, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" }),
  ),
};

const IncidentNotificationEventSchema = Type.Object(
  {
    ...CommonFields,
    source: Type.Object(
      { kind: Type.Literal("incident"), ...SourceFields },
      { additionalProperties: false },
    ),
    type: IncidentEventTypeSchema,
  },
  { additionalProperties: false },
);

const MaintenanceNotificationEventSchema = Type.Object(
  {
    ...CommonFields,
    source: Type.Object(
      { kind: Type.Literal("maintenance"), ...SourceFields },
      { additionalProperties: false },
    ),
    type: MaintenanceEventTypeSchema,
    startsAt: Type.String({ minLength: 24, maxLength: 24 }),
    endsAt: Type.String({ minLength: 24, maxLength: 24 }),
  },
  { additionalProperties: false },
);

export const NotificationEventSchema = Type.Union([
  IncidentNotificationEventSchema,
  MaintenanceNotificationEventSchema,
]);

export type NotificationEventType = Static<typeof NotificationEventTypeSchema>;
export type NotificationEvent = Static<typeof NotificationEventSchema>;
export type NotificationEventContent = NotificationEvent extends infer Event
  ? Event extends unknown
    ? Omit<Event, "eventId">
    : never
  : never;

export function notificationEventId(value: NotificationEvent | NotificationEventContent) {
  const identity = [
    value.siteId,
    value.source.kind,
    value.source.slug,
    value.type,
    value.contentRevision,
  ];
  return `evt_${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}

export function createNotificationEvent(content: NotificationEventContent): NotificationEvent {
  return { ...content, eventId: notificationEventId(content) } as NotificationEvent;
}

function isUtcInstant(value: string) {
  const parsed = Date.parse(value);
  return (
    UTC_INSTANT.test(value) && Number.isFinite(parsed) && new Date(parsed).toISOString() === value
  );
}

export function validateNotificationEvent(input: unknown): input is NotificationEvent {
  if (!Value.Check(NotificationEventSchema, input)) return false;
  if (!isUtcInstant(input.publishedAt) || input.eventId !== notificationEventId(input))
    return false;
  if (input.source.kind === "incident") return true;
  if (!("startsAt" in input) || !("endsAt" in input)) return false;
  return (
    isUtcInstant(input.startsAt) &&
    isUtcInstant(input.endsAt) &&
    Date.parse(input.startsAt) < Date.parse(input.endsAt)
  );
}

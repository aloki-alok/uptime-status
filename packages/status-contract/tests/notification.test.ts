import { describe, expect, test } from "bun:test";
import {
  createNotificationEvent,
  notificationEventId,
  validateNotificationEvent,
} from "../src/notification-authoring";

const incident = {
  schemaVersion: "1.0.0" as const,
  siteId: "site-a",
  source: {
    kind: "incident" as const,
    slug: "api-latency",
    revision: 2,
    updateId: "update-002",
  },
  type: "incident_updated" as const,
  contentRevision: "a".repeat(64),
  templateRevision: "1" as const,
  title: "API latency",
  message: "Requests remain slower than usual.",
  publishedAt: "2026-09-11T10:00:00.000Z",
};

describe("curated notification event", () => {
  test("creates and validates a deterministic event identity", () => {
    const event = createNotificationEvent(incident);

    expect(event.eventId).toBe(notificationEventId(incident));
    expect(event.eventId).toMatch(/^evt_[a-f0-9]{64}$/);
    expect(validateNotificationEvent(event)).toBe(true);
    expect(notificationEventId({ ...incident, title: "Cosmetic title change" })).toBe(
      event.eventId,
    );
    expect(notificationEventId({ ...incident, contentRevision: "b".repeat(64) })).not.toBe(
      event.eventId,
    );
  });

  test("rejects forged identities, unknown fields, and malformed revisions", () => {
    const event = createNotificationEvent(incident);

    expect(validateNotificationEvent({ ...event, eventId: `evt_${"b".repeat(64)}` })).toBe(false);
    expect(validateNotificationEvent({ ...event, monitorUrl: "https://private.test" })).toBe(false);
    expect(validateNotificationEvent({ ...event, contentRevision: "revision-2" })).toBe(false);
    expect(
      validateNotificationEvent(
        createNotificationEvent({ ...incident, publishedAt: "2026-02-30T10:00:00.000Z" }),
      ),
    ).toBe(false);
    expect(() =>
      validateNotificationEvent(
        createNotificationEvent({ ...incident, publishedAt: "2026-99-30T10:00:00.000Z" }),
      ),
    ).not.toThrow();
  });

  test("requires event types to match their source kind", () => {
    expect(
      validateNotificationEvent(
        createNotificationEvent({ ...incident, type: "maintenance_started" as never }),
      ),
    ).toBe(false);
    expect(
      validateNotificationEvent(
        createNotificationEvent({
          ...incident,
          source: { ...incident.source, kind: "maintenance" as const },
        } as never),
      ),
    ).toBe(false);
  });

  test("requires valid maintenance windows and forbids them on incidents", () => {
    const maintenance = {
      ...incident,
      source: {
        kind: "maintenance" as const,
        slug: "database-upgrade",
        revision: 1,
        updateId: "schedule-001",
      },
      type: "maintenance_scheduled" as const,
      startsAt: "2026-09-12T10:00:00.000Z",
      endsAt: "2026-09-12T11:00:00.000Z",
    };
    expect(validateNotificationEvent(createNotificationEvent(maintenance))).toBe(true);
    expect(
      validateNotificationEvent(
        createNotificationEvent({
          ...maintenance,
          endsAt: "2026-09-12T09:59:59.000Z",
        }),
      ),
    ).toBe(false);
    expect(
      validateNotificationEvent(
        createNotificationEvent({
          ...incident,
          startsAt: maintenance.startsAt,
          endsAt: maintenance.endsAt,
        } as never),
      ),
    ).toBe(false);
  });

  test("accepts every curated v1 event category", () => {
    const incidentTypes = ["incident_published", "incident_updated", "incident_resolved"] as const;
    for (const type of incidentTypes) {
      expect(validateNotificationEvent(createNotificationEvent({ ...incident, type }))).toBe(true);
    }

    const maintenanceTypes = [
      "maintenance_scheduled",
      "maintenance_rescheduled",
      "maintenance_started",
      "maintenance_cancelled",
      "maintenance_completed",
    ] as const;
    for (const type of maintenanceTypes) {
      const content = {
        ...incident,
        source: { ...incident.source, kind: "maintenance" as const },
        type,
        startsAt: "2026-09-12T10:00:00.000Z",
        endsAt: "2026-09-12T11:00:00.000Z",
      };
      expect(validateNotificationEvent(createNotificationEvent(content))).toBe(true);
    }
  });
});

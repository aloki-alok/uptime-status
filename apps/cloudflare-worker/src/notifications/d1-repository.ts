import type { NotificationEvent } from "@uptime-status/domain/notification";
import type { DatabasePort } from "../subscriptions/d1-repository";

// Re-exported so notification consumers keep one event type instead of a looser local copy.
export type { NotificationEvent };

type NotificationEventType = NotificationEvent["type"];

const INCIDENT_TYPES = new Set<NotificationEventType>([
  "incident_published",
  "incident_updated",
  "incident_resolved",
]);
const MAINTENANCE_TYPES = new Set<NotificationEventType>([
  "maintenance_scheduled",
  "maintenance_rescheduled",
  "maintenance_started",
  "maintenance_cancelled",
  "maintenance_completed",
]);

export type NotificationQueueMessage = {
  schemaVersion: "1.0.0";
  kind: "notification";
  siteId: string;
  eventId: string;
  emailKey: string;
};

export interface NotificationQueue {
  send(message: NotificationQueueMessage, options: { contentType: "json" }): Promise<unknown>;
}

export type ClaimedNotification = {
  event: NotificationEvent;
  siteId: string;
  eventId: string;
  emailKey: string;
  normalizedEmail: string;
  subscriberTokenVersion: number;
  claimId: string;
  claimExpiresAt: string;
  attemptCount: number;
};

type EventRow = {
  event_id: string;
  site_id: string;
  event_type: NotificationEvent["type"];
  payload_json: string;
  audience_cutoff_at: string;
  created_at: string;
  expansion_after_confirmed_at: string | null;
  expansion_after_email_key: string | null;
  expanded_at: string | null;
};

type AudienceRow = {
  email_key: string;
  normalized_email: string;
  token_version: number;
  confirmed_at: string;
};

type PendingRow = {
  event_id: string;
  site_id: string;
  email_key: string;
};

type ExpandableEventRow = {
  event_id: string;
};

type ClaimedRow = {
  event_id: string;
  site_id: string;
  email_key: string;
  normalized_email: string;
  subscriber_token_version: number;
  claim_id: string;
  claim_expires_at: string;
  attempt_count: number;
  payload_json: string;
};

function requireTimestamp(value: string, label: string) {
  if (!Number.isFinite(Date.parse(value))) throw new TypeError(`${label} must be an ISO timestamp`);
}

function requireIdentifier(value: string, label: string, maximum: number) {
  if (value.length < 1 || value.length > maximum) {
    throw new TypeError(`${label} is invalid`);
  }
}

function parseEvent(payload: string) {
  let event: unknown;
  try {
    event = JSON.parse(payload);
  } catch {
    throw new TypeError("Stored notification event is invalid");
  }
  if (!isNotificationEvent(event)) {
    throw new TypeError("Stored notification event is invalid");
  }
  return event;
}

function isNotificationEvent(value: unknown): value is NotificationEvent {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Record<string, unknown>;
  const source = event.source;
  if (
    typeof source !== "object" ||
    source === null ||
    ((source as Record<string, unknown>).kind !== "incident" &&
      (source as Record<string, unknown>).kind !== "maintenance")
  ) {
    return false;
  }
  const typedSource = source as Record<string, unknown>;
  if (
    event.schemaVersion === "1.0.0" &&
    typeof event.eventId === "string" &&
    /^evt_[a-f0-9]{64}$/.test(event.eventId) &&
    typeof event.siteId === "string" &&
    /^[a-z0-9-]{1,80}$/.test(event.siteId) &&
    typeof typedSource.slug === "string" &&
    /^[a-z0-9-]{1,120}$/.test(typedSource.slug) &&
    Number.isSafeInteger(typedSource.revision) &&
    Number(typedSource.revision) >= 1 &&
    (typedSource.updateId === undefined ||
      (typeof typedSource.updateId === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(typedSource.updateId))) &&
    typeof event.type === "string" &&
    typeof event.contentRevision === "string" &&
    /^[a-f0-9]{64}$/.test(event.contentRevision) &&
    event.templateRevision === "1" &&
    typeof event.title === "string" &&
    event.title.trim().length > 0 &&
    event.title.length <= 200 &&
    typeof event.message === "string" &&
    event.message.trim().length > 0 &&
    event.message.length <= 10_000 &&
    typeof event.publishedAt === "string" &&
    Number.isFinite(Date.parse(event.publishedAt))
  ) {
    const type = event.type as NotificationEventType;
    if (typedSource.kind === "incident") return INCIDENT_TYPES.has(type);
    return (
      MAINTENANCE_TYPES.has(type) &&
      typeof event.startsAt === "string" &&
      typeof event.endsAt === "string" &&
      Number.isFinite(Date.parse(event.startsAt)) &&
      Number.isFinite(Date.parse(event.endsAt)) &&
      Date.parse(event.startsAt) < Date.parse(event.endsAt)
    );
  }
  return false;
}

function eventSelect(database: DatabasePort, eventId: string) {
  return database
    .prepare(
      `SELECT event_id, site_id, event_type, payload_json, audience_cutoff_at, created_at,
        expansion_after_confirmed_at, expansion_after_email_key, expanded_at
      FROM notification_events WHERE event_id = ?1`,
    )
    .bind(eventId);
}

export class D1NotificationRepository {
  constructor(private readonly database: DatabasePort) {}

  async createEvent(
    event: NotificationEvent,
    audienceCutoffAt: string,
    createdAt: string,
  ): Promise<"created" | "existing" | "conflict"> {
    requireTimestamp(audienceCutoffAt, "Audience cutoff");
    requireTimestamp(createdAt, "Event creation time");
    const payload = JSON.stringify(event);
    const existing = await eventSelect(this.database, event.eventId).first<EventRow>();
    if (existing) {
      return existing.payload_json === payload && existing.audience_cutoff_at === audienceCutoffAt
        ? "existing"
        : "conflict";
    }
    if (!isNotificationEvent(event)) throw new TypeError("Notification event is invalid");

    const result = await this.database.batch([
      this.database
        .prepare(
          `INSERT INTO notification_events (
            event_id, site_id, event_type, payload_json, audience_cutoff_at, created_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
          ON CONFLICT(event_id) DO NOTHING`,
        )
        .bind(event.eventId, event.siteId, event.type, payload, audienceCutoffAt, createdAt),
    ]);
    if (result[0]?.meta.changes === 1) return "created";

    const raced = await eventSelect(this.database, event.eventId).first<EventRow>();
    return raced?.payload_json === payload && raced.audience_cutoff_at === audienceCutoffAt
      ? "existing"
      : "conflict";
  }

  async expandAudience(
    eventId: string,
    expandedAt: string,
    limit = 100,
  ): Promise<{ created: number; complete: boolean }> {
    requireIdentifier(eventId, "Event ID", 80);
    requireTimestamp(expandedAt, "Audience expansion time");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new TypeError("Audience page limit must be an integer from 1 to 500");
    }
    const event = await eventSelect(this.database, eventId).first<EventRow>();
    if (!event) throw new Error("Notification event was not found");
    if (event.expanded_at !== null) return { created: 0, complete: true };

    const audience = await this.database
      .prepare(
        `SELECT email_key, normalized_email, token_version, confirmed_at
        FROM subscribers
        WHERE site_id = ?1 AND status = 'active' AND confirmed_at IS NOT NULL
          AND confirmed_at <= ?2
          AND (
            ?3 IS NULL OR confirmed_at > ?3
            OR (confirmed_at = ?3 AND email_key > ?4)
          )
        ORDER BY confirmed_at, email_key
        LIMIT ?5`,
      )
      .bind(
        event.site_id,
        event.audience_cutoff_at,
        event.expansion_after_confirmed_at,
        event.expansion_after_email_key,
        limit,
      )
      .all<AudienceRow>();

    if (audience.results.length === 0) {
      const completed = await this.database.batch([
        this.database
          .prepare(
            `UPDATE notification_events SET expanded_at = ?1
            WHERE event_id = ?2 AND expanded_at IS NULL
              AND expansion_after_confirmed_at IS ?3
              AND expansion_after_email_key IS ?4`,
          )
          .bind(
            expandedAt,
            eventId,
            event.expansion_after_confirmed_at,
            event.expansion_after_email_key,
          ),
      ]);
      if (completed[0]?.meta.changes !== 1) return { created: 0, complete: false };
      return { created: 0, complete: true };
    }

    const last = audience.results.at(-1);
    if (!last) throw new Error("Audience page unexpectedly became empty");
    const statements = audience.results.map((subscriber) =>
      this.database
        .prepare(
          `INSERT INTO notification_deliveries (
            event_id, site_id, email_key, normalized_email, subscriber_token_version, created_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
          ON CONFLICT(event_id, email_key) DO NOTHING`,
        )
        .bind(
          event.event_id,
          event.site_id,
          subscriber.email_key,
          subscriber.normalized_email,
          subscriber.token_version,
          expandedAt,
        ),
    );
    statements.push(
      this.database
        .prepare(
          `UPDATE notification_events SET
            expansion_after_confirmed_at = ?1, expansion_after_email_key = ?2
          WHERE event_id = ?3 AND expanded_at IS NULL
            AND expansion_after_confirmed_at IS ?4
            AND expansion_after_email_key IS ?5`,
        )
        .bind(
          last.confirmed_at,
          last.email_key,
          eventId,
          event.expansion_after_confirmed_at,
          event.expansion_after_email_key,
        ),
    );
    const results = await this.database.batch(statements);
    const cursorMoved = results.at(-1)?.meta.changes === 1;
    if (!cursorMoved) return { created: 0, complete: false };
    return {
      created: results.slice(0, -1).reduce((count, result) => count + result.meta.changes, 0),
      complete: false,
    };
  }

  async listExpandableEventIds(siteId: string, limit = 10) {
    requireIdentifier(siteId, "Site ID", 80);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw new TypeError("Expandable event limit must be an integer from 1 to 50");
    }
    const rows = await this.database
      .prepare(
        `SELECT event_id FROM notification_events
        WHERE site_id = ?1 AND expanded_at IS NULL
        ORDER BY created_at, event_id LIMIT ?2`,
      )
      .bind(siteId, limit)
      .all<ExpandableEventRow>();
    return rows.results.map((row) => row.event_id);
  }

  async enqueuePending(siteId: string, queue: NotificationQueue, enqueuedAt: string, limit = 25) {
    requireIdentifier(siteId, "Site ID", 80);
    requireTimestamp(enqueuedAt, "Enqueue time");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError("Notification enqueue limit must be an integer from 1 to 100");
    }
    const enqueuedTime = Date.parse(enqueuedAt);
    const staleEnqueuedAt = new Date(enqueuedTime - 15 * 60 * 1000).toISOString();
    await this.database.batch([
      this.database
        .prepare(
          `UPDATE notification_deliveries SET state = 'cancelled', cancelled_at = ?1,
            cancellation_reason = 'subscriber_ineligible', claim_id = NULL,
            claimed_at = NULL, claim_expires_at = NULL
          WHERE site_id = ?2 AND state IN ('pending', 'enqueued', 'claimed', 'retry_wait')
            AND NOT EXISTS (
              SELECT 1 FROM subscribers
              WHERE subscribers.site_id = notification_deliveries.site_id
                AND subscribers.email_key = notification_deliveries.email_key
                AND subscribers.status = 'active'
                AND subscribers.token_version = notification_deliveries.subscriber_token_version
            )`,
        )
        .bind(enqueuedAt, siteId),
      this.database
        .prepare(
          `UPDATE notification_deliveries SET state = 'pending', enqueued_at = NULL,
            claim_id = NULL, claimed_at = NULL, claim_expires_at = NULL, retry_at = NULL
          WHERE site_id = ?1 AND (
            (state = 'claimed' AND claim_expires_at <= ?2)
            OR (state = 'enqueued' AND enqueued_at <= ?3)
            OR (state = 'retry_wait' AND retry_at <= ?2)
          )`,
        )
        .bind(siteId, enqueuedAt, staleEnqueuedAt),
    ]);
    const pending = await this.database
      .prepare(
        `SELECT event_id, site_id, email_key FROM notification_deliveries
        WHERE site_id = ?1 AND state = 'pending'
        ORDER BY created_at, event_id, email_key LIMIT ?2`,
      )
      .bind(siteId, limit)
      .all<PendingRow>();

    let enqueued = 0;
    for (const row of pending.results) {
      const message: NotificationQueueMessage = {
        schemaVersion: "1.0.0",
        kind: "notification",
        siteId: row.site_id,
        eventId: row.event_id,
        emailKey: row.email_key,
      };
      await queue.send(message, { contentType: "json" });
      const marked = await this.database.batch([
        this.database
          .prepare(
            `UPDATE notification_deliveries SET state = 'enqueued', enqueued_at = ?1
            WHERE event_id = ?2 AND email_key = ?3 AND site_id = ?4 AND state = 'pending'`,
          )
          .bind(enqueuedAt, row.event_id, row.email_key, row.site_id),
      ]);
      if (marked[0]?.meta.changes === 1) enqueued += 1;
    }
    return enqueued;
  }

  async claim(
    message: NotificationQueueMessage,
    claimId: string,
    claimedAt: string,
    leaseSeconds = 300,
  ): Promise<ClaimedNotification | null> {
    this.assertMessage(message);
    requireIdentifier(claimId, "Claim ID", 160);
    requireTimestamp(claimedAt, "Claim time");
    if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 900) {
      throw new TypeError("Notification claim lease must be an integer from 30 to 900 seconds");
    }
    const claimExpiresAt = new Date(Date.parse(claimedAt) + leaseSeconds * 1000).toISOString();
    const results = await this.database.batch<ClaimedRow>([
      this.database
        .prepare(
          `UPDATE notification_deliveries SET state = 'claimed', claim_id = ?1,
            claimed_at = ?2, claim_expires_at = ?3, attempt_count = attempt_count + 1
          WHERE event_id = ?4 AND email_key = ?5 AND site_id = ?6
            AND (state IN ('pending', 'enqueued')
              OR (state = 'claimed' AND (claim_id = ?1 OR claim_expires_at <= ?2)))
            AND EXISTS (
              SELECT 1 FROM subscribers
              WHERE subscribers.site_id = notification_deliveries.site_id
                AND subscribers.email_key = notification_deliveries.email_key
                AND subscribers.status = 'active'
                AND subscribers.token_version = notification_deliveries.subscriber_token_version
            )`,
        )
        .bind(
          claimId,
          claimedAt,
          claimExpiresAt,
          message.eventId,
          message.emailKey,
          message.siteId,
        ),
      this.database
        .prepare(
          `SELECT d.event_id, d.site_id, d.email_key, d.normalized_email,
            d.subscriber_token_version, d.claim_id, d.claim_expires_at, d.attempt_count,
            e.payload_json
          FROM notification_deliveries d
          JOIN notification_events e ON e.event_id = d.event_id
          WHERE d.event_id = ?1 AND d.email_key = ?2 AND d.site_id = ?3
            AND d.state = 'claimed' AND d.claim_id = ?4`,
        )
        .bind(message.eventId, message.emailKey, message.siteId, claimId),
      this.database
        .prepare(
          `UPDATE notification_deliveries SET state = 'cancelled', cancelled_at = ?1,
            cancellation_reason = 'subscriber_ineligible', claim_id = NULL,
            claimed_at = NULL, claim_expires_at = NULL
          WHERE event_id = ?2 AND email_key = ?3 AND site_id = ?4
            AND state IN ('pending', 'enqueued', 'claimed', 'retry_wait')
            AND NOT EXISTS (
              SELECT 1 FROM subscribers
              WHERE subscribers.site_id = notification_deliveries.site_id
                AND subscribers.email_key = notification_deliveries.email_key
                AND subscribers.status = 'active'
                AND subscribers.token_version = notification_deliveries.subscriber_token_version
            )`,
        )
        .bind(claimedAt, message.eventId, message.emailKey, message.siteId),
    ]);
    if (results[0]?.meta.changes !== 1) return null;
    const row = results[1]?.results[0];
    if (!row) throw new Error("Claimed notification delivery is missing");
    return {
      event: parseEvent(row.payload_json),
      siteId: row.site_id,
      eventId: row.event_id,
      emailKey: row.email_key,
      normalizedEmail: row.normalized_email,
      subscriberTokenVersion: row.subscriber_token_version,
      claimId: row.claim_id,
      claimExpiresAt: row.claim_expires_at,
      attemptCount: row.attempt_count,
    };
  }

  async markSent(
    eventId: string,
    emailKey: string,
    claimId: string,
    providerMessageId: string,
    sentAt: string,
  ) {
    requireIdentifier(providerMessageId, "Provider message ID", 256);
    requireTimestamp(sentAt, "Sent time");
    const result = await this.updateClaimed(
      eventId,
      emailKey,
      claimId,
      `state = 'sent', sent_at = ?1, provider_message_id = ?2,
        claim_id = NULL, claimed_at = NULL, claim_expires_at = NULL`,
      [sentAt, providerMessageId],
    );
    return result;
  }

  async markFailed(
    eventId: string,
    emailKey: string,
    claimId: string,
    failureCode: string,
    failedAt: string,
    retryAt?: string,
  ) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(failureCode)) {
      throw new TypeError("Failure code is invalid");
    }
    requireTimestamp(failedAt, "Failure time");
    if (retryAt !== undefined) requireTimestamp(retryAt, "Retry time");
    return this.updateClaimed(
      eventId,
      emailKey,
      claimId,
      `state = ?1, failed_at = ?2, failure_code = ?3, retry_at = ?4,
        claim_id = NULL, claimed_at = NULL, claim_expires_at = NULL`,
      [retryAt === undefined ? "failed" : "retry_wait", failedAt, failureCode, retryAt ?? null],
    );
  }

  async cancel(eventId: string, emailKey: string, reason: string, cancelledAt: string) {
    requireIdentifier(eventId, "Event ID", 80);
    requireIdentifier(emailKey, "Email key", 256);
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(reason)) {
      throw new TypeError("Cancellation reason is invalid");
    }
    requireTimestamp(cancelledAt, "Cancellation time");
    const result = await this.database.batch([
      this.database
        .prepare(
          `UPDATE notification_deliveries SET state = 'cancelled', cancelled_at = ?1,
            cancellation_reason = ?2, claim_id = NULL, claimed_at = NULL,
            claim_expires_at = NULL, retry_at = NULL
          WHERE event_id = ?3 AND email_key = ?4
            AND state IN ('pending', 'enqueued', 'claimed', 'retry_wait')`,
        )
        .bind(cancelledAt, reason, eventId, emailKey),
    ]);
    return result[0]?.meta.changes === 1;
  }

  private assertMessage(message: NotificationQueueMessage) {
    if (message.schemaVersion !== "1.0.0" || message.kind !== "notification") {
      throw new TypeError("Notification queue message is invalid");
    }
    requireIdentifier(message.siteId, "Message site ID", 80);
    requireIdentifier(message.eventId, "Message event ID", 80);
    requireIdentifier(message.emailKey, "Message email key", 256);
  }

  private async updateClaimed(
    eventId: string,
    emailKey: string,
    claimId: string,
    assignments: string,
    values: unknown[],
  ) {
    requireIdentifier(eventId, "Event ID", 80);
    requireIdentifier(emailKey, "Email key", 256);
    requireIdentifier(claimId, "Claim ID", 160);
    const eventIndex = values.length + 1;
    const emailIndex = values.length + 2;
    const claimIndex = values.length + 3;
    const result = await this.database.batch([
      this.database
        .prepare(
          `UPDATE notification_deliveries SET ${assignments}
          WHERE event_id = ?${eventIndex} AND email_key = ?${emailIndex}
            AND state = 'claimed' AND claim_id = ?${claimIndex}`,
        )
        .bind(...values, eventId, emailKey, claimId),
    ]);
    return result[0]?.meta.changes === 1;
  }
}

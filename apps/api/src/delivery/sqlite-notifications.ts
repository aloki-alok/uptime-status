import type { Database } from "bun:sqlite";
import type { Incident, Maintenance } from "@uptime-status/domain";

type NoticeKind = "incident" | "maintenance";
type Notice = Incident | Maintenance;

type PendingIntent = {
  site_id: string;
  kind: NoticeKind;
  slug: string;
  revision: number;
  body: string;
};

type DeliveryRow = {
  site_id: string;
  kind: NoticeKind;
  slug: string;
  revision: number;
  email_key: string;
  subscriber_token_version: number;
  normalized_email: string;
  attempts: number;
  body: string;
};

export type ClaimedDelivery = {
  siteId: string;
  kind: NoticeKind;
  slug: string;
  revision: number;
  emailKey: string;
  subscriberTokenVersion: number;
  normalizedEmail: string;
  attempts: number;
  notice: Notice;
  claimId: string;
};

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS notification_intents(
    site_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('incident', 'maintenance')),
    slug TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision >= 1),
    action TEXT NOT NULL,
    update_id TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(site_id, kind, slug, revision)
  );
  CREATE TABLE IF NOT EXISTS notification_intent_progress(
    site_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    slug TEXT NOT NULL,
    revision INTEGER NOT NULL,
    expanded_at TEXT NOT NULL,
    PRIMARY KEY(site_id, kind, slug, revision)
  );
  CREATE TABLE IF NOT EXISTS notification_deliveries(
    site_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    slug TEXT NOT NULL,
    revision INTEGER NOT NULL,
    email_key TEXT NOT NULL,
    normalized_email TEXT NOT NULL,
    subscriber_token_version INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending', 'sending', 'sent', 'failed', 'cancelled')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    claim_id TEXT,
    claim_until TEXT,
    provider_message_id TEXT,
    sent_at TEXT,
    error_code TEXT,
    PRIMARY KEY(site_id, kind, slug, revision, email_key)
  );
  CREATE INDEX IF NOT EXISTS notification_deliveries_due
    ON notification_deliveries(state, next_attempt_at);
`;

export class SqliteNotificationRepository {
  constructor(private readonly db: Database) {
    db.exec(SCHEMA);
    db.exec("PRAGMA busy_timeout = 5000;");
  }

  expandNext(siteId: string, now: string) {
    return this.db
      .transaction(() => {
        const intent = this.db
          .query(
            `SELECT i.site_id, i.kind, i.slug, i.revision, i.body
             FROM notification_intents i
             LEFT JOIN notification_intent_progress p
               ON p.site_id = i.site_id AND p.kind = i.kind
              AND p.slug = i.slug AND p.revision = i.revision
             WHERE i.site_id = ? AND p.site_id IS NULL
             ORDER BY i.created_at, i.kind, i.slug LIMIT 1`,
          )
          .get(siteId) as PendingIntent | null;
        if (!intent) return false;
        this.db.run(
          `INSERT INTO notification_deliveries(
             site_id, kind, slug, revision, email_key, normalized_email,
             subscriber_token_version, state, next_attempt_at
           ) SELECT ?, ?, ?, ?, email_key, normalized_email,
                    json_extract(body, '$.tokenVersion'), 'pending', ?
             FROM subscribers WHERE site_id = ? AND status = 'active'
           ON CONFLICT(site_id, kind, slug, revision, email_key) DO NOTHING`,
          [siteId, intent.kind, intent.slug, intent.revision, now, siteId],
        );
        this.db.run(
          "INSERT INTO notification_intent_progress(site_id, kind, slug, revision, expanded_at) VALUES (?, ?, ?, ?, ?)",
          [siteId, intent.kind, intent.slug, intent.revision, now],
        );
        return true;
      })
      .immediate();
  }

  claimNext(siteId: string, now: string): ClaimedDelivery | null {
    return this.db
      .transaction(() => {
        const row = this.db
          .query(
            `SELECT d.site_id, d.kind, d.slug, d.revision, d.email_key,
                    d.subscriber_token_version, d.normalized_email, d.attempts, i.body
             FROM notification_deliveries d JOIN notification_intents i
               ON i.site_id = d.site_id AND i.kind = d.kind
              AND i.slug = d.slug AND i.revision = d.revision
             WHERE d.site_id = ? AND d.attempts < 5 AND
               ((d.state = 'pending' AND d.next_attempt_at <= ?)
                 OR (d.state = 'sending' AND d.claim_until < ?))
             ORDER BY d.next_attempt_at, d.slug, d.email_key LIMIT 1`,
          )
          .get(siteId, now, now) as DeliveryRow | null;
        if (!row) return null;
        const claimId = crypto.randomUUID();
        const claimUntil = new Date(Date.parse(now) + 120_000).toISOString();
        this.db.run(
          `UPDATE notification_deliveries SET state = 'sending', claim_id = ?,
             claim_until = ?, attempts = attempts + 1
           WHERE site_id = ? AND kind = ? AND slug = ? AND revision = ? AND email_key = ?`,
          [claimId, claimUntil, row.site_id, row.kind, row.slug, row.revision, row.email_key],
        );
        return {
          siteId: row.site_id,
          kind: row.kind,
          slug: row.slug,
          revision: row.revision,
          emailKey: row.email_key,
          subscriberTokenVersion: row.subscriber_token_version,
          normalizedEmail: row.normalized_email,
          attempts: row.attempts + 1,
          notice: JSON.parse(row.body) as Notice,
          claimId,
        };
      })
      .immediate();
  }

  markSent(delivery: ClaimedDelivery, providerMessageId: string, now: string) {
    return this.finish(delivery, "sent", now, providerMessageId);
  }

  cancel(delivery: ClaimedDelivery, now: string) {
    return this.finish(delivery, "cancelled", now);
  }

  fail(delivery: ClaimedDelivery, now: string, retryable: boolean) {
    const retryAt = new Date(
      Date.parse(now) + Math.min(3600, 60 * 2 ** delivery.attempts) * 1000,
    ).toISOString();
    const state = retryable && delivery.attempts < 5 ? "pending" : "failed";
    return (
      this.db.run(
        `UPDATE notification_deliveries SET state = ?, next_attempt_at = ?,
           claim_id = NULL, claim_until = NULL, error_code = 'delivery_failed'
         WHERE site_id = ? AND kind = ? AND slug = ? AND revision = ?
           AND email_key = ? AND state = 'sending' AND claim_id = ?`,
        [
          state,
          retryAt,
          delivery.siteId,
          delivery.kind,
          delivery.slug,
          delivery.revision,
          delivery.emailKey,
          delivery.claimId,
        ],
      ).changes === 1
    );
  }

  private finish(
    delivery: ClaimedDelivery,
    state: "sent" | "cancelled",
    now: string,
    providerMessageId: string | null = null,
  ) {
    return (
      this.db.run(
        `UPDATE notification_deliveries SET state = ?, claim_id = NULL,
           claim_until = NULL, provider_message_id = ?, sent_at = ?
         WHERE site_id = ? AND kind = ? AND slug = ? AND revision = ?
           AND email_key = ? AND state = 'sending' AND claim_id = ?`,
        [
          state,
          providerMessageId,
          state === "sent" ? now : null,
          delivery.siteId,
          delivery.kind,
          delivery.slug,
          delivery.revision,
          delivery.emailKey,
          delivery.claimId,
        ],
      ).changes === 1
    );
  }
}

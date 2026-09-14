import type { Database } from "bun:sqlite";
import type {
  ConfirmationOutboxRecord,
  SubscriberRecord,
  SubscriptionCommit,
  SubscriptionCommitResult,
  SubscriptionRepository,
} from "./repository";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS subscribers (
    site_id TEXT NOT NULL,
    email_key TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision >= 1),
    status TEXT NOT NULL CHECK(status IN ('pending', 'active', 'unsubscribed', 'suppressed')),
    normalized_email TEXT NOT NULL,
    body TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(site_id, email_key)
  );
  CREATE TABLE IF NOT EXISTS confirmation_outbox (
    outbox_id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL,
    email_key TEXT NOT NULL,
    token_version INTEGER NOT NULL,
    normalized_email TEXT NOT NULL,
    token TEXT NOT NULL,
    created_at TEXT NOT NULL,
    disposition TEXT NOT NULL DEFAULT 'pending' CHECK(disposition IN ('pending', 'sent', 'skipped', 'failed')),
    sent_at TEXT,
    provider_message_id TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS confirmation_outbox_pending
    ON confirmation_outbox(next_attempt_at, created_at) WHERE disposition = 'pending';
  CREATE TABLE IF NOT EXISTS subscription_rate_limits (
    bucket_key TEXT PRIMARY KEY,
    window_start INTEGER NOT NULL,
    attempts INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS subscribers_active
    ON subscribers(site_id, email_key) WHERE status = 'active';
`;

type StoredRecord = { body: string };

function decode(row: StoredRecord | null): SubscriberRecord | null {
  return row ? (JSON.parse(row.body) as SubscriberRecord) : null;
}

export class SqliteSubscriptionRepository implements SubscriptionRepository {
  constructor(private readonly db: Database) {
    db.exec(SCHEMA);
    db.exec("PRAGMA busy_timeout = 5000;");
  }

  async get(siteId: string, emailKey: string) {
    return decode(
      this.db
        .query("SELECT body FROM subscribers WHERE site_id = ? AND email_key = ?")
        .get(siteId, emailKey) as StoredRecord | null,
    );
  }

  async commit(input: SubscriptionCommit): Promise<SubscriptionCommitResult> {
    return this.db
      .transaction(() => {
        const current = decode(
          this.db
            .query("SELECT body FROM subscribers WHERE site_id = ? AND email_key = ?")
            .get(input.record.siteId, input.record.emailKey) as StoredRecord | null,
        );
        if ((current?.revision ?? null) !== input.expectedRevision) {
          return { committed: false as const, current };
        }

        const record = structuredClone(input.record);
        if (current) {
          this.db.run(
            "UPDATE subscribers SET revision = ?, status = ?, normalized_email = ?, body = ?, updated_at = ? WHERE site_id = ? AND email_key = ?",
            [
              record.revision,
              record.status,
              record.normalizedEmail,
              JSON.stringify(record),
              record.updatedAt,
              record.siteId,
              record.emailKey,
            ],
          );
        } else {
          this.db.run(
            "INSERT INTO subscribers(site_id, email_key, revision, status, normalized_email, body, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [
              record.siteId,
              record.emailKey,
              record.revision,
              record.status,
              record.normalizedEmail,
              JSON.stringify(record),
              record.updatedAt,
            ],
          );
        }
        if (input.outbox) {
          this.db.run(
            "INSERT INTO confirmation_outbox(outbox_id, site_id, email_key, token_version, normalized_email, token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [
              input.outbox.outboxId,
              input.outbox.siteId,
              input.outbox.emailKey,
              input.outbox.tokenVersion,
              input.outbox.normalizedEmail,
              input.outbox.token,
              input.outbox.createdAt,
            ],
          );
        }
        return { committed: true as const, record };
      })
      .immediate();
  }

  pendingConfirmations(limit: number, now = new Date().toISOString()): ConfirmationOutboxRecord[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Confirmation batch size must be between 1 and 100");
    }
    return this.db
      .query(
        "SELECT outbox_id, site_id, email_key, normalized_email, token, token_version, created_at FROM confirmation_outbox WHERE disposition = 'pending' AND next_attempt_at <= ? ORDER BY created_at, outbox_id LIMIT ?",
      )
      .all(now, limit)
      .map((row) => {
        const item = row as Record<string, string | number>;
        return {
          kind: "subscription-confirmation" as const,
          outboxId: String(item.outbox_id),
          siteId: String(item.site_id),
          emailKey: String(item.email_key),
          normalizedEmail: String(item.normalized_email),
          token: String(item.token),
          tokenVersion: Number(item.token_version),
          createdAt: String(item.created_at),
        };
      });
  }

  markConfirmationSent(outboxId: string, providerMessageId: string, sentAt: string) {
    return (
      this.db.run(
        "UPDATE confirmation_outbox SET disposition = 'sent', sent_at = ?, provider_message_id = ?, token = '', attempts = attempts + 1 WHERE outbox_id = ? AND disposition = 'pending'",
        [sentAt, providerMessageId, outboxId],
      ).changes === 1
    );
  }

  markConfirmationSkipped(outboxId: string) {
    return (
      this.db.run(
        "UPDATE confirmation_outbox SET disposition = 'skipped', token = '' WHERE outbox_id = ? AND disposition = 'pending'",
        [outboxId],
      ).changes === 1
    );
  }

  failConfirmation(outboxId: string, now: string, retryable: boolean) {
    return this.db
      .transaction(() => {
        const row = this.db
          .query(
            "SELECT attempts FROM confirmation_outbox WHERE outbox_id = ? AND disposition = 'pending'",
          )
          .get(outboxId) as { attempts: number } | null;
        if (!row) return false;
        const attempts = row.attempts + 1;
        const nextAttempt = new Date(
          Date.parse(now) + Math.min(3600, 60 * 2 ** attempts) * 1000,
        ).toISOString();
        return (
          this.db.run(
            "UPDATE confirmation_outbox SET attempts = ?, next_attempt_at = ?, disposition = ? WHERE outbox_id = ? AND disposition = 'pending'",
            [attempts, nextAttempt, retryable && attempts < 5 ? "pending" : "failed", outboxId],
          ).changes === 1
        );
      })
      .immediate();
  }

  activeSubscriber(siteId: string, emailKey: string) {
    const row = this.db
      .query(
        "SELECT body FROM subscribers WHERE site_id = ? AND email_key = ? AND status = 'active'",
      )
      .get(siteId, emailKey) as StoredRecord | null;
    return decode(row);
  }

  consumeRateLimit(bucketKey: string, nowSeconds: number, windowSeconds: number, limit: number) {
    return this.db
      .transaction(() => {
        const current = this.db
          .query("SELECT window_start, attempts FROM subscription_rate_limits WHERE bucket_key = ?")
          .get(bucketKey) as { window_start: number; attempts: number } | null;
        const windowStart = Math.floor(nowSeconds / windowSeconds) * windowSeconds;
        if (!current || current.window_start !== windowStart) {
          this.db.run(
            "INSERT INTO subscription_rate_limits(bucket_key, window_start, attempts) VALUES (?, ?, 1) ON CONFLICT(bucket_key) DO UPDATE SET window_start = excluded.window_start, attempts = 1",
            [bucketKey, windowStart],
          );
          return true;
        }
        if (current.attempts >= limit) return false;
        this.db.run(
          "UPDATE subscription_rate_limits SET attempts = attempts + 1 WHERE bucket_key = ?",
          [bucketKey],
        );
        return true;
      })
      .immediate();
  }
}

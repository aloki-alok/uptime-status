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
    sent_at TEXT,
    attempts INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS confirmation_outbox_pending
    ON confirmation_outbox(created_at) WHERE sent_at IS NULL;
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
    return this.db.transaction(() => {
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
    })();
  }

  pendingConfirmations(limit: number): ConfirmationOutboxRecord[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Confirmation batch size must be between 1 and 100");
    }
    return this.db
      .query(
        "SELECT outbox_id, site_id, email_key, normalized_email, token, token_version, created_at FROM confirmation_outbox WHERE sent_at IS NULL ORDER BY created_at, outbox_id LIMIT ?",
      )
      .all(limit)
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

  markConfirmationSent(outboxId: string, sentAt: string) {
    return (
      this.db.run(
        "UPDATE confirmation_outbox SET sent_at = ?, token = '', attempts = attempts + 1 WHERE outbox_id = ? AND sent_at IS NULL",
        [sentAt, outboxId],
      ).changes === 1
    );
  }
}

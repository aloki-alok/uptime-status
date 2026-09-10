import type {
  ConfirmationOutboxRecord,
  SubscriberRecord,
  SubscriptionCommit,
  SubscriptionCommitResult,
  SubscriptionRepository,
} from "@uptime-status/api/subscriptions/repository";
import type { SubscriberStatus } from "@uptime-status/domain/subscription";
import type { ConfirmationOutboxCipher, ConfirmationPayloadIdentity } from "./outbox-crypto";

export type DatabaseResult<T = unknown> = {
  results: T[];
  meta: { changes: number };
};

export interface DatabaseStatement {
  bind(...values: unknown[]): DatabaseStatement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<DatabaseResult<T>>;
}

export interface DatabasePort {
  prepare(query: string): DatabaseStatement;
  batch<T>(statements: DatabaseStatement[]): Promise<DatabaseResult<T>[]>;
}

class CloudflareStatement implements DatabaseStatement {
  constructor(readonly statement: D1PreparedStatement) {}

  bind(...values: unknown[]) {
    return new CloudflareStatement(this.statement.bind(...values));
  }

  first<T>() {
    return this.statement.first<T>();
  }

  all<T>() {
    return this.statement.all<T>();
  }
}

export function cloudflareDatabase(database: D1Database): DatabasePort {
  return {
    prepare(query) {
      return new CloudflareStatement(database.prepare(query));
    },
    async batch<T>(statements: DatabaseStatement[]) {
      const native = statements.map((statement) => {
        if (!(statement instanceof CloudflareStatement)) {
          throw new TypeError("Cloudflare D1 batches require Cloudflare prepared statements");
        }
        return statement.statement;
      });
      return database.batch<T>(native);
    },
  };
}

export type SubscriptionQueueMessage = {
  schemaVersion: "1.0.0";
  kind: "subscription-confirmation";
  outboxId: string;
  siteId: string;
};

export interface SubscriptionQueue {
  send(message: SubscriptionQueueMessage, options: { contentType: "json" }): Promise<unknown>;
}

export type ClaimedConfirmation = ConfirmationOutboxRecord & {
  claimId: string;
  claimExpiresAt: string;
  attemptCount: number;
};

export type SuppressionReason = "bounce" | "complaint";

type SubscriberRow = {
  site_id: string;
  email_key: string;
  normalized_email: string;
  status: SubscriberStatus;
  revision: number;
  token_version: number;
  confirmation_token_hash: string | null;
  confirmation_expires_at: string | null;
  confirmation_sent_at: string | null;
  confirmed_at: string | null;
  unsubscribed_at: string | null;
  suppressed_at: string | null;
  suppression_reason: string | null;
  created_at: string;
  updated_at: string;
};

type OutboxRow = {
  outbox_id: string;
  site_id: string;
  email_key: string;
  kind: "subscription-confirmation";
  token_version: number;
  created_at: string;
  payload_key_version: number;
  payload_nonce: string;
  payload_ciphertext: string;
  claim_id: string;
  claim_expires_at: string;
  attempt_count: number;
};

type PendingOutboxRow = Pick<OutboxRow, "outbox_id" | "site_id">;

const STATUSES = new Set<SubscriberStatus>(["pending", "active", "unsubscribed", "suppressed"]);

function optionalText(value: unknown) {
  if (value === null || typeof value === "string") return value;
  throw new TypeError("Stored subscriber data is invalid");
}

function subscriberFromRow(row: SubscriberRow | null): SubscriberRecord | null {
  if (row === null) return null;
  if (
    typeof row.site_id !== "string" ||
    typeof row.email_key !== "string" ||
    typeof row.normalized_email !== "string" ||
    !STATUSES.has(row.status) ||
    !Number.isSafeInteger(row.revision) ||
    !Number.isSafeInteger(row.token_version) ||
    typeof row.created_at !== "string" ||
    typeof row.updated_at !== "string"
  ) {
    throw new TypeError("Stored subscriber data is invalid");
  }
  return {
    siteId: row.site_id,
    emailKey: row.email_key,
    normalizedEmail: row.normalized_email,
    status: row.status,
    revision: row.revision,
    tokenVersion: row.token_version,
    confirmationTokenHash: optionalText(row.confirmation_token_hash),
    confirmationExpiresAt: optionalText(row.confirmation_expires_at),
    confirmationSentAt: optionalText(row.confirmation_sent_at),
    confirmedAt: optionalText(row.confirmed_at),
    unsubscribedAt: optionalText(row.unsubscribed_at),
    suppressedAt: optionalText(row.suppressed_at),
    suppressionReason: optionalText(row.suppression_reason),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function subscriberValues(record: SubscriberRecord, commitId: string) {
  return [
    record.siteId,
    record.emailKey,
    record.normalizedEmail,
    record.status,
    record.revision,
    record.tokenVersion,
    record.confirmationTokenHash,
    record.confirmationExpiresAt,
    record.confirmationSentAt,
    record.confirmedAt,
    record.unsubscribedAt,
    record.suppressedAt,
    record.suppressionReason,
    record.createdAt,
    record.updatedAt,
    commitId,
  ];
}

function outboxIdentity(outbox: ConfirmationOutboxRecord): ConfirmationPayloadIdentity {
  return {
    outboxId: outbox.outboxId,
    siteId: outbox.siteId,
    emailKey: outbox.emailKey,
    tokenVersion: outbox.tokenVersion,
    createdAt: outbox.createdAt,
  };
}

function assertCommit(input: SubscriptionCommit) {
  const expectedRevision = input.expectedRevision;
  if (
    (expectedRevision === null && input.record.revision !== 1) ||
    (expectedRevision !== null && input.record.revision !== expectedRevision + 1)
  ) {
    throw new TypeError("Subscriber revisions must advance exactly once per commit");
  }
  if (
    input.outbox &&
    (input.outbox.siteId !== input.record.siteId ||
      input.outbox.emailKey !== input.record.emailKey ||
      input.outbox.tokenVersion !== input.record.tokenVersion)
  ) {
    throw new TypeError("Confirmation outbox identity must match the subscriber commit");
  }
}

function subscriberSelect(database: DatabasePort, siteId: string, emailKey: string) {
  return database
    .prepare(
      `SELECT site_id, email_key, normalized_email, status, revision, token_version,
        confirmation_token_hash, confirmation_expires_at, confirmation_sent_at, confirmed_at,
        unsubscribed_at, suppressed_at, suppression_reason, created_at, updated_at
      FROM subscribers WHERE site_id = ?1 AND email_key = ?2`,
    )
    .bind(siteId, emailKey);
}

export class D1SubscriptionRepository implements SubscriptionRepository {
  constructor(
    private readonly database: DatabasePort,
    private readonly cipher: ConfirmationOutboxCipher,
  ) {}

  async get(siteId: string, emailKey: string) {
    return subscriberFromRow(await subscriberSelect(this.database, siteId, emailKey).first());
  }

  async commit(input: SubscriptionCommit): Promise<SubscriptionCommitResult> {
    assertCommit(input);
    const commitId = crypto.randomUUID();
    const values = subscriberValues(input.record, commitId);
    const subscriberStatement =
      input.expectedRevision === null
        ? this.database
            .prepare(
              `INSERT INTO subscribers (
                site_id, email_key, normalized_email, status, revision, token_version,
                confirmation_token_hash, confirmation_expires_at, confirmation_sent_at,
                confirmed_at, unsubscribed_at, suppressed_at, suppression_reason,
                created_at, updated_at, commit_id
              ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
              ON CONFLICT(site_id, email_key) DO NOTHING`,
            )
            .bind(...values)
        : this.database
            .prepare(
              `UPDATE subscribers SET
                normalized_email = ?3, status = ?4, revision = ?5, token_version = ?6,
                confirmation_token_hash = ?7, confirmation_expires_at = ?8,
                confirmation_sent_at = ?9, confirmed_at = ?10, unsubscribed_at = ?11,
                suppressed_at = ?12, suppression_reason = ?13, created_at = ?14,
                updated_at = ?15, commit_id = ?16
              WHERE site_id = ?1 AND email_key = ?2 AND revision = ?17`,
            )
            .bind(...values, input.expectedRevision);

    const statements: DatabaseStatement[] = [subscriberStatement];
    statements.push(
      this.database
        .prepare(
          `UPDATE confirmation_outbox SET state = 'cancelled', claim_id = NULL,
            claimed_at = NULL, claim_expires_at = NULL
          WHERE site_id = ?1 AND email_key = ?2 AND state IN ('pending', 'enqueued', 'claimed')
            AND (token_version <> ?3 OR ?4 <> 'pending')
            AND EXISTS (
              SELECT 1 FROM subscribers
              WHERE site_id = ?1 AND email_key = ?2 AND commit_id = ?5
            )`,
        )
        .bind(
          input.record.siteId,
          input.record.emailKey,
          input.record.tokenVersion,
          input.record.status,
          commitId,
        ),
    );

    if (input.outbox) {
      const encrypted = await this.cipher.encrypt(outboxIdentity(input.outbox), {
        normalizedEmail: input.outbox.normalizedEmail,
        token: input.outbox.token,
      });
      statements.push(
        this.database
          .prepare(
            `INSERT INTO confirmation_outbox (
              outbox_id, site_id, email_key, kind, token_version, created_at,
              payload_key_version, payload_nonce, payload_ciphertext
            )
            SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
            FROM subscribers
            WHERE site_id = ?2 AND email_key = ?3 AND commit_id = ?10`,
          )
          .bind(
            input.outbox.outboxId,
            input.outbox.siteId,
            input.outbox.emailKey,
            input.outbox.kind,
            input.outbox.tokenVersion,
            input.outbox.createdAt,
            encrypted.keyVersion,
            encrypted.nonce,
            encrypted.ciphertext,
            commitId,
          ),
      );
    }

    const results = await this.database.batch(statements);
    if (results[0]?.meta.changes === 1) return { committed: true, record: input.record };
    return {
      committed: false,
      current: await this.get(input.record.siteId, input.record.emailKey),
    };
  }

  async enqueuePending(siteId: string, queue: SubscriptionQueue, enqueuedAt: string, limit = 25) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError("Outbox enqueue limit must be an integer from 1 to 100");
    }
    const enqueuedTime = Date.parse(enqueuedAt);
    if (!Number.isFinite(enqueuedTime)) {
      throw new TypeError("Outbox enqueue time must be an ISO timestamp");
    }
    const staleEnqueuedAt = new Date(enqueuedTime - 15 * 60 * 1000).toISOString();
    await this.database.batch([
      this.database
        .prepare(
          `UPDATE confirmation_outbox SET state = 'pending', enqueued_at = NULL,
            claim_id = NULL, claimed_at = NULL, claim_expires_at = NULL
          WHERE site_id = ?1 AND (
            (state = 'claimed' AND claim_expires_at <= ?2)
            OR (state = 'enqueued' AND enqueued_at <= ?3)
          )`,
        )
        .bind(siteId, enqueuedAt, staleEnqueuedAt),
    ]);
    const pending = await this.database
      .prepare(
        `SELECT outbox_id, site_id FROM confirmation_outbox
        WHERE site_id = ?1 AND state = 'pending'
        ORDER BY created_at, outbox_id LIMIT ?2`,
      )
      .bind(siteId, limit)
      .all<PendingOutboxRow>();

    let enqueued = 0;
    for (const row of pending.results) {
      const message: SubscriptionQueueMessage = {
        schemaVersion: "1.0.0",
        kind: "subscription-confirmation",
        outboxId: row.outbox_id,
        siteId: row.site_id,
      };
      await queue.send(message, { contentType: "json" });
      const marked = await this.database.batch([
        this.database
          .prepare(
            `UPDATE confirmation_outbox SET state = 'enqueued', enqueued_at = ?1
            WHERE outbox_id = ?2 AND site_id = ?3 AND state = 'pending'`,
          )
          .bind(enqueuedAt, row.outbox_id, row.site_id),
      ]);
      if (marked[0]?.meta.changes === 1) enqueued += 1;
    }
    return enqueued;
  }

  async claim(
    message: SubscriptionQueueMessage,
    claimId: string,
    claimedAt: string,
    leaseSeconds = 300,
  ): Promise<ClaimedConfirmation | null> {
    if (
      message.schemaVersion !== "1.0.0" ||
      message.kind !== "subscription-confirmation" ||
      message.outboxId.length < 1 ||
      message.outboxId.length > 256 ||
      message.siteId.length < 1 ||
      message.siteId.length > 80
    ) {
      throw new TypeError("Subscription queue message is invalid");
    }
    if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 900) {
      throw new TypeError("Outbox claim lease must be an integer from 30 to 900 seconds");
    }
    const claimedTime = Date.parse(claimedAt);
    if (!Number.isFinite(claimedTime) || claimId.length < 1 || claimId.length > 160) {
      throw new TypeError("Outbox claim identity is invalid");
    }
    const claimExpiresAt = new Date(claimedTime + leaseSeconds * 1000).toISOString();
    const results = await this.database.batch<OutboxRow>([
      this.database
        .prepare(
          `UPDATE confirmation_outbox SET state = 'claimed', claim_id = ?1,
            claimed_at = ?2, claim_expires_at = ?3, attempt_count = attempt_count + 1
          WHERE outbox_id = ?4 AND site_id = ?5
            AND (state IN ('pending', 'enqueued')
              OR (state = 'claimed' AND (claim_id = ?1 OR claim_expires_at <= ?2)))
            AND EXISTS (
              SELECT 1 FROM subscribers
              WHERE subscribers.site_id = confirmation_outbox.site_id
                AND subscribers.email_key = confirmation_outbox.email_key
                AND subscribers.status = 'pending'
                AND subscribers.token_version = confirmation_outbox.token_version
            )`,
        )
        .bind(claimId, claimedAt, claimExpiresAt, message.outboxId, message.siteId),
      this.database
        .prepare(
          `SELECT outbox_id, site_id, email_key, kind, token_version, created_at,
            payload_key_version, payload_nonce, payload_ciphertext, claim_id,
            claim_expires_at, attempt_count
          FROM confirmation_outbox
          WHERE outbox_id = ?1 AND site_id = ?2 AND state = 'claimed' AND claim_id = ?3`,
        )
        .bind(message.outboxId, message.siteId, claimId),
    ]);
    if (results[0]?.meta.changes !== 1) return null;
    const row = results[1]?.results[0];
    if (!row) throw new Error("Claimed confirmation outbox row is missing");
    const identity = {
      outboxId: row.outbox_id,
      siteId: row.site_id,
      emailKey: row.email_key,
      tokenVersion: row.token_version,
      createdAt: row.created_at,
    };
    const payload = await this.cipher.decrypt(identity, {
      keyVersion: row.payload_key_version,
      nonce: row.payload_nonce,
      ciphertext: row.payload_ciphertext,
    });
    return {
      kind: row.kind,
      ...identity,
      ...payload,
      claimId: row.claim_id,
      claimExpiresAt: row.claim_expires_at,
      attemptCount: row.attempt_count,
    };
  }

  async markSent(outboxId: string, claimId: string, providerMessageId: string, sentAt: string) {
    if (
      outboxId.length < 1 ||
      outboxId.length > 256 ||
      claimId.length < 1 ||
      claimId.length > 160 ||
      providerMessageId.length < 1 ||
      providerMessageId.length > 256 ||
      !Number.isFinite(Date.parse(sentAt))
    ) {
      throw new TypeError("Sent confirmation identity is invalid");
    }
    const result = await this.database.batch([
      this.database
        .prepare(
          `UPDATE confirmation_outbox SET state = 'sent', sent_at = ?1,
            provider_message_id = ?2, claim_id = NULL, claimed_at = NULL,
            claim_expires_at = NULL
          WHERE outbox_id = ?3 AND state = 'claimed' AND claim_id = ?4`,
        )
        .bind(sentAt, providerMessageId, outboxId, claimId),
    ]);
    return result[0]?.meta.changes === 1;
  }

  async markFailed(outboxId: string, claimId: string, failureCode: string, failedAt: string) {
    if (
      outboxId.length < 1 ||
      outboxId.length > 256 ||
      claimId.length < 1 ||
      claimId.length > 160 ||
      !/^[a-z][a-z0-9_-]{0,63}$/.test(failureCode) ||
      !Number.isFinite(Date.parse(failedAt))
    ) {
      throw new TypeError("Failed confirmation identity is invalid");
    }
    const result = await this.database.batch([
      this.database
        .prepare(
          `UPDATE confirmation_outbox SET state = 'failed', failed_at = ?1,
            failure_code = ?2, claim_id = NULL, claimed_at = NULL,
            claim_expires_at = NULL
          WHERE outbox_id = ?3 AND state = 'claimed' AND claim_id = ?4`,
        )
        .bind(failedAt, failureCode, outboxId, claimId),
    ]);
    return result[0]?.meta.changes === 1;
  }

  async consumeRateLimit(input: {
    siteId: string;
    bucketKey: string;
    nowEpochSeconds: number;
    windowSeconds: number;
    limit: number;
  }) {
    if (
      input.siteId.length < 1 ||
      input.siteId.length > 80 ||
      input.bucketKey.length !== 43 ||
      !Number.isSafeInteger(input.nowEpochSeconds) ||
      !Number.isSafeInteger(input.windowSeconds) ||
      input.windowSeconds < 1 ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1
    ) {
      throw new TypeError("Rate-limit input is invalid");
    }
    const windowStart = input.nowEpochSeconds - (input.nowEpochSeconds % input.windowSeconds);
    const result = await this.database.batch([
      this.database
        .prepare(
          `INSERT INTO subscription_rate_limits (site_id, bucket_key, window_started_at, count)
          VALUES (?1, ?2, ?3, 1)
          ON CONFLICT(site_id, bucket_key) DO UPDATE SET
            window_started_at = CASE
              WHEN subscription_rate_limits.window_started_at <> excluded.window_started_at
              THEN excluded.window_started_at ELSE subscription_rate_limits.window_started_at END,
            count = CASE
              WHEN subscription_rate_limits.window_started_at <> excluded.window_started_at
              THEN 1 ELSE subscription_rate_limits.count + 1 END
          WHERE subscription_rate_limits.window_started_at <> excluded.window_started_at
            OR subscription_rate_limits.count < ?4`,
        )
        .bind(input.siteId, input.bucketKey, windowStart, input.limit),
    ]);
    return result[0]?.meta.changes === 1;
  }

  async recordSuppression(input: {
    eventId: string;
    providerMessageId: string;
    reason: SuppressionReason;
    occurredAt: string;
    receivedAt: string;
  }) {
    if (
      input.eventId.length < 1 ||
      input.eventId.length > 256 ||
      input.providerMessageId.length < 1 ||
      input.providerMessageId.length > 256 ||
      !Number.isFinite(Date.parse(input.occurredAt)) ||
      !Number.isFinite(Date.parse(input.receivedAt))
    ) {
      throw new TypeError("Suppression event is invalid");
    }
    const commitId = crypto.randomUUID();
    const reason = input.reason;
    const results = await this.database.batch([
      this.database
        .prepare(
          `INSERT INTO delivery_webhook_events (
            provider, event_id, provider_message_id, event_type, occurred_at, received_at, commit_id
          ) VALUES ('resend', ?1, ?2, ?3, ?4, ?5, ?6)
          ON CONFLICT(provider, event_id) DO NOTHING`,
        )
        .bind(
          input.eventId,
          input.providerMessageId,
          reason,
          input.occurredAt,
          input.receivedAt,
          commitId,
        ),
      this.database
        .prepare(
          `UPDATE subscribers SET status = 'suppressed', revision = revision + 1,
            confirmation_token_hash = NULL, confirmation_expires_at = NULL,
            suppressed_at = ?1, suppression_reason = ?2, updated_at = ?3,
            commit_id = ?4
          WHERE status <> 'suppressed' AND EXISTS (
            SELECT 1 FROM confirmation_outbox
            JOIN delivery_webhook_events
              ON delivery_webhook_events.provider_message_id = confirmation_outbox.provider_message_id
            WHERE confirmation_outbox.site_id = subscribers.site_id
              AND confirmation_outbox.email_key = subscribers.email_key
              AND delivery_webhook_events.provider = 'resend'
              AND delivery_webhook_events.event_id = ?5
              AND delivery_webhook_events.commit_id = ?4
          )`,
        )
        .bind(input.occurredAt, reason, input.receivedAt, commitId, input.eventId),
    ]);
    return {
      recorded: results[0]?.meta.changes === 1,
      suppressed: results[1]?.meta.changes === 1,
    };
  }
}

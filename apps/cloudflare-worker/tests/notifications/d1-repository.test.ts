import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createNotificationEvent } from "@uptime-status/domain/notification";
import type { SubscriberRecord } from "../../../api/src/subscriptions/repository";
import {
  D1NotificationRepository,
  type NotificationQueueMessage,
} from "../../src/notifications/d1-repository";
import type {
  DatabasePort,
  DatabaseResult,
  DatabaseStatement,
} from "../../src/subscriptions/d1-repository";

class SqliteStatement implements DatabaseStatement {
  constructor(
    readonly database: Database,
    readonly query: string,
    readonly values: unknown[] = [],
  ) {}

  bind(...values: unknown[]) {
    return new SqliteStatement(this.database, this.query, values);
  }

  async first<T>() {
    return (this.database.query(this.query).get(...this.values) as T | null) ?? null;
  }

  async all<T>() {
    return {
      results: this.database.query(this.query).all(...this.values) as T[],
      meta: { changes: 0 },
    };
  }
}

function sqlitePort(database: Database): DatabasePort {
  return {
    prepare(query) {
      return new SqliteStatement(database, query);
    },
    async batch<T>(statements: DatabaseStatement[]) {
      return database.transaction(() =>
        statements.map((statement): DatabaseResult<T> => {
          if (!(statement instanceof SqliteStatement)) throw new TypeError("Unexpected statement");
          if (/^\s*SELECT\b/i.test(statement.query)) {
            return {
              results: database.query(statement.query).all(...statement.values) as T[],
              meta: { changes: 0 },
            };
          }
          const result = database.query(statement.query).run(...statement.values);
          return { results: [], meta: { changes: result.changes } };
        }),
      )();
    },
  };
}

function addSubscriber(
  database: Database,
  input: Partial<SubscriberRecord> & { emailKey: string },
) {
  const record: SubscriberRecord = {
    siteId: "site-a",
    emailKey: input.emailKey,
    normalizedEmail: `${input.emailKey}@example.com`,
    status: "active",
    revision: 1,
    tokenVersion: 1,
    confirmationTokenHash: null,
    confirmationExpiresAt: null,
    confirmationSentAt: null,
    confirmedAt: "2026-09-10T09:00:00.000Z",
    unsubscribedAt: null,
    suppressedAt: null,
    suppressionReason: null,
    createdAt: "2026-09-09T09:00:00.000Z",
    updatedAt: "2026-09-10T09:00:00.000Z",
    ...input,
  };
  database
    .query(
      `INSERT INTO subscribers (
        site_id, email_key, normalized_email, status, revision, token_version,
        confirmation_token_hash, confirmation_expires_at, confirmation_sent_at,
        confirmed_at, unsubscribed_at, suppressed_at, suppression_reason,
        created_at, updated_at, commit_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
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
      crypto.randomUUID(),
    );
}

function fixture() {
  const database = new Database(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of ["0001_subscription_storage.sql", "0002_notification_fanout.sql"]) {
    database.exec(readFileSync(resolve(import.meta.dir, `../../migrations/${migration}`), "utf8"));
  }
  return { database, repository: new D1NotificationRepository(sqlitePort(database)) };
}

const event = createNotificationEvent({
  schemaVersion: "1.0.0",
  siteId: "site-a",
  source: { kind: "incident", slug: "api-outage", revision: 1, updateId: "update-1" },
  type: "incident_published",
  contentRevision: "a".repeat(64),
  templateRevision: "1",
  title: "API outage",
  message: "We are investigating elevated errors.",
  publishedAt: "2026-09-10T10:00:00.000Z",
});

const createdAt = "2026-09-10T10:00:01.000Z";
const cutoff = "2026-09-10T10:00:00.000Z";

describe("D1 notification repository", () => {
  test("creates events idempotently and reports payload conflicts", async () => {
    const { repository } = fixture();

    await expect(repository.createEvent(event, cutoff, createdAt)).resolves.toBe("created");
    await expect(repository.createEvent(event, cutoff, "2026-09-10T10:00:02.000Z")).resolves.toBe(
      "existing",
    );
    await expect(
      repository.createEvent({ ...event, message: "Conflicting content" }, cutoff, createdAt),
    ).resolves.toBe("conflict");
  });

  test("expands the cutoff audience in stable bounded pages without duplicate deliveries", async () => {
    const { database, repository } = fixture();
    addSubscriber(database, { emailKey: "before-a" });
    addSubscriber(database, { emailKey: "before-b" });
    addSubscriber(database, {
      emailKey: "after",
      confirmedAt: "2026-09-10T10:00:01.000Z",
    });
    addSubscriber(database, { emailKey: "pending", status: "pending", confirmedAt: null });
    await repository.createEvent(event, cutoff, createdAt);

    await expect(repository.expandAudience(event.eventId, createdAt, 1)).resolves.toEqual({
      created: 1,
      complete: false,
    });
    await expect(repository.expandAudience(event.eventId, createdAt, 1)).resolves.toEqual({
      created: 1,
      complete: false,
    });
    await expect(repository.expandAudience(event.eventId, createdAt, 1)).resolves.toEqual({
      created: 0,
      complete: true,
    });
    await expect(repository.expandAudience(event.eventId, createdAt, 1)).resolves.toEqual({
      created: 0,
      complete: true,
    });
    expect(
      database.query("SELECT email_key FROM notification_deliveries ORDER BY email_key").all(),
    ).toEqual([{ email_key: "before-a" }, { email_key: "before-b" }]);
  });

  test("enqueues, claims, and records a unique sent delivery", async () => {
    const { database, repository } = fixture();
    addSubscriber(database, { emailKey: "recipient" });
    await repository.createEvent(event, cutoff, createdAt);
    await repository.expandAudience(event.eventId, createdAt);
    const queued: NotificationQueueMessage[] = [];

    await expect(
      repository.enqueuePending(
        "site-a",
        {
          async send(message) {
            queued.push(message);
          },
        },
        "2026-09-10T10:01:00.000Z",
      ),
    ).resolves.toBe(1);
    expect(queued).toHaveLength(1);
    const queuedMessage = queued[0];
    if (!queuedMessage) throw new Error("Expected one queued notification");
    const claimed = await repository.claim(queuedMessage, "claim-1", "2026-09-10T10:01:01.000Z");
    expect(claimed).toMatchObject({
      event,
      normalizedEmail: "recipient@example.com",
      attemptCount: 1,
    });
    await expect(
      repository.markSent(
        event.eventId,
        "recipient",
        "claim-1",
        "provider-1",
        "2026-09-10T10:01:02.000Z",
      ),
    ).resolves.toBe(true);
    await expect(
      repository.claim(queuedMessage, "claim-2", "2026-09-10T10:01:03.000Z"),
    ).resolves.toBeNull();
    expect(
      database.query("SELECT state, provider_message_id FROM notification_deliveries").get(),
    ).toEqual({
      state: "sent",
      provider_message_id: "provider-1",
    });
  });

  test("cancels delivery when unsubscribe or token version wins the claim race", async () => {
    const { database, repository } = fixture();
    addSubscriber(database, { emailKey: "unsubscribed" });
    addSubscriber(database, { emailKey: "retokened" });
    await repository.createEvent(event, cutoff, createdAt);
    await repository.expandAudience(event.eventId, createdAt);
    database
      .query("UPDATE subscribers SET status = 'unsubscribed' WHERE email_key = 'unsubscribed'")
      .run();
    database.query("UPDATE subscribers SET token_version = 2 WHERE email_key = 'retokened'").run();

    for (const emailKey of ["unsubscribed", "retokened"]) {
      await expect(
        repository.claim(
          {
            schemaVersion: "1.0.0",
            kind: "notification",
            siteId: "site-a",
            eventId: event.eventId,
            emailKey,
          },
          `claim-${emailKey}`,
          "2026-09-10T10:02:00.000Z",
        ),
      ).resolves.toBeNull();
    }
    expect(
      database.query("SELECT state FROM notification_deliveries ORDER BY email_key").all(),
    ).toEqual([{ state: "cancelled" }, { state: "cancelled" }]);
  });

  test("recovers leases, schedules retryable failures, records terminal failures, and cancels work", async () => {
    const { database, repository } = fixture();
    for (const emailKey of ["lease", "retry", "terminal", "cancel"])
      addSubscriber(database, { emailKey });
    await repository.createEvent(event, cutoff, createdAt);
    await repository.expandAudience(event.eventId, createdAt);

    const message = (emailKey: string): NotificationQueueMessage => ({
      schemaVersion: "1.0.0",
      kind: "notification",
      siteId: "site-a",
      eventId: event.eventId,
      emailKey,
    });
    await repository.claim(message("lease"), "lease-1", "2026-09-10T10:03:00.000Z", 30);
    await repository.claim(message("retry"), "retry-1", "2026-09-10T10:03:00.000Z");
    await repository.claim(message("terminal"), "terminal-1", "2026-09-10T10:03:00.000Z");
    await expect(
      repository.markFailed(
        event.eventId,
        "retry",
        "retry-1",
        "timeout",
        "2026-09-10T10:03:01.000Z",
        "2026-09-10T10:04:00.000Z",
      ),
    ).resolves.toBe(true);
    await expect(
      repository.markFailed(
        event.eventId,
        "terminal",
        "terminal-1",
        "rejected",
        "2026-09-10T10:03:01.000Z",
      ),
    ).resolves.toBe(true);
    await expect(
      repository.cancel(event.eventId, "cancel", "operator", "2026-09-10T10:03:02.000Z"),
    ).resolves.toBe(true);

    const queued: NotificationQueueMessage[] = [];
    await expect(
      repository.enqueuePending(
        "site-a",
        {
          async send(candidate) {
            queued.push(candidate);
          },
        },
        "2026-09-10T10:04:01.000Z",
      ),
    ).resolves.toBe(2);
    expect(queued.map((item) => item.emailKey).sort()).toEqual(["lease", "retry"]);
    expect(
      database
        .query("SELECT email_key, state FROM notification_deliveries ORDER BY email_key")
        .all(),
    ).toEqual([
      { email_key: "cancel", state: "cancelled" },
      { email_key: "lease", state: "enqueued" },
      { email_key: "retry", state: "enqueued" },
      { email_key: "terminal", state: "failed" },
    ]);
  });
});

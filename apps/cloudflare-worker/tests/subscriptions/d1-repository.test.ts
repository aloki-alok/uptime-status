import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  ConfirmationOutboxRecord,
  SubscriberRecord,
} from "../../../api/src/subscriptions/repository";
import {
  D1SubscriptionRepository,
  type DatabasePort,
  type DatabaseResult,
  type DatabaseStatement,
  type SubscriptionQueueMessage,
} from "../../src/subscriptions/d1-repository";
import {
  ConfirmationOutboxCipher,
  importOutboxEncryptionKey,
} from "../../src/subscriptions/outbox-crypto";

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

async function fixture() {
  const database = new Database(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  // Suppression joins notification deliveries, so the fixture needs every migration D1 has.
  for (const migration of ["0001_subscription_storage.sql", "0002_notification_fanout.sql"]) {
    database.exec(readFileSync(resolve(import.meta.dir, `../../migrations/${migration}`), "utf8"));
  }
  const key = await importOutboxEncryptionKey(new Uint8Array(32).fill(9));
  const repository = new D1SubscriptionRepository(
    sqlitePort(database),
    new ConfirmationOutboxCipher({ version: 1, key }),
  );
  return { database, repository };
}

const subscriber: SubscriberRecord = {
  siteId: "site-a",
  emailKey: "k".repeat(43),
  normalizedEmail: "person@example.com",
  status: "pending",
  revision: 1,
  tokenVersion: 1,
  confirmationTokenHash: "h".repeat(43),
  confirmationExpiresAt: "2026-09-11T10:00:00.000Z",
  confirmationSentAt: "2026-09-10T10:00:00.000Z",
  confirmedAt: null,
  unsubscribedAt: null,
  suppressedAt: null,
  suppressionReason: null,
  createdAt: "2026-09-10T10:00:00.000Z",
  updatedAt: "2026-09-10T10:00:00.000Z",
};

const outbox: ConfirmationOutboxRecord = {
  kind: "subscription-confirmation",
  outboxId: `site-a:${"k".repeat(43)}:1`,
  siteId: "site-a",
  emailKey: "k".repeat(43),
  normalizedEmail: "person@example.com",
  token: `v1.${"k".repeat(43)}.1.${"s".repeat(43)}`,
  tokenVersion: 1,
  createdAt: "2026-09-10T10:00:00.000Z",
};

const message: SubscriptionQueueMessage = {
  schemaVersion: "1.0.0",
  kind: "subscription-confirmation",
  outboxId: outbox.outboxId,
  siteId: outbox.siteId,
};

describe("D1 subscription repository", () => {
  test("commits subscriber and encrypted outbox state atomically", async () => {
    const { database, repository } = await fixture();

    await expect(
      repository.commit({ record: subscriber, expectedRevision: null, outbox }),
    ).resolves.toMatchObject({ committed: true });
    await expect(repository.get(subscriber.siteId, subscriber.emailKey)).resolves.toEqual(
      subscriber,
    );

    const stored = database
      .query("SELECT payload_nonce, payload_ciphertext FROM confirmation_outbox")
      .get() as { payload_nonce: string; payload_ciphertext: string };
    expect(stored.payload_nonce).not.toContain(outbox.normalizedEmail);
    expect(stored.payload_ciphertext).not.toContain(outbox.normalizedEmail);
    expect(stored.payload_ciphertext).not.toContain(outbox.token);

    const conflict = await repository.commit({ record: subscriber, expectedRevision: null });
    expect(conflict.committed).toBe(false);
    expect(conflict.current?.revision).toBe(1);
  });

  test("enqueues, claims, decrypts, and records one sent confirmation", async () => {
    const { database, repository } = await fixture();
    await repository.commit({ record: subscriber, expectedRevision: null, outbox });
    const queued: SubscriptionQueueMessage[] = [];
    const count = await repository.enqueuePending(
      "site-a",
      {
        async send(candidate) {
          queued.push(candidate);
        },
      },
      "2026-09-10T10:00:01.000Z",
    );
    expect(count).toBe(1);
    expect(queued).toEqual([message]);

    const claimed = await repository.claim(message, "queue-message-1", "2026-09-10T10:00:02.000Z");
    expect(claimed).toMatchObject({
      normalizedEmail: outbox.normalizedEmail,
      token: outbox.token,
      claimId: "queue-message-1",
      attemptCount: 1,
    });
    const retried = await repository.claim(message, "queue-message-1", "2026-09-10T10:00:03.000Z");
    expect(retried?.attemptCount).toBe(2);

    await expect(
      repository.markSent(
        outbox.outboxId,
        "queue-message-1",
        "resend-message-1",
        "2026-09-10T10:00:04.000Z",
      ),
    ).resolves.toBe(true);
    await expect(
      repository.claim(message, "queue-message-2", "2026-09-10T10:00:05.000Z"),
    ).resolves.toBeNull();
    expect(
      database.query("SELECT state, provider_message_id FROM confirmation_outbox").get(),
    ).toEqual({ state: "sent", provider_message_id: "resend-message-1" });
  });

  test("cancels stale confirmation work when subscriber state advances", async () => {
    const { database, repository } = await fixture();
    await repository.commit({ record: subscriber, expectedRevision: null, outbox });
    const confirmed: SubscriberRecord = {
      ...subscriber,
      status: "active",
      revision: 2,
      confirmedAt: "2026-09-10T10:01:00.000Z",
      updatedAt: "2026-09-10T10:01:00.000Z",
    };

    await expect(
      repository.commit({ record: confirmed, expectedRevision: 1 }),
    ).resolves.toMatchObject({ committed: true });
    expect(database.query("SELECT state FROM confirmation_outbox").get()).toEqual({
      state: "cancelled",
    });
    await expect(
      repository.claim(message, "queue-message-1", "2026-09-10T10:02:00.000Z"),
    ).resolves.toBeNull();
  });

  test("recovers expired claims and records permanent delivery failures", async () => {
    const { database, repository } = await fixture();
    await repository.commit({ record: subscriber, expectedRevision: null, outbox });
    await repository.enqueuePending("site-a", { async send() {} }, "2026-09-10T10:00:01.000Z");
    await repository.claim(message, "queue-message-1", "2026-09-10T10:00:02.000Z", 30);

    const queued: SubscriptionQueueMessage[] = [];
    await expect(
      repository.enqueuePending(
        "site-a",
        {
          async send(candidate) {
            queued.push(candidate);
          },
        },
        "2026-09-10T10:00:33.000Z",
      ),
    ).resolves.toBe(1);
    expect(queued).toEqual([message]);

    await repository.claim(message, "queue-message-2", "2026-09-10T10:00:34.000Z");
    await expect(
      repository.markFailed(
        outbox.outboxId,
        "queue-message-2",
        "provider_rejected",
        "2026-09-10T10:00:35.000Z",
      ),
    ).resolves.toBe(true);
    expect(database.query("SELECT state, failure_code FROM confirmation_outbox").get()).toEqual({
      state: "failed",
      failure_code: "provider_rejected",
    });
  });

  test("enforces fixed-window request limits atomically", async () => {
    const { repository } = await fixture();
    const consume = (nowEpochSeconds: number) =>
      repository.consumeRateLimit({
        siteId: "site-a",
        bucketKey: "r".repeat(43),
        nowEpochSeconds,
        windowSeconds: 60,
        limit: 2,
      });

    await expect(consume(100)).resolves.toBe(true);
    await expect(consume(119)).resolves.toBe(true);
    await expect(consume(119)).resolves.toBe(false);
    await expect(consume(120)).resolves.toBe(true);
  });

  test("deduplicates terminal Resend suppression events", async () => {
    const { repository } = await fixture();
    await repository.commit({ record: subscriber, expectedRevision: null, outbox });
    await repository.enqueuePending("site-a", { async send() {} }, "2026-09-10T10:00:01.000Z");
    await repository.claim(message, "queue-message-1", "2026-09-10T10:00:02.000Z");
    await repository.markSent(
      outbox.outboxId,
      "queue-message-1",
      "resend-message-1",
      "2026-09-10T10:00:03.000Z",
    );

    const event = {
      eventId: "webhook-event-1",
      providerMessageId: "resend-message-1",
      reason: "bounce" as const,
      occurredAt: "2026-09-10T10:01:00.000Z",
      receivedAt: "2026-09-10T10:01:01.000Z",
    };
    await expect(repository.recordSuppression(event)).resolves.toEqual({
      recorded: true,
      suppressed: true,
    });
    await expect(repository.recordSuppression(event)).resolves.toEqual({
      recorded: false,
      suppressed: false,
    });
    await expect(repository.get(subscriber.siteId, subscriber.emailKey)).resolves.toMatchObject({
      status: "suppressed",
      suppressionReason: "bounce",
      revision: 2,
    });
  });
});

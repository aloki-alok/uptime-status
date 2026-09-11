import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createNotificationEvent } from "@uptime-status/domain/notification-authoring";
import type { NotificationQueueMessage } from "../../src/notifications/d1-repository";
import {
  type NotificationRuntimeEnv,
  processNotificationQueue,
  publishNotificationEvent,
  repairNotificationFanout,
} from "../../src/notifications/runtime";

class FakeStatement {
  constructor(
    readonly database: Database,
    readonly query: string,
    readonly values: unknown[] = [],
  ) {}

  bind(...values: unknown[]) {
    return new FakeStatement(this.database, this.query, values);
  }

  async first<T>() {
    return (this.database.query(this.query).get(...this.values) as T | null) ?? null;
  }

  async all<T>() {
    return {
      results: this.database.query(this.query).all(...this.values) as T[],
      success: true,
      meta: { changes: 0 },
    };
  }
}

function fakeD1(database: Database) {
  return {
    prepare(query: string) {
      return new FakeStatement(database, query);
    },
    async batch(statements: FakeStatement[]) {
      return database.transaction(() =>
        statements.map((statement) => {
          if (/^\s*SELECT\b/i.test(statement.query)) {
            return {
              results: database.query(statement.query).all(...statement.values),
              success: true,
              meta: { changes: 0 },
            };
          }
          const result = database.query(statement.query).run(...statement.values);
          return { results: [], success: true, meta: { changes: result.changes } };
        }),
      )();
    },
  } as unknown as D1Database;
}

function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

const event = createNotificationEvent({
  schemaVersion: "1.0.0",
  siteId: "site-a",
  source: { kind: "incident", slug: "api-outage", revision: 1, updateId: "update-1" },
  type: "incident_published",
  contentRevision: "a".repeat(64),
  templateRevision: "1",
  title: "API outage",
  message: "Requests are failing in one region.",
  publishedAt: "2026-09-10T10:00:00.000Z",
});

async function fixture(fanoutEnabled = true, environmentEnabled = "true") {
  const database = new Database(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of ["0001_subscription_storage.sql", "0002_notification_fanout.sql"]) {
    database.exec(readFileSync(resolve(import.meta.dir, `../../migrations/${migration}`), "utf8"));
  }
  const site = JSON.parse(
    readFileSync(
      resolve(import.meta.dir, "../../../../packages/cli/templates/status.config.json"),
      "utf8",
    ),
  );
  site.siteId = "site-a";
  site.domains.primary = "status.example.com";
  site.subscriptions = {
    enabled: true,
    doubleOptIn: true,
    notificationFanoutEnabled: fanoutEnabled,
    delivery: {
      provider: "resend",
      connection: { provider: "environment", reference: "RESEND_API_KEY" },
      senderName: "Example status",
      senderEmail: "status@example.com",
    },
    templates: { subjectPrefix: "Example status" },
    confirmationTtlSeconds: 86_400,
    resendCooldownSeconds: 900,
  };
  const queued: NotificationQueueMessage[] = [];
  const env = {
    ASSETS: {
      async fetch() {
        return Response.json(site);
      },
    },
    SUBSCRIPTIONS_DATABASE: fakeD1(database),
    SUBSCRIPTION_CONFIRMATIONS: {
      async send(message: NotificationQueueMessage) {
        queued.push(message);
        return {};
      },
    },
    SUBSCRIPTION_ACCEPTANCE_ENABLED: "true",
    NOTIFICATION_DELIVERY_ENABLED: environmentEnabled,
    LOOKUP_PEPPER: "lookup-test-pepper-with-enough-entropy",
    CONFIRMATION_PEPPER: "confirmation-test-pepper-with-enough-entropy",
    UNSUBSCRIBE_PEPPER: "unsubscribe-test-pepper-with-enough-entropy",
    RATE_LIMIT_PEPPER: "rate-limit-test-pepper-with-enough-entropy",
    OUTBOX_ENCRYPTION_KEY: base64url(new Uint8Array(32).fill(7)),
    RESEND_API_KEY: "re_test_key",
    RESEND_WEBHOOK_SECRET: `whsec_${btoa(String.fromCharCode(...new Uint8Array(32).fill(6)))}`,
  } as unknown as NotificationRuntimeEnv;
  return { database, env, queued, site };
}

function addActiveSubscriber(database: Database, emailKey: string, email: string) {
  database
    .query(`INSERT INTO subscribers (
    site_id, email_key, normalized_email, status, revision, token_version,
    confirmed_at, created_at, updated_at, commit_id
  ) VALUES (?, ?, ?, 'active', 1, 1, ?, ?, ?, ?)`)
    .run(
      "site-a",
      emailKey,
      email,
      "2026-09-10T09:00:00.000Z",
      "2026-09-09T09:00:00.000Z",
      "2026-09-10T09:00:00.000Z",
      crypto.randomUUID(),
    );
}

function batch(messages: NotificationQueueMessage[]) {
  const states = messages.map(() => ({ acknowledged: false, retried: false }));
  return {
    value: {
      queue: "status-mail",
      messages: messages.map((body, index) => ({
        id: `queue-message-${index + 1}`,
        timestamp: new Date("2026-09-10T10:00:01.000Z"),
        attempts: 1,
        body,
        ack() {
          states[index].acknowledged = true;
        },
        retry() {
          states[index].retried = true;
        },
      })),
      ackAll() {},
      retryAll() {},
    } as MessageBatch<NotificationQueueMessage>,
    states,
  };
}

describe("Cloudflare notification fanout runtime", () => {
  test("requires both site and environment kill switches before creating fanout", async () => {
    for (const [siteEnabled, environmentEnabled] of [
      [false, "true"],
      [true, "false"],
      [true, "TRUE"],
    ] as const) {
      const { database, env, queued } = await fixture(siteEnabled, environmentEnabled);
      addActiveSubscriber(database, "a".repeat(43), "one@example.com");
      await expect(publishNotificationEvent(event, env)).resolves.toEqual({ kind: "disabled" });
      expect(database.query("SELECT count(*) AS count FROM notification_events").get()).toEqual({
        count: 0,
      });
      expect(queued).toHaveLength(0);
    }
  });

  test("fans one event out to distinct recipient deliveries with unsubscribe links", async () => {
    const { database, env, queued } = await fixture();
    addActiveSubscriber(database, "a".repeat(43), "one@example.com");
    addActiveSubscriber(database, "b".repeat(43), "two@example.com");

    await expect(publishNotificationEvent(event, env)).resolves.toMatchObject({
      kind: "ready",
      eventId: event.eventId,
      created: true,
      deliveriesCreated: 2,
      enqueued: 2,
    });
    expect(queued).toHaveLength(2);

    const sent: Array<{ idempotencyKey: string | null; body: Record<string, unknown> }> = [];
    const work = batch(queued);
    await processNotificationQueue(work.value, env, async (_input, init) => {
      sent.push({
        idempotencyKey: new Headers(init?.headers).get("idempotency-key"),
        body: JSON.parse(String(init?.body)),
      });
      return Response.json({ id: `resend-message-${sent.length}` });
    });

    expect(work.states).toEqual([
      { acknowledged: true, retried: false },
      { acknowledged: true, retried: false },
    ]);
    expect(new Set(sent.map((delivery) => delivery.idempotencyKey)).size).toBe(2);
    for (const delivery of sent) {
      expect(delivery.body.headers).toMatchObject({
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        "X-Status-Event": event.eventId,
      });
      expect(String(delivery.body.html)).toContain("/api/v1/subscriptions/unsubscribe?token=");
    }
    expect(
      database
        .query("SELECT state, count(*) AS count FROM notification_deliveries GROUP BY state")
        .all(),
    ).toEqual([{ state: "sent", count: 2 }]);
  });

  test("does not deliver after a subscriber becomes ineligible before claim", async () => {
    const { database, env, queued } = await fixture();
    addActiveSubscriber(database, "a".repeat(43), "one@example.com");
    await publishNotificationEvent(event, env);
    database
      .query("UPDATE subscribers SET status = 'unsubscribed' WHERE email_key = ?")
      .run("a".repeat(43));
    const work = batch(queued);
    let requests = 0;
    await processNotificationQueue(work.value, env, async () => {
      requests += 1;
      return Response.json({ id: "unexpected" });
    });
    expect(requests).toBe(0);
    expect(work.states[0]).toEqual({ acknowledged: true, retried: false });
    expect(database.query("SELECT state FROM notification_deliveries").get()).toEqual({
      state: "cancelled",
    });
  });

  test("repairs retryable deliveries without exposing them while disabled", async () => {
    const { database, env, queued } = await fixture();
    addActiveSubscriber(database, "a".repeat(43), "one@example.com");
    await publishNotificationEvent(event, env);
    const first = batch(queued.splice(0));
    await processNotificationQueue(
      first.value,
      env,
      async () => new Response(null, { status: 503 }),
      () => new Date("2026-09-10T10:00:01.000Z"),
    );
    expect(first.states[0]).toEqual({ acknowledged: true, retried: false });
    expect(database.query("SELECT state FROM notification_deliveries").get()).toEqual({
      state: "retry_wait",
    });

    env.NOTIFICATION_DELIVERY_ENABLED = "false";
    await expect(
      repairNotificationFanout(env, new Date("2026-09-10T10:02:00.000Z")),
    ).resolves.toEqual({ kind: "disabled" });
    expect(queued).toHaveLength(0);

    env.NOTIFICATION_DELIVERY_ENABLED = "true";
    await expect(
      repairNotificationFanout(env, new Date("2026-09-10T10:02:00.000Z")),
    ).resolves.toMatchObject({ kind: "repaired", enqueued: 1 });
    expect(queued).toHaveLength(1);
  });
});

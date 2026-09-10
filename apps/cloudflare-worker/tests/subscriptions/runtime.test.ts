import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SubscriptionQueueMessage } from "../../src/subscriptions/d1-repository";
import {
  handleResendWebhook,
  handleSubscriptionApi,
  processSubscriptionQueue,
  type SubscriptionRuntimeEnv,
} from "../../src/subscriptions/runtime";

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

async function fixture() {
  const database = new Database(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(
    readFileSync(
      resolve(import.meta.dir, "../../migrations/0001_subscription_storage.sql"),
      "utf8",
    ),
  );
  const site = JSON.parse(
    readFileSync(
      resolve(import.meta.dir, "../../../../packages/cli/templates/status.config.json"),
      "utf8",
    ),
  );
  site.domains.primary = "status.example.com";
  site.subscriptions = {
    enabled: true,
    doubleOptIn: true,
    notificationFanoutEnabled: false,
    delivery: {
      provider: "resend",
      connection: { provider: "environment", reference: "RESEND_API_KEY" },
      senderName: "Example status",
      senderEmail: "status@example.com",
    },
    templates: { logoPath: "./assets/favicon.svg", subjectPrefix: "Example status" },
    confirmationTtlSeconds: 86_400,
    resendCooldownSeconds: 900,
  };
  const queued: SubscriptionQueueMessage[] = [];
  const env = {
    ASSETS: {
      async fetch() {
        return Response.json(site);
      },
    },
    SUBSCRIPTIONS_DATABASE: fakeD1(database),
    SUBSCRIPTION_CONFIRMATIONS: {
      async send(message: SubscriptionQueueMessage) {
        queued.push(message);
        return {};
      },
    },
    SUBSCRIPTION_ACCEPTANCE_ENABLED: "true",
    LOOKUP_PEPPER: "lookup-test-pepper-with-enough-entropy",
    CONFIRMATION_PEPPER: "confirmation-test-pepper-with-enough-entropy",
    UNSUBSCRIBE_PEPPER: "unsubscribe-test-pepper-with-enough-entropy",
    RATE_LIMIT_PEPPER: "rate-limit-test-pepper-with-enough-entropy",
    OUTBOX_ENCRYPTION_KEY: base64url(new Uint8Array(32).fill(7)),
    RESEND_API_KEY: "re_test_key",
    RESEND_WEBHOOK_SECRET: `whsec_${btoa(String.fromCharCode(...new Uint8Array(32).fill(6)))}`,
  } as unknown as SubscriptionRuntimeEnv;
  return { database, env, queued };
}

describe("Cloudflare subscription runtime", () => {
  test("completes double opt-in and suppresses a bounced recipient", async () => {
    const { database, env, queued } = await fixture();
    const background: Promise<unknown>[] = [];
    const accepted = await handleSubscriptionApi(
      new Request("https://status.example.com/api/v1/subscriptions", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.1" },
        body: JSON.stringify({ email: "person@example.com" }),
      }),
      env,
      (promise) => background.push(promise),
    );
    expect(accepted.status).toBe(202);
    await Promise.all(background);
    expect(queued).toHaveLength(1);

    let resendBody: Record<string, unknown> = {};
    let acknowledged = false;
    await processSubscriptionQueue(
      {
        queue: "confirmations",
        messages: [
          {
            id: "queue-message-1",
            timestamp: new Date(),
            attempts: 1,
            body: queued[0],
            ack() {
              acknowledged = true;
            },
            retry() {
              throw new Error("Delivery should not retry");
            },
          },
        ],
        ackAll() {},
        retryAll() {},
      } as MessageBatch<SubscriptionQueueMessage>,
      env,
      async (_input, init) => {
        resendBody = JSON.parse(String(init?.body));
        return Response.json({ id: "resend-message-1" });
      },
    );
    expect(acknowledged).toBe(true);
    const html = String(resendBody.html);
    const link = html.match(/href="([^"]*\/api\/v1\/subscriptions\/confirm\?token=[^"]+)"/)?.[1];
    expect(link).toBeTruthy();

    const landing = await handleSubscriptionApi(new Request(link as string), env, () => {});
    expect(landing.headers.get("location")).toBe("/subscriptions/confirm/");
    expect(database.query("SELECT status FROM subscribers").get()).toEqual({ status: "pending" });
    const confirmed = await handleSubscriptionApi(
      new Request("https://status.example.com/api/v1/subscriptions/confirm", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: landing.headers.get("set-cookie")?.split(";", 1)[0] ?? "",
        },
        body: "intent=confirm",
      }),
      env,
      () => {},
    );
    expect(confirmed.headers.get("location")).toBe("/subscriptions/confirmed/");
    expect(database.query("SELECT status FROM subscribers").get()).toEqual({ status: "active" });

    const payload = JSON.stringify({
      type: "email.bounced",
      created_at: "2026-09-10T10:00:00.000Z",
      data: { email_id: "resend-message-1" },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const webhookId = "webhook-message-1";
    const signingKey = await crypto.subtle.importKey(
      "raw",
      new Uint8Array(32).fill(6),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        signingKey,
        new TextEncoder().encode(`${webhookId}.${timestamp}.${payload}`),
      ),
    );
    const webhook = await handleResendWebhook(
      new Request("https://status.example.com/api/v1/webhooks/resend", {
        method: "POST",
        headers: {
          "svix-id": webhookId,
          "svix-timestamp": timestamp,
          "svix-signature": `v1,${btoa(String.fromCharCode(...signature))}`,
        },
        body: payload,
      }),
      env,
    );
    expect(webhook.status).toBe(200);
    expect(database.query("SELECT status FROM subscribers").get()).toEqual({
      status: "suppressed",
    });
  });
});

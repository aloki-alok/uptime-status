import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { Incident, SiteConfig } from "@uptime-status/domain";
import type { RenderedMail } from "@uptime-status/email";
import { CuratedStore } from "../../../monitor/src/curated";
import { testSite } from "../../../monitor/tests/fixtures";
import { SqliteNotificationRepository } from "../../src/delivery/sqlite-notifications";
import { DeliveryWorker } from "../../src/delivery/worker";
import { SubscriptionService } from "../../src/subscriptions/service";
import { SqliteSubscriptionRepository } from "../../src/subscriptions/sqlite-repository";

test("confirmed subscribers receive only explicitly flagged notice revisions", async () => {
  const site: SiteConfig = testSite();
  site.subscriptions = {
    enabled: true,
    doubleOptIn: true,
    notificationFanoutEnabled: true,
    delivery: {
      provider: "ses",
      region: "us-west-1",
      senderEmail: "no-reply@status.example.com",
      contactListName: "test-list",
      topicName: "test-topic",
    },
    confirmationTtlSeconds: 3600,
    resendCooldownSeconds: 300,
  };
  const db = new Database(":memory:");
  const subscribers = new SqliteSubscriptionRepository(db);
  const notices = new SqliteNotificationRepository(db);
  const service = new SubscriptionService(subscribers, {
    siteId: site.siteId,
    lookupPepper: "lookup-test-pepper-with-enough-entropy",
    confirmationPepper: "confirmation-test-pepper-with-enough-entropy",
    unsubscribePepper: "unsubscribe-test-pepper-with-enough-entropy",
    confirmationTtlSeconds: 3600,
    resendCooldownSeconds: 300,
    now: () => new Date("2026-09-14T09:00:00.000Z"),
  });
  const mail: RenderedMail[] = [];
  const sender = {
    async send(item: RenderedMail) {
      mail.push(item);
      return `ses-${mail.length}`;
    },
  };
  const worker = new DeliveryWorker(
    site as SiteConfig & { subscriptions: Extract<SiteConfig["subscriptions"], { enabled: true }> },
    "https://status.example.com",
    subscribers,
    service,
    notices,
    sender,
    () => new Date("2026-09-14T09:00:10.000Z"),
  );
  const curated = new CuratedStore(db, site);
  await service.requestSubscription("person@example.com");
  const token = subscribers.pendingConfirmations(1)[0].token;
  expect(await worker.runOnce()).toEqual({ confirmationsSent: 1, notificationsSent: 0 });
  expect(mail[0].html).toContain("Confirm status updates");
  expect(await service.confirm(token)).toBe("confirmed");

  const incident: Incident = {
    slug: "api-outage",
    revision: 1,
    title: "API outage",
    state: "investigating",
    impact: "major_outage",
    affectedComponents: [site.components[0].componentId],
    startedAt: "2026-09-14T09:00:00.000Z",
    updates: [
      {
        id: "initial",
        state: "investigating",
        message: "We are investigating.",
        publishedAt: "2026-09-14T09:00:00.000Z",
      },
    ],
  };
  curated.save("incident", incident, null, "test", "open");
  expect((await worker.runOnce()).notificationsSent).toBe(0);
  expect(mail).toHaveLength(1);

  const resolved: Incident = {
    ...incident,
    revision: 2,
    state: "resolved",
    resolvedAt: "2026-09-14T09:00:05.000Z",
    updates: [
      ...incident.updates,
      {
        id: "resolved",
        state: "resolved",
        message: "Service is restored.",
        publishedAt: "2026-09-14T09:00:05.000Z",
      },
    ],
  };
  curated.save("incident", resolved, 1, "test", "resolve", true);
  expect((await worker.runOnce()).notificationsSent).toBe(1);
  expect(mail[1].subject).toContain("API outage");
  expect(mail[1].text).toContain("Affected services: Public API");
  expect(mail[1].text).toContain(
    "Unsubscribe: https://status.example.com/api/v1/subscriptions/unsubscribe",
  );
  expect((await worker.runOnce()).notificationsSent).toBe(0);
  const record = db.query("SELECT email_key FROM subscribers").get() as { email_key: string };
  const unsubscribe = await service.createUnsubscribeToken(record.email_key);
  expect(await service.unsubscribe(unsubscribe ?? "")).toBe("unsubscribed");
  db.close();
});

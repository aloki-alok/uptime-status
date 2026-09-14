import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { Incident } from "@uptime-status/domain";
import { CuratedStore } from "../../../monitor/src/curated";
import { testSite } from "../../../monitor/tests/fixtures";
import { SqliteNotificationRepository } from "../../src/delivery/sqlite-notifications";
import { SubscriptionService } from "../../src/subscriptions/service";
import { SqliteSubscriptionRepository } from "../../src/subscriptions/sqlite-repository";

const site = testSite();
site.siteId = "test-status";
site.components[0].componentId = "api";

test("only a flagged published notice expands to confirmed subscribers", async () => {
  const db = new Database(":memory:");
  const subscribers = new SqliteSubscriptionRepository(db);
  const service = new SubscriptionService(subscribers, {
    siteId: "test-status",
    lookupPepper: "lookup-test-pepper-with-enough-entropy",
    confirmationPepper: "confirmation-test-pepper-with-enough-entropy",
    unsubscribePepper: "unsubscribe-test-pepper-with-enough-entropy",
    confirmationTtlSeconds: 3600,
    resendCooldownSeconds: 300,
    now: () => new Date("2026-09-14T09:00:00.000Z"),
  });
  const notices = new SqliteNotificationRepository(db);
  const curated = new CuratedStore(db, site);
  await service.requestSubscription("person@example.com");
  const token = subscribers.pendingConfirmations(1)[0].token;
  expect(await service.confirm(token)).toBe("confirmed");

  const incident: Incident = {
    slug: "api-outage",
    revision: 1,
    title: "API outage",
    state: "investigating",
    impact: "major_outage",
    affectedComponents: ["api"],
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
  expect(notices.expandNext("test-status", "2026-09-14T09:01:00.000Z")).toBe(false);
  const resolved: Incident = {
    ...incident,
    revision: 2,
    state: "resolved",
    resolvedAt: "2026-09-14T09:05:00.000Z",
    updates: [
      ...incident.updates,
      {
        id: "resolved",
        state: "resolved",
        message: "Service is restored.",
        publishedAt: "2026-09-14T09:05:00.000Z",
      },
    ],
  };
  curated.save("incident", resolved, 1, "test", "resolve", true);
  expect(notices.expandNext("test-status", "2026-09-14T09:06:00.000Z")).toBe(true);
  expect(notices.expandNext("test-status", "2026-09-14T09:06:00.000Z")).toBe(false);
  const claimed = notices.claimNext("test-status", "2026-09-14T09:06:00.000Z");
  expect(claimed).toMatchObject({
    kind: "incident",
    revision: 2,
    normalizedEmail: "person@example.com",
  });
  if (!claimed) throw new Error("Delivery was not created");
  expect(notices.markSent(claimed, "ses-message-id", "2026-09-14T09:06:01.000Z")).toBe(true);
  expect(notices.claimNext("test-status", "2026-09-14T09:07:00.000Z")).toBeNull();
  expect(db.query("SELECT state, provider_message_id FROM notification_deliveries").get()).toEqual({
    state: "sent",
    provider_message_id: "ses-message-id",
  });
  db.close();
});

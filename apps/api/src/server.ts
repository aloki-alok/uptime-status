import { Database } from "bun:sqlite";
import { readFile } from "node:fs/promises";
import { type SiteConfig, siteConfigIssues } from "@uptime-status/domain";
import { createApp } from "./app";
import { SesFeedbackConsumer } from "./delivery/feedback";
import { SesMailSender } from "./delivery/ses";
import { SqliteNotificationRepository } from "./delivery/sqlite-notifications";
import { DeliveryWorker } from "./delivery/worker";
import { SubscriptionService } from "./subscriptions/service";
import { SqliteSubscriptionRepository } from "./subscriptions/sqlite-repository";
import { emailKey } from "./subscriptions/tokens";

function required(name: string) {
  const value = Bun.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function secret(name: string) {
  const value = required(name);
  if (new TextEncoder().encode(value).byteLength < 32) {
    throw new Error(`${name} must contain at least 32 bytes`);
  }
  return value;
}

const sitePath = required("STATUS_SITE_CONFIG");
const parsed: unknown = JSON.parse(await readFile(sitePath, "utf8"));
const issues = siteConfigIssues(parsed);
if (issues.length) {
  throw new Error(`Invalid site configuration: ${issues[0].path}: ${issues[0].message}`);
}
const site = parsed as SiteConfig;
if (!site.subscriptions.enabled || site.subscriptions.delivery.provider !== "ses") {
  throw new Error("The status API requires enabled SES subscriptions");
}
const configuredSite = site as SiteConfig & {
  subscriptions: Extract<SiteConfig["subscriptions"], { enabled: true }>;
};
const publicBaseUrl = required("STATUS_PUBLIC_BASE_URL");
if (!/^https:\/\/[a-z0-9.-]+$/.test(publicBaseUrl)) {
  throw new Error("STATUS_PUBLIC_BASE_URL must be an HTTPS origin");
}
const lookupPepper = secret("STATUS_LOOKUP_PEPPER");
const confirmationPepper = secret("STATUS_CONFIRMATION_PEPPER");
const unsubscribePepper = secret("STATUS_UNSUBSCRIBE_PEPPER");
const rateLimitPepper = secret("STATUS_RATE_LIMIT_PEPPER");
const db = new Database(required("STATUS_DATABASE"));
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA busy_timeout = 5000;");
const subscribers = new SqliteSubscriptionRepository(db);
const notices = new SqliteNotificationRepository(db);
const service = new SubscriptionService(subscribers, {
  siteId: site.siteId,
  lookupPepper,
  confirmationPepper,
  unsubscribePepper,
  confirmationTtlSeconds: site.subscriptions.confirmationTtlSeconds,
  resendCooldownSeconds: site.subscriptions.resendCooldownSeconds,
});
const sender = new SesMailSender(
  site.subscriptions.delivery.region,
  required("STATUS_SES_CONFIGURATION_SET"),
  required("STATUS_SITE_ROOT"),
);
const worker = new DeliveryWorker(
  configuredSite,
  publicBaseUrl,
  subscribers,
  service,
  notices,
  sender,
);
const feedback = new SesFeedbackConsumer(
  site.subscriptions.delivery.region,
  required("STATUS_SES_FEEDBACK_QUEUE_URL"),
  site.siteId,
  lookupPepper,
  service,
);

const app = createApp({
  subscriptions: {
    acceptanceEnabled: Bun.env.STATUS_SUBSCRIPTION_ACCEPTANCE_ENABLED === "true",
    service,
    allowRequest: async (request) => {
      const ip = request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
      if (!ip || ip.length > 64) return false;
      const key = await emailKey(site.siteId, `ip:${ip}`, rateLimitPepper);
      return subscribers.consumeRateLimit(key, Math.floor(Date.now() / 1000), 600, 5);
    },
  },
});

let delivering = false;
async function deliver() {
  if (delivering) return;
  delivering = true;
  try {
    const result = await worker.runOnce();
    if (result.confirmationsSent || result.notificationsSent) {
      console.log(JSON.stringify({ event: "mail.delivered", ...result }));
    }
  } catch {
    console.error(JSON.stringify({ event: "mail.worker_failed" }));
  } finally {
    delivering = false;
  }
}

let pollingFeedback = false;
async function consumeFeedback() {
  if (pollingFeedback) return;
  pollingFeedback = true;
  try {
    const result = await feedback.runOnce();
    if (result.suppressed) console.log(JSON.stringify({ event: "mail.suppressed", ...result }));
  } catch {
    console.error(JSON.stringify({ event: "mail.feedback_failed" }));
  } finally {
    pollingFeedback = false;
  }
}

const port = Number(Bun.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT is invalid");
app.listen({ hostname: "0.0.0.0", port });
setInterval(deliver, 15_000);
setInterval(consumeFeedback, 30_000);
void deliver();
void consumeFeedback();
console.log(JSON.stringify({ event: "server.started", port, service: "uptime-status-api" }));

import { issueUnsubscribeToken } from "@uptime-status/api/subscriptions/tokens";
import {
  type NotificationEvent,
  validateNotificationEventShape,
} from "@uptime-status/domain/notification";
import { renderStatusMail } from "@uptime-status/email";
import type { SubscriptionQueueMessage } from "../subscriptions/d1-repository";
import { createResendTransport, MailTransportError } from "../subscriptions/resend-transport";
import { buildSubscriptionRuntime, type SubscriptionRuntimeEnv } from "../subscriptions/runtime";
import { D1NotificationRepository, type NotificationQueueMessage } from "./d1-repository";

export type NotificationRuntimeEnv = Omit<SubscriptionRuntimeEnv, "SUBSCRIPTION_CONFIRMATIONS"> & {
  NOTIFICATION_DELIVERY_ENABLED: string;
  // One binding carries confirmation and notification work; consumers dispatch on `kind`.
  SUBSCRIPTION_CONFIRMATIONS: Queue<SubscriptionQueueMessage | NotificationQueueMessage>;
};

const AUDIENCE_PAGE_SIZE = 100;
const MAX_EXPANSION_PAGES_PER_RUN = 10;
const RETRY_DELAY_SECONDS = 60;

/**
 * Web Crypto twin of the authoring-side `notificationEventId`. Workers have no `node:crypto`, and
 * the identity must hash identically or a legitimately authored event would be rejected here.
 */
async function notificationEventId(event: NotificationEvent) {
  const identity = [
    event.siteId,
    event.source.kind,
    event.source.slug,
    event.type,
    event.contentRevision,
  ];
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(identity)),
  );
  return `evt_${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function notificationRepository(env: NotificationRuntimeEnv) {
  const database = env.SUBSCRIPTIONS_DATABASE;
  return import("../subscriptions/d1-repository").then(
    ({ cloudflareDatabase }) => new D1NotificationRepository(cloudflareDatabase(database)),
  );
}

async function runtime(env: NotificationRuntimeEnv) {
  const subscriptions = await buildSubscriptionRuntime(env);
  return {
    ...subscriptions,
    deliveryEnabled:
      subscriptions.site.subscriptions.notificationFanoutEnabled === true &&
      env.NOTIFICATION_DELIVERY_ENABLED === "true",
    notifications: await notificationRepository(env),
  };
}

async function expandEvent(
  repository: D1NotificationRepository,
  eventId: string,
  now: string,
  maximumPages = MAX_EXPANSION_PAGES_PER_RUN,
) {
  let deliveriesCreated = 0;
  let complete = false;
  for (let page = 0; page < maximumPages && !complete; page += 1) {
    const result = await repository.expandAudience(eventId, now, AUDIENCE_PAGE_SIZE);
    deliveriesCreated += result.created;
    complete = result.complete;
  }
  return { deliveriesCreated, complete };
}

export async function publishNotificationEvent(
  event: NotificationEvent,
  env: NotificationRuntimeEnv,
) {
  if (
    !validateNotificationEventShape(event) ||
    event.eventId !== (await notificationEventId(event))
  ) {
    throw new TypeError("Notification event is invalid");
  }
  const current = await runtime(env);
  if (!current.deliveryEnabled) return { kind: "disabled" as const };
  if (event.siteId !== current.site.siteId) {
    throw new TypeError("Notification event does not belong to this site");
  }

  const now = new Date().toISOString();
  const creation = await current.notifications.createEvent(event, now, now);
  if (creation === "conflict") throw new Error("Notification event identity conflicts");
  const expanded = await expandEvent(current.notifications, event.eventId, now);
  const enqueued = await current.notifications.enqueuePending(
    current.site.siteId,
    env.SUBSCRIPTION_CONFIRMATIONS,
    now,
  );
  return {
    kind: "ready" as const,
    eventId: event.eventId,
    created: creation === "created",
    deliveriesCreated: expanded.deliveriesCreated,
    expansionComplete: expanded.complete,
    enqueued,
  };
}

function attachmentUrl(path: string, current: Awaited<ReturnType<typeof runtime>>) {
  const templates = current.site.subscriptions.templates;
  const name =
    path === templates?.logoPath
      ? "mail-logo"
      : path === templates?.headerMedia?.path
        ? "mail-header"
        : null;
  const extension = path.match(/\.[A-Za-z0-9]+$/)?.[0];
  if (!name || !extension) throw new Error("Mail attachment is not a published site asset");
  return `${current.publicBaseUrl}/site-assets/${name}${extension.toLowerCase()}`;
}

function mailEvent(event: NotificationEvent) {
  // `in` narrows the union directly; `event.source.kind` is nested and does not narrow `event`.
  if ("startsAt" in event && "endsAt" in event) {
    return {
      kind: "maintenance" as const,
      eventId: event.eventId,
      title: event.title,
      message: event.message,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      publishedAt: event.publishedAt,
    };
  }
  return {
    kind: event.type === "incident_resolved" ? ("resolved" as const) : ("incident" as const),
    eventId: event.eventId,
    title: event.title,
    message: event.message,
    publishedAt: event.publishedAt,
  };
}

export async function processNotificationQueue(
  batch: MessageBatch<NotificationQueueMessage>,
  env: NotificationRuntimeEnv,
  fetcher: typeof globalThis.fetch = globalThis.fetch,
  // Retry windows are compared against the repair clock, so both halves must read the same time source.
  clock: () => Date = () => new Date(),
) {
  const current = await runtime(env);
  if (!current.deliveryEnabled) {
    batch.retryAll({ delaySeconds: 300 });
    return;
  }
  const transport = createResendTransport({
    apiKey: current.resendApiKey,
    fetch: fetcher,
    resolveAttachmentPath: (path) => attachmentUrl(path, current),
  });

  for (const message of batch.messages) {
    let claimed: Awaited<ReturnType<D1NotificationRepository["claim"]>> = null;
    try {
      claimed = await current.notifications.claim(message.body, message.id, clock().toISOString());
      if (!claimed) {
        message.ack();
        continue;
      }
      const subscriber = await current.repository.get(claimed.siteId, claimed.emailKey);
      if (
        subscriber?.status !== "active" ||
        subscriber.tokenVersion !== claimed.subscriberTokenVersion
      ) {
        await current.notifications.cancel(
          claimed.eventId,
          claimed.emailKey,
          "subscriber_ineligible",
          clock().toISOString(),
        );
        message.ack();
        continue;
      }
      const unsubscribeToken = await issueUnsubscribeToken({
        siteId: claimed.siteId,
        emailKey: claimed.emailKey,
        version: claimed.subscriberTokenVersion,
        unsubscribePepper: env.UNSUBSCRIBE_PEPPER,
      });
      const mail = renderStatusMail({
        site: current.site,
        recipient: claimed.normalizedEmail,
        publicBaseUrl: current.publicBaseUrl,
        event: mailEvent(claimed.event),
        unsubscribeToken,
        deliveryId: `${claimed.eventId}:${claimed.emailKey}`,
      });
      const receipt = await transport.send(mail);
      const committed = await current.notifications.markSent(
        claimed.eventId,
        claimed.emailKey,
        claimed.claimId,
        receipt.providerMessageId,
        clock().toISOString(),
      );
      if (!committed) throw new Error("Sent notification could not be committed");
      message.ack();
    } catch (error) {
      const retryable = !(error instanceof MailTransportError) || error.retryable;
      if (claimed) {
        const now = clock();
        const recorded = await current.notifications.markFailed(
          claimed.eventId,
          claimed.emailKey,
          claimed.claimId,
          error instanceof MailTransportError ? "provider_rejected" : "delivery_failed",
          now.toISOString(),
          retryable
            ? new Date(now.getTime() + RETRY_DELAY_SECONDS * 1000).toISOString()
            : undefined,
        );
        if (recorded) {
          message.ack();
        } else {
          message.retry({ delaySeconds: RETRY_DELAY_SECONDS });
        }
      } else {
        message.retry({ delaySeconds: RETRY_DELAY_SECONDS });
      }
      console.error(JSON.stringify({ kind: "notification-delivery-failed", retryable }));
    }
  }
}

export async function repairNotificationFanout(env: NotificationRuntimeEnv, now = new Date()) {
  const current = await runtime(env);
  if (!current.deliveryEnabled) return { kind: "disabled" as const };
  const timestamp = now.toISOString();
  const eventIds = await current.notifications.listExpandableEventIds(current.site.siteId);
  let deliveriesCreated = 0;
  for (const eventId of eventIds) {
    const result = await expandEvent(current.notifications, eventId, timestamp, 1);
    deliveriesCreated += result.deliveriesCreated;
  }
  const enqueued = await current.notifications.enqueuePending(
    current.site.siteId,
    env.SUBSCRIPTION_CONFIRMATIONS,
    timestamp,
  );
  return { kind: "repaired" as const, deliveriesCreated, enqueued };
}

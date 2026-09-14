import { createHash } from "node:crypto";
import type { Incident, Maintenance, SiteConfig } from "@uptime-status/domain";
import { renderStatusMail } from "@uptime-status/email";
import type { SubscriptionService } from "../subscriptions/service";
import type { SqliteSubscriptionRepository } from "../subscriptions/sqlite-repository";
import type { MailSender } from "./ses";
import type { ClaimedDelivery, SqliteNotificationRepository } from "./sqlite-notifications";

function retryable(error: unknown) {
  const name = error instanceof Error ? error.name : "";
  return !["MessageRejected", "BadRequestException", "NotFoundException"].includes(name);
}

function deliveryId(delivery: ClaimedDelivery) {
  const identity = [
    delivery.siteId,
    delivery.kind,
    delivery.slug,
    delivery.revision,
    delivery.emailKey,
  ];
  return `delivery_${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}

function noticeMailEvent(delivery: ClaimedDelivery, site: SiteConfig) {
  const notice = delivery.notice;
  const update = notice.updates.at(-1);
  if (!update) throw new Error("Notification intent has no customer update");
  const names = new Map(
    site.components.map((component) => [component.componentId, component.name]),
  );
  const affectedServices = notice.affectedComponents.map((slug) => {
    const name = names.get(slug);
    if (!name) throw new Error("Notification intent names an unknown component");
    return name;
  });
  const eventId = `${delivery.kind}:${delivery.slug}:${delivery.revision}`;
  if (delivery.kind === "maintenance") {
    const maintenance = notice as Maintenance;
    return {
      kind: "maintenance" as const,
      eventId,
      title: maintenance.title,
      message: update.message,
      startsAt: maintenance.startsAt,
      endsAt: maintenance.endsAt,
      publishedAt: update.publishedAt,
      affectedServices,
    };
  }
  const incident = notice as Incident;
  return {
    kind: incident.state === "resolved" ? ("resolved" as const) : ("incident" as const),
    eventId,
    title: incident.title,
    message: update.message,
    publishedAt: update.publishedAt,
    affectedServices,
  };
}

export class DeliveryWorker {
  constructor(
    private readonly site: SiteConfig & {
      subscriptions: Extract<SiteConfig["subscriptions"], { enabled: true }>;
    },
    private readonly publicBaseUrl: string,
    private readonly subscribers: SqliteSubscriptionRepository,
    private readonly service: SubscriptionService,
    private readonly notices: SqliteNotificationRepository,
    private readonly sender: MailSender,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async runOnce() {
    let confirmationsSent = 0;
    let notificationsSent = 0;
    const pending = this.subscribers.pendingConfirmations(10, this.now().toISOString());
    for (const item of pending) {
      try {
        const current = await this.subscribers.get(item.siteId, item.emailKey);
        if (current?.status !== "pending" || current.tokenVersion !== item.tokenVersion) {
          this.subscribers.markConfirmationSkipped(item.outboxId);
          continue;
        }
        const expiresAt = new Date(
          Date.parse(item.createdAt) + this.site.subscriptions.confirmationTtlSeconds * 1000,
        ).toISOString();
        if (this.now().toISOString() > expiresAt) {
          this.subscribers.markConfirmationSkipped(item.outboxId);
          continue;
        }
        const mail = renderStatusMail({
          site: this.site,
          recipient: item.normalizedEmail,
          publicBaseUrl: this.publicBaseUrl,
          event: {
            kind: "confirmation",
            eventId: `${item.emailKey}:${item.tokenVersion}`,
            token: item.token,
            expiresAt,
          },
        });
        const providerId = await this.sender.send(mail);
        if (
          !this.subscribers.markConfirmationSent(
            item.outboxId,
            providerId,
            this.now().toISOString(),
          )
        ) {
          throw new Error("Sent confirmation could not be recorded");
        }
        confirmationsSent += 1;
      } catch (error) {
        this.subscribers.failConfirmation(
          item.outboxId,
          this.now().toISOString(),
          retryable(error),
        );
        console.error(
          JSON.stringify({ event: "confirmation.delivery_failed", retryable: retryable(error) }),
        );
      }
    }

    if (this.site.subscriptions.notificationFanoutEnabled) {
      for (let index = 0; index < 10; index += 1) {
        if (!this.notices.expandNext(this.site.siteId, this.now().toISOString())) break;
      }
      for (let index = 0; index < 20; index += 1) {
        const delivery = this.notices.claimNext(this.site.siteId, this.now().toISOString());
        if (!delivery) break;
        try {
          const current = this.subscribers.activeSubscriber(delivery.siteId, delivery.emailKey);
          if (!current || current.tokenVersion !== delivery.subscriberTokenVersion) {
            this.notices.cancel(delivery, this.now().toISOString());
            continue;
          }
          const unsubscribeToken = await this.service.createUnsubscribeToken(delivery.emailKey);
          if (!unsubscribeToken) {
            this.notices.cancel(delivery, this.now().toISOString());
            continue;
          }
          const mail = renderStatusMail({
            site: this.site,
            recipient: delivery.normalizedEmail,
            publicBaseUrl: this.publicBaseUrl,
            event: noticeMailEvent(delivery, this.site),
            unsubscribeToken,
            deliveryId: deliveryId(delivery),
          });
          const providerId = await this.sender.send(mail);
          if (!this.notices.markSent(delivery, providerId, this.now().toISOString())) {
            throw new Error("Sent notification could not be recorded");
          }
          notificationsSent += 1;
        } catch (error) {
          this.notices.fail(delivery, this.now().toISOString(), retryable(error));
          console.error(
            JSON.stringify({ event: "notice.delivery_failed", retryable: retryable(error) }),
          );
        }
      }
    }
    return { confirmationsSent, notificationsSent };
  }
}

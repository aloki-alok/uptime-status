import type { SubscriptionAccepted } from "@uptime-status/domain";
import { normalizeEmail } from "./normalize-email";
import type {
  ConfirmationOutboxRecord,
  SubscriberRecord,
  SubscriptionRepository,
} from "./repository";
import {
  emailKey,
  issueConfirmationToken,
  issueUnsubscribeToken,
  parseConfirmationToken,
  verifyConfirmationToken,
  verifyUnsubscribeToken,
} from "./tokens";

const ACCEPTED: SubscriptionAccepted = { status: "accepted" };

export type ConfirmationOutcome = "confirmed" | "expired" | "invalid";
export type UnsubscribeOutcome = "unsubscribed" | "invalid";

type ServiceOptions = {
  siteId: string;
  lookupPepper: string;
  confirmationPepper: string;
  unsubscribePepper: string;
  confirmationTtlSeconds: number;
  resendCooldownSeconds: number;
  now?: () => Date;
  tokenSecret?: () => Uint8Array;
};

function addSeconds(value: Date, seconds: number) {
  return new Date(value.getTime() + seconds * 1000).toISOString();
}

function confirmationDue(record: SubscriberRecord, now: Date, cooldownSeconds: number) {
  if (record.status === "unsubscribed") return true;
  if (record.status !== "pending" || !record.confirmationSentAt) return false;
  return now.getTime() - Date.parse(record.confirmationSentAt) >= cooldownSeconds * 1000;
}

export class SubscriptionService {
  private readonly now: () => Date;
  private readonly tokenSecret: () => Uint8Array | undefined;

  constructor(
    private readonly repository: SubscriptionRepository,
    private readonly options: ServiceOptions,
  ) {
    if (options.confirmationTtlSeconds <= options.resendCooldownSeconds) {
      throw new Error("Confirmation TTL must exceed the resend cooldown");
    }
    this.now = options.now ?? (() => new Date());
    this.tokenSecret = options.tokenSecret ?? (() => undefined);
  }

  async requestSubscription(emailInput: unknown): Promise<SubscriptionAccepted> {
    const normalizedEmail = normalizeEmail(emailInput);
    if (!normalizedEmail) throw new Error("Invalid email address");
    const key = await emailKey(this.options.siteId, normalizedEmail, this.options.lookupPepper);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = await this.repository.get(this.options.siteId, key);
      const now = this.now();
      if (current && !confirmationDue(current, now, this.options.resendCooldownSeconds)) {
        return ACCEPTED;
      }

      const tokenVersion = (current?.tokenVersion ?? 0) + 1;
      const issued = await issueConfirmationToken({
        siteId: this.options.siteId,
        emailKey: key,
        version: tokenVersion,
        confirmationPepper: this.options.confirmationPepper,
        secret: this.tokenSecret(),
      });
      const timestamp = now.toISOString();
      const record: SubscriberRecord = {
        siteId: this.options.siteId,
        emailKey: key,
        normalizedEmail,
        status: "pending",
        revision: (current?.revision ?? 0) + 1,
        tokenVersion,
        confirmationTokenHash: issued.tokenHash,
        confirmationExpiresAt: addSeconds(now, this.options.confirmationTtlSeconds),
        confirmationSentAt: timestamp,
        confirmedAt: current?.confirmedAt ?? null,
        unsubscribedAt: null,
        suppressedAt: null,
        suppressionReason: null,
        createdAt: current?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      const outbox: ConfirmationOutboxRecord = {
        kind: "subscription-confirmation",
        outboxId: `${this.options.siteId}:${key}:${tokenVersion}`,
        siteId: this.options.siteId,
        emailKey: key,
        normalizedEmail,
        token: issued.token,
        tokenVersion,
        createdAt: timestamp,
      };
      const result = await this.repository.commit({
        record,
        expectedRevision: current?.revision ?? null,
        outbox,
      });
      if (result.committed) return ACCEPTED;
    }

    throw new Error("Subscription state changed too frequently");
  }

  async confirm(token: string): Promise<ConfirmationOutcome> {
    const parsed = parseConfirmationToken(token);
    if (!parsed) return "invalid";

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = await this.repository.get(this.options.siteId, parsed.emailKey);
      if (
        !current ||
        current.tokenVersion !== parsed.version ||
        !current.confirmationTokenHash ||
        !(await verifyConfirmationToken({
          siteId: this.options.siteId,
          token,
          expectedHash: current.confirmationTokenHash,
          confirmationPepper: this.options.confirmationPepper,
        }))
      ) {
        return "invalid";
      }
      if (current.status === "active") return "confirmed";
      if (current.status !== "pending" || !current.confirmationExpiresAt) return "invalid";
      const now = this.now();
      if (now.getTime() > Date.parse(current.confirmationExpiresAt)) return "expired";

      const timestamp = now.toISOString();
      const record: SubscriberRecord = {
        ...current,
        status: "active",
        revision: current.revision + 1,
        confirmedAt: timestamp,
        updatedAt: timestamp,
      };
      const result = await this.repository.commit({
        record,
        expectedRevision: current.revision,
      });
      if (result.committed) return "confirmed";
    }

    return "invalid";
  }

  async createUnsubscribeToken(emailKeyValue: string) {
    const current = await this.repository.get(this.options.siteId, emailKeyValue);
    if (current?.status !== "active") return null;
    return issueUnsubscribeToken({
      siteId: this.options.siteId,
      emailKey: current.emailKey,
      version: current.tokenVersion,
      unsubscribePepper: this.options.unsubscribePepper,
    });
  }

  async unsubscribe(token: string): Promise<UnsubscribeOutcome> {
    const parsed = parseConfirmationToken(token);
    if (!parsed) return "invalid";

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = await this.repository.get(this.options.siteId, parsed.emailKey);
      if (
        !current ||
        current.tokenVersion !== parsed.version ||
        !(await verifyUnsubscribeToken({
          siteId: this.options.siteId,
          token,
          unsubscribePepper: this.options.unsubscribePepper,
        }))
      ) {
        return "invalid";
      }
      if (current.status === "unsubscribed" || current.status === "suppressed") {
        return "unsubscribed";
      }
      if (current.status !== "active") return "invalid";

      const timestamp = this.now().toISOString();
      const result = await this.repository.commit({
        expectedRevision: current.revision,
        record: {
          ...current,
          status: "unsubscribed",
          revision: current.revision + 1,
          confirmationTokenHash: null,
          confirmationExpiresAt: null,
          unsubscribedAt: timestamp,
          updatedAt: timestamp,
        },
      });
      if (result.committed) return "unsubscribed";
    }

    return "invalid";
  }

  async suppress(emailKeyValue: string, reason: string) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = await this.repository.get(this.options.siteId, emailKeyValue);
      if (!current) return false;
      if (current.status === "suppressed") return true;
      const timestamp = this.now().toISOString();
      const result = await this.repository.commit({
        expectedRevision: current.revision,
        record: {
          ...current,
          status: "suppressed",
          revision: current.revision + 1,
          confirmationTokenHash: null,
          confirmationExpiresAt: null,
          suppressedAt: timestamp,
          suppressionReason: reason,
          updatedAt: timestamp,
        },
      });
      if (result.committed) return true;
    }
    return false;
  }
}

import type { SubscriberStatus } from "@uptime-status/domain/subscription";

export type SubscriberRecord = {
  siteId: string;
  emailKey: string;
  normalizedEmail: string;
  status: SubscriberStatus;
  revision: number;
  tokenVersion: number;
  confirmationTokenHash: string | null;
  confirmationExpiresAt: string | null;
  confirmationSentAt: string | null;
  confirmedAt: string | null;
  unsubscribedAt: string | null;
  suppressedAt: string | null;
  suppressionReason: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ConfirmationOutboxRecord = {
  kind: "subscription-confirmation";
  outboxId: string;
  siteId: string;
  emailKey: string;
  normalizedEmail: string;
  token: string;
  tokenVersion: number;
  createdAt: string;
};

export type SubscriptionCommit = {
  record: SubscriberRecord;
  expectedRevision: number | null;
  outbox?: ConfirmationOutboxRecord;
};

export type SubscriptionCommitResult =
  | { committed: true; record: SubscriberRecord }
  | { committed: false; current: SubscriberRecord | null };

export interface SubscriptionRepository {
  get(siteId: string, emailKey: string): Promise<SubscriberRecord | null>;
  commit(input: SubscriptionCommit): Promise<SubscriptionCommitResult>;
}

export class InMemorySubscriptionRepository implements SubscriptionRepository {
  readonly records = new Map<string, SubscriberRecord>();
  readonly confirmationOutbox: ConfirmationOutboxRecord[] = [];

  private key(siteId: string, emailKey: string) {
    return `${siteId}\u0000${emailKey}`;
  }

  async get(siteId: string, emailKey: string) {
    return this.records.get(this.key(siteId, emailKey)) ?? null;
  }

  async commit(input: SubscriptionCommit): Promise<SubscriptionCommitResult> {
    const key = this.key(input.record.siteId, input.record.emailKey);
    const current = this.records.get(key) ?? null;
    const currentRevision = current?.revision ?? null;
    if (currentRevision !== input.expectedRevision) {
      return { committed: false, current };
    }

    const stored = structuredClone(input.record);
    this.records.set(key, stored);
    if (input.outbox) this.confirmationOutbox.push(structuredClone(input.outbox));
    return { committed: true, record: stored };
  }
}

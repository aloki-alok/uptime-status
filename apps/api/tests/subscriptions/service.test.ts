import { describe, expect, test } from "bun:test";
import { InMemorySubscriptionRepository } from "../../src/subscriptions/repository";
import { SubscriptionService } from "../../src/subscriptions/service";

const lookupPepper = "lookup-test-pepper-with-enough-entropy";
const confirmationPepper = "confirmation-test-pepper-with-enough-entropy";
const unsubscribePepper = "unsubscribe-test-pepper-with-enough-entropy";

function harness(start = "2026-09-08T10:00:00.000Z") {
  let now = new Date(start);
  let secret = 1;
  const repository = new InMemorySubscriptionRepository();
  const service = new SubscriptionService(repository, {
    siteId: "site-a",
    lookupPepper,
    confirmationPepper,
    unsubscribePepper,
    confirmationTtlSeconds: 3600,
    resendCooldownSeconds: 300,
    now: () => now,
    tokenSecret: () => new Uint8Array(32).fill(secret++),
  });
  return {
    repository,
    service,
    advance(milliseconds: number) {
      now = new Date(now.getTime() + milliseconds);
    },
  };
}

describe("subscription state service", () => {
  test("creates one pending subscriber and one confirmation outbox record", async () => {
    const { repository, service } = harness();
    expect(await service.requestSubscription(" Person@Example.com ")).toEqual({
      status: "accepted",
    });
    expect(repository.records.size).toBe(1);
    expect(repository.confirmationOutbox).toHaveLength(1);
    expect(repository.confirmationOutbox[0].normalizedEmail).toBe("person@example.com");
    expect(Array.from(repository.records.values())[0]).toMatchObject({
      status: "pending",
      revision: 1,
      tokenVersion: 1,
    });
  });

  test("does not enumerate or resend active and cooldown-bound subscriptions", async () => {
    const { repository, service, advance } = harness();
    await service.requestSubscription("person@example.com");
    await service.requestSubscription("person@example.com");
    expect(repository.confirmationOutbox).toHaveLength(1);

    const token = repository.confirmationOutbox[0].token;
    expect(await service.confirm(token)).toBe("confirmed");
    expect(await service.confirm(token)).toBe("confirmed");
    advance(600_000);
    expect(await service.requestSubscription("person@example.com")).toEqual({
      status: "accepted",
    });
    expect(repository.confirmationOutbox).toHaveLength(1);
  });

  test("rotates pending tokens only after the resend cooldown", async () => {
    const { repository, service, advance } = harness();
    await service.requestSubscription("person@example.com");
    const firstToken = repository.confirmationOutbox[0].token;
    advance(301_000);
    await service.requestSubscription("person@example.com");
    expect(repository.confirmationOutbox).toHaveLength(2);
    expect(repository.confirmationOutbox[1].token).not.toBe(firstToken);
    expect(await service.confirm(firstToken)).toBe("invalid");
    expect(await service.confirm(repository.confirmationOutbox[1].token)).toBe("confirmed");
  });

  test("rejects expired and cross-site confirmation tokens", async () => {
    const { repository, service, advance } = harness();
    await service.requestSubscription("person@example.com");
    const token = repository.confirmationOutbox[0].token;
    advance(3_601_000);
    expect(await service.confirm(token)).toBe("expired");

    const other = new SubscriptionService(repository, {
      siteId: "site-b",
      lookupPepper,
      confirmationPepper,
      unsubscribePepper,
      confirmationTtlSeconds: 3600,
      resendCooldownSeconds: 300,
    });
    expect(await other.confirm(token)).toBe("invalid");
  });

  test("commits only one confirmation request under a creation race", async () => {
    const { repository, service } = harness();
    await Promise.all([
      service.requestSubscription("person@example.com"),
      service.requestSubscription("person@example.com"),
      service.requestSubscription("person@example.com"),
    ]);
    expect(repository.records.size).toBe(1);
    expect(repository.confirmationOutbox).toHaveLength(1);
  });

  test("suppression is monotonic and prevents resubscription", async () => {
    const { repository, service, advance } = harness();
    await service.requestSubscription("person@example.com");
    const record = Array.from(repository.records.values())[0];
    expect(await service.suppress(record.emailKey, "hard-bounce")).toBe(true);
    expect(await service.suppress(record.emailKey, "complaint")).toBe(true);
    advance(600_000);
    await service.requestSubscription("person@example.com");
    expect(repository.confirmationOutbox).toHaveLength(1);
    expect(Array.from(repository.records.values())[0]).toMatchObject({
      status: "suppressed",
      suppressionReason: "hard-bounce",
    });
  });

  test("issues unsubscribe tokens only for active subscribers", async () => {
    const { repository, service } = harness();
    await service.requestSubscription("person@example.com");
    const record = Array.from(repository.records.values())[0];
    expect(await service.createUnsubscribeToken(record.emailKey)).toBeNull();

    await service.confirm(repository.confirmationOutbox[0].token);
    expect(await service.createUnsubscribeToken(record.emailKey)).toStartWith("v1.");
    expect(await service.createUnsubscribeToken("missing")).toBeNull();
  });

  test("unsubscribes active subscribers idempotently", async () => {
    const { repository, service } = harness();
    await service.requestSubscription("person@example.com");
    await service.confirm(repository.confirmationOutbox[0].token);
    const active = Array.from(repository.records.values())[0];
    const token = await service.createUnsubscribeToken(active.emailKey);
    expect(token).not.toBeNull();

    expect(await service.unsubscribe(token ?? "")).toBe("unsubscribed");
    expect(await service.unsubscribe(token ?? "")).toBe("unsubscribed");
    expect(Array.from(repository.records.values())[0]).toMatchObject({
      status: "unsubscribed",
      revision: 3,
    });
  });

  test("invalidates old unsubscribe links after a new confirmed opt-in", async () => {
    const { repository, service } = harness();
    await service.requestSubscription("person@example.com");
    await service.confirm(repository.confirmationOutbox[0].token);
    const first = Array.from(repository.records.values())[0];
    const oldToken = await service.createUnsubscribeToken(first.emailKey);
    await service.unsubscribe(oldToken ?? "");

    await service.requestSubscription("person@example.com");
    await service.confirm(repository.confirmationOutbox[1].token);
    expect(await service.unsubscribe(oldToken ?? "")).toBe("invalid");
    expect(Array.from(repository.records.values())[0].status).toBe("active");
  });

  test("keeps suppression monotonic when a valid unsubscribe link is used", async () => {
    const { repository, service } = harness();
    await service.requestSubscription("person@example.com");
    await service.confirm(repository.confirmationOutbox[0].token);
    const active = Array.from(repository.records.values())[0];
    const token = await service.createUnsubscribeToken(active.emailKey);
    await service.suppress(active.emailKey, "complaint");

    expect(await service.unsubscribe(token ?? "")).toBe("unsubscribed");
    expect(Array.from(repository.records.values())[0]).toMatchObject({
      status: "suppressed",
      suppressionReason: "complaint",
    });
  });

  test("rejects tampered and cross-site unsubscribe links", async () => {
    const { repository, service } = harness();
    await service.requestSubscription("person@example.com");
    await service.confirm(repository.confirmationOutbox[0].token);
    const active = Array.from(repository.records.values())[0];
    const token = await service.createUnsubscribeToken(active.emailKey);
    expect(await service.unsubscribe(`${token ?? ""}x`)).toBe("invalid");

    const other = new SubscriptionService(repository, {
      siteId: "site-b",
      lookupPepper,
      confirmationPepper,
      unsubscribePepper,
      confirmationTtlSeconds: 3600,
      resendCooldownSeconds: 300,
    });
    expect(await other.unsubscribe(token ?? "")).toBe("invalid");
  });

  test("rejects invalid addresses and invalid service timing", async () => {
    const { repository, service } = harness();
    expect(service.requestSubscription("bad-address")).rejects.toThrow("Invalid email address");
    expect(
      () =>
        new SubscriptionService(repository, {
          siteId: "site-a",
          lookupPepper,
          confirmationPepper,
          unsubscribePepper,
          confirmationTtlSeconds: 300,
          resendCooldownSeconds: 300,
        }),
    ).toThrow("Confirmation TTL must exceed the resend cooldown");
  });
});

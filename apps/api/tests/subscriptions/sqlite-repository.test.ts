import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SubscriptionService } from "../../src/subscriptions/service";
import { SqliteSubscriptionRepository } from "../../src/subscriptions/sqlite-repository";

const options = {
  siteId: "test-status",
  lookupPepper: "lookup-test-pepper-with-enough-entropy",
  confirmationPepper: "confirmation-test-pepper-with-enough-entropy",
  unsubscribePepper: "unsubscribe-test-pepper-with-enough-entropy",
  confirmationTtlSeconds: 3600,
  resendCooldownSeconds: 300,
  now: () => new Date("2026-09-14T09:00:00.000Z"),
};

test("subscriber confirmation and unsubscribe state survive database reopen", async () => {
  const directory = mkdtempSync(join(tmpdir(), "status-subscribers-"));
  const path = join(directory, "subscribers.sqlite");
  try {
    const firstDb = new Database(path);
    const firstRepository = new SqliteSubscriptionRepository(firstDb);
    const firstService = new SubscriptionService(firstRepository, options);
    expect(await firstService.requestSubscription(" Person@Example.com ")).toEqual({
      status: "accepted",
    });
    const [confirmation] = firstRepository.pendingConfirmations(10);
    expect(confirmation.normalizedEmail).toBe("person@example.com");
    const record = firstDb.query("SELECT status, revision FROM subscribers").get();
    expect(record).toEqual({ status: "pending", revision: 1 });
    firstDb.close();

    const secondDb = new Database(path);
    const secondRepository = new SqliteSubscriptionRepository(secondDb);
    const secondService = new SubscriptionService(secondRepository, options);
    expect(secondRepository.pendingConfirmations(10)[0].token).toBe(confirmation.token);
    const beforeConfirmation = await secondRepository.get("test-status", confirmation.emailKey);
    expect(await secondService.confirm(confirmation.token)).toBe("confirmed");
    if (!beforeConfirmation) throw new Error("Pending subscriber disappeared");
    expect(
      await secondRepository.commit({
        expectedRevision: beforeConfirmation.revision,
        record: { ...beforeConfirmation, revision: beforeConfirmation.revision + 1 },
      }),
    ).toMatchObject({ committed: false });
    const active = secondDb.query("SELECT email_key, status FROM subscribers").get() as {
      email_key: string;
      status: string;
    };
    expect(active.status).toBe("active");
    const unsubscribeToken = await secondService.createUnsubscribeToken(active.email_key);
    expect(await secondService.unsubscribe(unsubscribeToken ?? "")).toBe("unsubscribed");
    secondDb.close();

    const thirdDb = new Database(path);
    const thirdRepository = new SqliteSubscriptionRepository(thirdDb);
    expect((await thirdRepository.get("test-status", active.email_key))?.status).toBe(
      "unsubscribed",
    );
    thirdDb.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

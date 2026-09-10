import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { InMemorySubscriptionRepository } from "../src/subscriptions/repository";
import { SubscriptionService } from "../src/subscriptions/service";

function subscriptionApp(acceptanceEnabled = true) {
  const repository = new InMemorySubscriptionRepository();
  const service = new SubscriptionService(repository, {
    siteId: "site-a",
    lookupPepper: "lookup-test-pepper-with-enough-entropy",
    confirmationPepper: "confirmation-test-pepper-with-enough-entropy",
    unsubscribePepper: "unsubscribe-test-pepper-with-enough-entropy",
    confirmationTtlSeconds: 3600,
    resendCooldownSeconds: 300,
    now: () => new Date("2026-09-08T10:00:00.000Z"),
    tokenSecret: () => new Uint8Array(32).fill(7),
  });
  return {
    repository,
    app: createApp({
      requestId: () => "request-test-0001",
      subscriptions: { acceptanceEnabled, service },
    }),
    service,
  };
}

describe("status API probes", () => {
  test("health probe succeeds", async () => {
    const response = await createApp().handle(new Request("http://localhost/healthz"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  test("readiness probe succeeds", async () => {
    const response = await createApp().handle(new Request("http://localhost/readyz"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ready" });
  });
});

describe("subscription API", () => {
  test("accepts a valid request without exposing subscriber state", async () => {
    const { app, repository } = subscriptionApp();
    const response = await app.handle(
      new Request("http://localhost/api/v1/subscriptions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "Person@example.com" }),
      }),
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "accepted" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(repository.records.size).toBe(1);
  });

  test("uses bounded errors for type, shape, address, size, and disabled delivery", async () => {
    const { app } = subscriptionApp();
    const cases = [
      new Request("http://localhost/api/v1/subscriptions", {
        method: "POST",
        body: "email=person@example.com",
      }),
      new Request("http://localhost/api/v1/subscriptions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "person@example.com", role: "admin" }),
      }),
      new Request("http://localhost/api/v1/subscriptions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "bad-address" }),
      }),
      new Request("http://localhost/api/v1/subscriptions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": "2048",
        },
        body: JSON.stringify({ email: "person@example.com" }),
      }),
    ];
    const statuses = [];
    for (const request of cases) statuses.push((await app.handle(request)).status);
    expect(statuses).toEqual([415, 422, 422, 413]);

    const disabled = subscriptionApp(false).app;
    const unavailable = await disabled.handle(
      new Request("http://localhost/api/v1/subscriptions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "person@example.com" }),
      }),
    );
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({
      error: {
        code: "subscriptions_unavailable",
        message: "Subscriptions are temporarily unavailable",
        requestId: "request-test-0001",
      },
    });
  });

  test("requires an explicit browser post before confirmation and handles replay", async () => {
    const { app, repository } = subscriptionApp();
    await app.handle(
      new Request("http://localhost/api/v1/subscriptions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "person@example.com" }),
      }),
    );
    const token = repository.confirmationOutbox[0].token;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const landing = await app.handle(
        new Request(`http://localhost/api/v1/subscriptions/confirm?token=${token}`),
      );
      expect(landing.status).toBe(303);
      expect(landing.headers.get("location")).toBe("/subscriptions/confirm/");
      expect(Array.from(repository.records.values())[0].status).toBe(
        attempt === 0 ? "pending" : "active",
      );
      const cookie = landing.headers.get("set-cookie");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("Secure");
      expect(cookie).toContain("SameSite=Strict");

      const response = await app.handle(
        new Request("http://localhost/api/v1/subscriptions/confirm", {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: cookie?.split(";", 1)[0] ?? "",
          },
          body: "intent=confirm",
        }),
      );
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/subscriptions/confirmed/");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    }
  });

  test("redirects missing and invalid confirmation tokens without detail", async () => {
    const { app } = subscriptionApp();
    for (const url of [
      "http://localhost/api/v1/subscriptions/confirm",
      "http://localhost/api/v1/subscriptions/confirm?token=invalid",
    ]) {
      const response = await app.handle(new Request(url));
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/subscriptions/invalid/");
    }
  });

  test("keeps confirmation available while new subscription acceptance is paused", async () => {
    const seeded = subscriptionApp();
    await seeded.service.requestSubscription("person@example.com");
    const paused = createApp({
      requestId: () => "request-test-0001",
      subscriptions: { acceptanceEnabled: false, service: seeded.service },
    });
    const landing = await paused.handle(
      new Request(
        `http://localhost/api/v1/subscriptions/confirm?token=${seeded.repository.confirmationOutbox[0].token}`,
      ),
    );
    const response = await paused.handle(
      new Request("http://localhost/api/v1/subscriptions/confirm", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: landing.headers.get("set-cookie")?.split(";", 1)[0] ?? "",
        },
        body: "intent=confirm",
      }),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/subscriptions/confirmed/");
  });

  test("does not confirm scanner GET requests or posts without browser intent", async () => {
    const { app, repository, service } = subscriptionApp();
    await service.requestSubscription("person@example.com");
    const token = repository.confirmationOutbox[0].token;

    const landing = await app.handle(
      new Request(`http://localhost/api/v1/subscriptions/confirm?token=${token}`),
    );
    expect(Array.from(repository.records.values())[0].status).toBe("pending");

    for (const request of [
      new Request("http://localhost/api/v1/subscriptions/confirm", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "intent=confirm",
      }),
      new Request("http://localhost/api/v1/subscriptions/confirm", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: landing.headers.get("set-cookie")?.split(";", 1)[0] ?? "",
        },
        body: "intent=preview",
      }),
    ]) {
      const response = await app.handle(request);
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/subscriptions/invalid/");
    }
    expect(Array.from(repository.records.values())[0].status).toBe("pending");
  });

  test("requires browser confirmation before unsubscribe changes state", async () => {
    const { app, repository, service } = subscriptionApp();
    await service.requestSubscription("person@example.com");
    await service.confirm(repository.confirmationOutbox[0].token);
    const active = Array.from(repository.records.values())[0];
    const token = await service.createUnsubscribeToken(active.emailKey);

    const landing = await app.handle(
      new Request(`http://localhost/api/v1/subscriptions/unsubscribe?token=${token}`),
    );
    expect(landing.status).toBe(303);
    expect(landing.headers.get("location")).toBe("/subscriptions/unsubscribe/");
    expect(Array.from(repository.records.values())[0].status).toBe("active");
    const cookie = landing.headers.get("set-cookie");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");

    const confirmed = await app.handle(
      new Request("http://localhost/api/v1/subscriptions/unsubscribe", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: cookie?.split(";", 1)[0] ?? "",
        },
        body: "intent=unsubscribe",
      }),
    );
    expect(confirmed.status).toBe(303);
    expect(confirmed.headers.get("location")).toBe("/subscriptions/unsubscribed/");
    expect(confirmed.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(Array.from(repository.records.values())[0].status).toBe("unsubscribed");
  });

  test("supports privacy-preserving one-click unsubscribe posts", async () => {
    const { app, repository, service } = subscriptionApp(false);
    await service.requestSubscription("person@example.com");
    await service.confirm(repository.confirmationOutbox[0].token);
    const active = Array.from(repository.records.values())[0];
    const token = await service.createUnsubscribeToken(active.emailKey);

    const multipart = new FormData();
    multipart.set("List-Unsubscribe", "One-Click");
    const cases = [
      { candidate: token, body: "List-Unsubscribe=One-Click" },
      { candidate: token, body: multipart },
      { candidate: "invalid", body: "List-Unsubscribe=One-Click" },
    ];
    for (const { candidate, body } of cases) {
      const headers: Record<string, string> = {
        "list-unsubscribe-post": "List-Unsubscribe=One-Click",
      };
      if (typeof body === "string") {
        headers["content-type"] = "application/x-www-form-urlencoded";
      }
      const response = await app.handle(
        new Request(`http://localhost/api/v1/subscriptions/unsubscribe?token=${candidate}`, {
          method: "POST",
          headers,
          body,
        }),
      );
      expect(response.status).toBe(204);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(Array.from(repository.records.values())[0].status).toBe("unsubscribed");

    const oversized = await app.handle(
      new Request(`http://localhost/api/v1/subscriptions/unsubscribe?token=${token}`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "content-length": "4096",
          "list-unsubscribe-post": "List-Unsubscribe=One-Click",
        },
        body: "List-Unsubscribe=One-Click",
      }),
    );
    expect(oversized.status).toBe(413);
  });

  test("does not expose validity and reports unavailable lifecycle storage", async () => {
    const app = createApp({ requestId: () => "request-test-0001" });
    const response = await app.handle(
      new Request("http://localhost/api/v1/subscriptions/unsubscribe?token=invalid", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "list-unsubscribe-post": "List-Unsubscribe=One-Click",
        },
        body: "List-Unsubscribe=One-Click",
      }),
    );
    expect(response.status).toBe(503);

    const landing = await app.handle(
      new Request("http://localhost/api/v1/subscriptions/unsubscribe?token=invalid"),
    );
    expect(landing.status).toBe(303);
    expect(landing.headers.get("location")).toBe("/subscriptions/unsubscribe-invalid/");
  });
});

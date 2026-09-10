import { describe, expect, test } from "bun:test";
import { verifyResendSuppressionWebhook } from "../../src/subscriptions/resend-webhook";

const now = 1_789_040_000;
const secretBytes = new Uint8Array(32).fill(6);
const secret = `whsec_${btoa(String.fromCharCode(...secretBytes))}`;

async function request(payload: string, options: { timestamp?: number; id?: string } = {}) {
  const timestamp = String(options.timestamp ?? now);
  const id = options.id ?? "msg_webhook_1";
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${id}.${timestamp}.${payload}`),
    ),
  );
  return new Request("https://status.example.com/api/v1/webhooks/resend", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature": `v1,${btoa(String.fromCharCode(...signature))}`,
    },
    body: payload,
  });
}

describe("Resend webhook verification", () => {
  test("verifies and parses terminal delivery events from the raw body", async () => {
    for (const [type, reason] of [
      ["email.bounced", "bounce"],
      ["email.complained", "complaint"],
    ] as const) {
      const payload = JSON.stringify({
        type,
        created_at: "2026-09-10T10:00:00.000Z",
        data: { email_id: "resend-message-1", to: ["person@example.com"] },
      });
      await expect(
        verifyResendSuppressionWebhook(await request(payload), secret, now),
      ).resolves.toEqual({
        eventId: "msg_webhook_1",
        providerMessageId: "resend-message-1",
        reason,
        occurredAt: "2026-09-10T10:00:00.000Z",
      });
    }
  });

  test("rejects tampering, stale signatures, unknown events, and oversized bodies", async () => {
    const validPayload = JSON.stringify({
      type: "email.bounced",
      created_at: "2026-09-10T10:00:00.000Z",
      data: { email_id: "resend-message-1" },
    });
    const tampered = await request(validPayload);
    await expect(
      verifyResendSuppressionWebhook(
        new Request(tampered, { body: validPayload.replace("bounced", "complained") }),
        secret,
        now,
      ),
    ).resolves.toBeNull();
    await expect(
      verifyResendSuppressionWebhook(
        await request(validPayload, { timestamp: now - 301 }),
        secret,
        now,
      ),
    ).resolves.toBeNull();
    await expect(
      verifyResendSuppressionWebhook(
        await request(validPayload.replace("email.bounced", "email.delivered")),
        secret,
        now,
      ),
    ).resolves.toBeNull();
    await expect(
      verifyResendSuppressionWebhook(
        new Request("https://status.example.com/api/v1/webhooks/resend", {
          method: "POST",
          headers: { "content-length": "65537" },
          body: "{}",
        }),
        secret,
        now,
      ),
    ).resolves.toBeNull();
  });
});

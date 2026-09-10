import { describe, expect, test } from "bun:test";
import {
  emailKey,
  issueConfirmationToken,
  issueUnsubscribeToken,
  parseConfirmationToken,
  verifyConfirmationToken,
  verifyUnsubscribeToken,
} from "../../src/subscriptions/tokens";

const lookupPepper = "lookup-test-pepper-with-enough-entropy";
const confirmationPepper = "confirmation-test-pepper-with-enough-entropy";
const unsubscribePepper = "unsubscribe-test-pepper-with-enough-entropy";

describe("subscription confirmation tokens", () => {
  test("keeps email lookup keys stable within one site and isolated across sites", async () => {
    const first = await emailKey("site-a", "person@example.com", lookupPepper);
    expect(await emailKey("site-a", "person@example.com", lookupPepper)).toBe(first);
    expect(await emailKey("site-b", "person@example.com", lookupPepper)).not.toBe(first);
    expect(first).not.toContain("person");
  });

  test("issues parseable tokens and verifies only the matching site and hash", async () => {
    const key = await emailKey("site-a", "person@example.com", lookupPepper);
    const issued = await issueConfirmationToken({
      siteId: "site-a",
      emailKey: key,
      version: 2,
      confirmationPepper,
      secret: new Uint8Array(32).fill(7),
    });

    expect(parseConfirmationToken(issued.token)).toMatchObject({ emailKey: key, version: 2 });
    expect(
      await verifyConfirmationToken({
        siteId: "site-a",
        token: issued.token,
        expectedHash: issued.tokenHash,
        confirmationPepper,
      }),
    ).toBe(true);
    expect(
      await verifyConfirmationToken({
        siteId: "site-b",
        token: issued.token,
        expectedHash: issued.tokenHash,
        confirmationPepper,
      }),
    ).toBe(false);
    expect(issued.tokenHash).not.toContain(
      parseConfirmationToken(issued.token)?.secret ?? "missing",
    );
  });

  test("rejects malformed and unsupported tokens", async () => {
    for (const token of [
      "",
      "v2.key.1.secret",
      "v1.key.0.secret",
      "v1.key.nope.secret",
      "v1.key.1.secret.extra",
    ]) {
      expect(parseConfirmationToken(token)).toBeNull();
    }
    expect(emailKey("site-a", "person@example.com", "too-short")).rejects.toThrow();
    expect(
      issueConfirmationToken({
        siteId: "site-a",
        emailKey: "a".repeat(43),
        version: 1,
        confirmationPepper,
        secret: new Uint8Array(31),
      }),
    ).rejects.toThrow();
  });

  test("issues site-bound versioned unsubscribe tokens without address content", async () => {
    const key = await emailKey("site-a", "person@example.com", lookupPepper);
    const token = await issueUnsubscribeToken({
      siteId: "site-a",
      emailKey: key,
      version: 3,
      unsubscribePepper,
    });

    expect(token).not.toContain("person@example.com");
    expect(parseConfirmationToken(token)).toMatchObject({ emailKey: key, version: 3 });
    expect(await verifyUnsubscribeToken({ siteId: "site-a", token, unsubscribePepper })).toBe(true);
    expect(await verifyUnsubscribeToken({ siteId: "site-b", token, unsubscribePepper })).toBe(
      false,
    );

    const nextVersion = await issueUnsubscribeToken({
      siteId: "site-a",
      emailKey: key,
      version: 4,
      unsubscribePepper,
    });
    expect(nextVersion).not.toBe(token);
  });

  test("matches stable Web Crypto HMAC vectors without Node crypto globals", async () => {
    expect(await emailKey("site-a", "person@example.com", lookupPepper)).toBe(
      "dgcWFKbYC0cFysru1rtn6gVosp_10cQNqcspbZF4x5w",
    );
  });
});

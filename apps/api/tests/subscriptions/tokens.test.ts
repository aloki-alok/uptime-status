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
  test("keeps email lookup keys stable within one site and isolated across sites", () => {
    const first = emailKey("site-a", "person@example.com", lookupPepper);
    expect(emailKey("site-a", "person@example.com", lookupPepper)).toBe(first);
    expect(emailKey("site-b", "person@example.com", lookupPepper)).not.toBe(first);
    expect(first).not.toContain("person");
  });

  test("issues parseable tokens and verifies only the matching site and hash", () => {
    const key = emailKey("site-a", "person@example.com", lookupPepper);
    const issued = issueConfirmationToken({
      siteId: "site-a",
      emailKey: key,
      version: 2,
      confirmationPepper,
      secret: new Uint8Array(32).fill(7),
    });

    expect(parseConfirmationToken(issued.token)).toMatchObject({ emailKey: key, version: 2 });
    expect(
      verifyConfirmationToken({
        siteId: "site-a",
        token: issued.token,
        expectedHash: issued.tokenHash,
        confirmationPepper,
      }),
    ).toBe(true);
    expect(
      verifyConfirmationToken({
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

  test("rejects malformed and unsupported tokens", () => {
    for (const token of [
      "",
      "v2.key.1.secret",
      "v1.key.0.secret",
      "v1.key.nope.secret",
      "v1.key.1.secret.extra",
    ]) {
      expect(parseConfirmationToken(token)).toBeNull();
    }
    expect(() => emailKey("site-a", "person@example.com", "too-short")).toThrow();
    expect(() =>
      issueConfirmationToken({
        siteId: "site-a",
        emailKey: "a".repeat(43),
        version: 1,
        confirmationPepper,
        secret: new Uint8Array(31),
      }),
    ).toThrow();
  });

  test("issues site-bound versioned unsubscribe tokens without address content", () => {
    const key = emailKey("site-a", "person@example.com", lookupPepper);
    const token = issueUnsubscribeToken({
      siteId: "site-a",
      emailKey: key,
      version: 3,
      unsubscribePepper,
    });

    expect(token).not.toContain("person@example.com");
    expect(parseConfirmationToken(token)).toMatchObject({ emailKey: key, version: 3 });
    expect(verifyUnsubscribeToken({ siteId: "site-a", token, unsubscribePepper })).toBe(true);
    expect(verifyUnsubscribeToken({ siteId: "site-b", token, unsubscribePepper })).toBe(false);

    const nextVersion = issueUnsubscribeToken({
      siteId: "site-a",
      emailKey: key,
      version: 4,
      unsubscribePepper,
    });
    expect(nextVersion).not.toBe(token);
  });
});

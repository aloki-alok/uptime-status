import { describe, expect, test } from "bun:test";
import { normalizeEmail } from "../../src/subscriptions/normalize-email";

describe("subscription email normalization", () => {
  test("normalizes a safe mailbox deterministically", () => {
    expect(normalizeEmail("  Person+Status@Example.COM  ")).toBe("person+status@example.com");
  });

  test("rejects malformed, injected, and oversized addresses", () => {
    for (const value of [
      "missing-at.example.com",
      "a@@example.com",
      ".leading@example.com",
      "double..dot@example.com",
      "person@example",
      "person@-example.com",
      "person@example.com\nBcc: victim@example.com",
      `${"a".repeat(65)}@example.com`,
    ]) {
      expect(normalizeEmail(value)).toBeNull();
    }
  });
});

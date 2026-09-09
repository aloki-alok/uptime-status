import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const TOKEN_PART = /^[A-Za-z0-9_-]+$/;

function hmac(pepper: string, value: string) {
  if (Buffer.byteLength(pepper, "utf8") < 32) {
    throw new Error("Subscription token peppers must contain at least 32 bytes");
  }
  return createHmac("sha256", pepper).update(value).digest("base64url");
}

export function emailKey(siteId: string, normalizedEmail: string, lookupPepper: string) {
  return hmac(lookupPepper, `${siteId}\u0000${normalizedEmail}`);
}

export function confirmationTokenHash(
  siteId: string,
  version: number,
  secret: string,
  confirmationPepper: string,
) {
  return hmac(confirmationPepper, `${siteId}\u0000${version}\u0000${secret}`);
}

export function unsubscribeTokenHash(
  siteId: string,
  version: number,
  emailKeyValue: string,
  unsubscribePepper: string,
) {
  return hmac(
    unsubscribePepper,
    `unsubscribe\u0000${siteId}\u0000${version}\u0000${emailKeyValue}`,
  );
}

export type ParsedConfirmationToken = {
  emailKey: string;
  version: number;
  secret: string;
};

export function issueConfirmationToken(input: {
  siteId: string;
  emailKey: string;
  version: number;
  confirmationPepper: string;
  secret?: Uint8Array;
}) {
  const secretBytes = input.secret ?? randomBytes(32);
  if (secretBytes.byteLength !== 32) {
    throw new Error("Confirmation token secrets must contain exactly 32 bytes");
  }
  const secret = Buffer.from(secretBytes).toString("base64url");
  const token = `v1.${input.emailKey}.${input.version}.${secret}`;
  return {
    token,
    tokenHash: confirmationTokenHash(input.siteId, input.version, secret, input.confirmationPepper),
  };
}

export function issueUnsubscribeToken(input: {
  siteId: string;
  emailKey: string;
  version: number;
  unsubscribePepper: string;
}) {
  const signature = unsubscribeTokenHash(
    input.siteId,
    input.version,
    input.emailKey,
    input.unsubscribePepper,
  );
  return `v1.${input.emailKey}.${input.version}.${signature}`;
}

export function parseConfirmationToken(token: string): ParsedConfirmationToken | null {
  if (token.length > 512) return null;
  const [prefix, key, versionText, secret, extra] = token.split(".");
  if (
    prefix !== "v1" ||
    key?.length !== 43 ||
    !TOKEN_PART.test(key) ||
    secret?.length !== 43 ||
    !TOKEN_PART.test(secret) ||
    extra !== undefined
  ) {
    return null;
  }
  const version = Number(versionText);
  if (!Number.isSafeInteger(version) || version < 1) return null;
  return { emailKey: key, version, secret };
}

export function verifyConfirmationToken(input: {
  siteId: string;
  token: string;
  expectedHash: string;
  confirmationPepper: string;
}) {
  const parsed = parseConfirmationToken(input.token);
  if (!parsed) return false;
  const actual = confirmationTokenHash(
    input.siteId,
    parsed.version,
    parsed.secret,
    input.confirmationPepper,
  );
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(input.expectedHash);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function verifyUnsubscribeToken(input: {
  siteId: string;
  token: string;
  unsubscribePepper: string;
}) {
  const parsed = parseConfirmationToken(input.token);
  if (!parsed) return false;
  const expected = unsubscribeTokenHash(
    input.siteId,
    parsed.version,
    parsed.emailKey,
    input.unsubscribePepper,
  );
  const actualBytes = Buffer.from(parsed.secret);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

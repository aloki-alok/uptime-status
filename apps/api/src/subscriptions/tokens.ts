const TOKEN_PART = /^[A-Za-z0-9_-]+$/;
const encoder = new TextEncoder();

function base64url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeBase64url(value: string) {
  if (!TOKEN_PART.test(value) || value.length % 4 === 1) return null;
  try {
    const padding = "=".repeat((4 - (value.length % 4)) % 4);
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding);
    const output = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return base64url(output) === value ? output : null;
  } catch {
    return null;
  }
}

async function hmacKey(pepper: string, usage: Array<"sign" | "verify">) {
  const pepperBytes = encoder.encode(pepper);
  if (pepperBytes.byteLength < 32) {
    throw new Error("Subscription token peppers must contain at least 32 bytes");
  }
  return crypto.subtle.importKey(
    "raw",
    pepperBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    usage,
  );
}

async function hmac(pepper: string, value: string) {
  const key = await hmacKey(pepper, ["sign"]);
  return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))));
}

async function verifyHmac(pepper: string, value: string, expected: string) {
  const signature = decodeBase64url(expected);
  if (signature?.byteLength !== 32) return false;
  const key = await hmacKey(pepper, ["verify"]);
  return crypto.subtle.verify("HMAC", key, signature, encoder.encode(value));
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

export async function issueConfirmationToken(input: {
  siteId: string;
  emailKey: string;
  version: number;
  confirmationPepper: string;
  secret?: Uint8Array;
}) {
  const secretBytes = input.secret ?? crypto.getRandomValues(new Uint8Array(32));
  if (secretBytes.byteLength !== 32) {
    throw new Error("Confirmation token secrets must contain exactly 32 bytes");
  }
  const secret = base64url(secretBytes);
  const token = `v1.${input.emailKey}.${input.version}.${secret}`;
  return {
    token,
    tokenHash: await confirmationTokenHash(
      input.siteId,
      input.version,
      secret,
      input.confirmationPepper,
    ),
  };
}

export async function issueUnsubscribeToken(input: {
  siteId: string;
  emailKey: string;
  version: number;
  unsubscribePepper: string;
}) {
  const signature = await unsubscribeTokenHash(
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

export async function verifyConfirmationToken(input: {
  siteId: string;
  token: string;
  expectedHash: string;
  confirmationPepper: string;
}) {
  const parsed = parseConfirmationToken(input.token);
  if (!parsed) return false;
  return verifyHmac(
    input.confirmationPepper,
    `${input.siteId}\u0000${parsed.version}\u0000${parsed.secret}`,
    input.expectedHash,
  );
}

export async function verifyUnsubscribeToken(input: {
  siteId: string;
  token: string;
  unsubscribePepper: string;
}) {
  const parsed = parseConfirmationToken(input.token);
  if (!parsed) return false;
  return verifyHmac(
    input.unsubscribePepper,
    `unsubscribe\u0000${input.siteId}\u0000${parsed.version}\u0000${parsed.emailKey}`,
    parsed.secret,
  );
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type ConfirmationPayload = {
  normalizedEmail: string;
  token: string;
};

export type ConfirmationPayloadIdentity = {
  outboxId: string;
  siteId: string;
  emailKey: string;
  tokenVersion: number;
  createdAt: string;
};

export type EncryptedConfirmationPayload = {
  keyVersion: number;
  nonce: string;
  ciphertext: string;
};

export type OutboxEncryptionKey = {
  version: number;
  key: CryptoKey;
};

function base64UrlEncode(value: Uint8Array) {
  let binary = "";
  for (let index = 0; index < value.length; index += 1) {
    binary += String.fromCharCode(value[index] as number);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new TypeError("Invalid base64url value");
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function additionalData(identity: ConfirmationPayloadIdentity, keyVersion: number) {
  return encoder.encode(
    JSON.stringify({
      schemaVersion: "1.0.0",
      kind: "subscription-confirmation",
      keyVersion,
      ...identity,
    }),
  );
}

function parsePayload(value: unknown): ConfirmationPayload {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    !("normalizedEmail" in value) ||
    !("token" in value) ||
    typeof value.normalizedEmail !== "string" ||
    typeof value.token !== "string" ||
    value.normalizedEmail.length < 3 ||
    value.normalizedEmail.length > 254 ||
    value.token.length < 1 ||
    value.token.length > 512
  ) {
    throw new TypeError("Decrypted confirmation payload is invalid");
  }
  return { normalizedEmail: value.normalizedEmail, token: value.token };
}

export async function importOutboxEncryptionKey(rawKey: Uint8Array) {
  if (rawKey.byteLength !== 32) {
    throw new TypeError("Outbox encryption keys must contain exactly 32 bytes");
  }
  return crypto.subtle.importKey("raw", rawKey.slice().buffer, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export class ConfirmationOutboxCipher {
  private readonly keys = new Map<number, CryptoKey>();

  constructor(
    private readonly active: OutboxEncryptionKey,
    olderKeys: OutboxEncryptionKey[] = [],
  ) {
    for (const candidate of [active, ...olderKeys]) {
      if (!Number.isSafeInteger(candidate.version) || candidate.version < 1) {
        throw new TypeError("Outbox encryption key versions must be positive integers");
      }
      if (this.keys.has(candidate.version)) {
        throw new TypeError("Outbox encryption key versions must be unique");
      }
      this.keys.set(candidate.version, candidate.key);
    }
  }

  async encrypt(identity: ConfirmationPayloadIdentity, payload: ConfirmationPayload) {
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = encoder.encode(JSON.stringify(payload));
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: nonce,
        additionalData: additionalData(identity, this.active.version),
      },
      this.active.key,
      plaintext,
    );
    return {
      keyVersion: this.active.version,
      nonce: base64UrlEncode(nonce),
      ciphertext: base64UrlEncode(new Uint8Array(ciphertext)),
    } satisfies EncryptedConfirmationPayload;
  }

  async decrypt(
    identity: ConfirmationPayloadIdentity,
    encrypted: EncryptedConfirmationPayload,
  ): Promise<ConfirmationPayload> {
    const key = this.keys.get(encrypted.keyVersion);
    if (!key) throw new Error("Outbox payload uses an unavailable encryption key version");
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: base64UrlDecode(encrypted.nonce),
        additionalData: additionalData(identity, encrypted.keyVersion),
      },
      key,
      base64UrlDecode(encrypted.ciphertext),
    );
    return parsePayload(JSON.parse(decoder.decode(plaintext)));
  }
}

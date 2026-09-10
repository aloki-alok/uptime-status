const encoder = new TextEncoder();
const MAX_WEBHOOK_BYTES = 64 * 1024;
const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

export type ResendSuppressionEvent = {
  eventId: string;
  providerMessageId: string;
  reason: "bounce" | "complaint";
  occurredAt: string;
};

function decodeBase64(value: string) {
  try {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function parseEvent(value: unknown, eventId: string): ResendSuppressionEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  const data = event.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const providerMessageId = (data as Record<string, unknown>).email_id;
  const occurredAt = event.created_at;
  const reason =
    event.type === "email.bounced"
      ? "bounce"
      : event.type === "email.complained"
        ? "complaint"
        : null;
  if (
    !reason ||
    typeof providerMessageId !== "string" ||
    providerMessageId.length < 1 ||
    providerMessageId.length > 256 ||
    typeof occurredAt !== "string" ||
    !Number.isFinite(Date.parse(occurredAt))
  ) {
    return null;
  }
  return { eventId, providerMessageId, reason, occurredAt };
}

async function validSignature(input: {
  payload: string;
  eventId: string;
  timestamp: string;
  signature: string;
  secret: string;
  nowEpochSeconds: number;
}) {
  if (!input.secret.startsWith("whsec_")) return false;
  const timestamp = Number(input.timestamp);
  if (
    !Number.isSafeInteger(timestamp) ||
    Math.abs(input.nowEpochSeconds - timestamp) > SIGNATURE_TOLERANCE_SECONDS
  ) {
    return false;
  }
  const secret = decodeBase64(input.secret.slice("whsec_".length));
  if (!secret || secret.byteLength < 16) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    secret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signed = encoder.encode(`${input.eventId}.${input.timestamp}.${input.payload}`);
  for (const candidate of input.signature.split(" ")) {
    const [version, encoded, extra] = candidate.split(",");
    if (version !== "v1" || !encoded || extra !== undefined) continue;
    const signature = decodeBase64(encoded);
    if (signature && (await crypto.subtle.verify("HMAC", key, signature, signed))) return true;
  }
  return false;
}

export async function verifyResendSuppressionWebhook(
  request: Request,
  secret: string,
  nowEpochSeconds = Math.floor(Date.now() / 1000),
) {
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_WEBHOOK_BYTES) return null;
  const eventId = request.headers.get("svix-id");
  const timestamp = request.headers.get("svix-timestamp");
  const signature = request.headers.get("svix-signature");
  if (
    !eventId ||
    eventId.length > 256 ||
    !timestamp ||
    timestamp.length > 32 ||
    !signature ||
    signature.length > 2048
  ) {
    return null;
  }
  const payload = await request.text();
  if (encoder.encode(payload).byteLength > MAX_WEBHOOK_BYTES) return null;
  if (
    !(await validSignature({
      payload,
      eventId,
      timestamp,
      signature,
      secret,
      nowEpochSeconds,
    }))
  ) {
    return null;
  }
  try {
    return parseEvent(JSON.parse(payload), eventId);
  } catch {
    return null;
  }
}

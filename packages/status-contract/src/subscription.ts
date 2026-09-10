import { type Static, Type } from "@sinclair/typebox";

const LOCAL_PART = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i;
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const encoder = new TextEncoder();

export function normalizeEmail(input: unknown): string | null {
  if (
    typeof input !== "string" ||
    Array.from(input).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  ) {
    return null;
  }

  const normalized = input.trim().toLowerCase();
  if (encoder.encode(normalized).byteLength > 254) return null;

  const separator = normalized.lastIndexOf("@");
  if (separator <= 0 || separator !== normalized.indexOf("@")) return null;
  const local = normalized.slice(0, separator);
  const domain = normalized.slice(separator + 1);
  if (
    encoder.encode(local).byteLength > 64 ||
    !LOCAL_PART.test(local) ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.includes("..")
  ) {
    return null;
  }

  const labels = domain.split(".");
  if (labels.length < 2 || labels.some((label) => !DOMAIN_LABEL.test(label))) return null;
  return normalized;
}

export const SubscribeRequestSchema = Type.Object(
  {
    email: Type.String({ minLength: 3, maxLength: 254 }),
  },
  { additionalProperties: false },
);

export const SubscriptionAcceptedSchema = Type.Object(
  {
    status: Type.Literal("accepted"),
  },
  { additionalProperties: false },
);

export const PublicApiErrorCodeSchema = Type.Union([
  Type.Literal("invalid_request"),
  Type.Literal("subscriptions_unavailable"),
  Type.Literal("rate_limited"),
  Type.Literal("internal_error"),
]);

export const PublicApiErrorSchema = Type.Object(
  {
    error: Type.Object(
      {
        code: PublicApiErrorCodeSchema,
        message: Type.String({ minLength: 1, maxLength: 200 }),
        requestId: Type.String({ minLength: 8, maxLength: 128 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const SubscriberStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("active"),
  Type.Literal("unsubscribed"),
  Type.Literal("suppressed"),
]);

export type SubscribeRequest = Static<typeof SubscribeRequestSchema>;
export type SubscriptionAccepted = Static<typeof SubscriptionAcceptedSchema>;
export type PublicApiError = Static<typeof PublicApiErrorSchema>;
export type SubscriberStatus = Static<typeof SubscriberStatusSchema>;

import { createHash } from "node:crypto";
import {
  type NotificationEvent,
  type NotificationEventContent,
  validateNotificationEventShape,
} from "./notification";

/**
 * Event authoring hashes with `node:crypto`, so it is kept out of `notification.ts`: Worker code
 * imports the schema and shape validator and cannot pull a Node builtin into a browser-target build.
 * Publication is operator-side, which always runs under Node or Bun.
 */
export function notificationEventId(value: NotificationEvent | NotificationEventContent) {
  const identity = [
    value.siteId,
    value.source.kind,
    value.source.slug,
    value.type,
    value.contentRevision,
  ];
  return `evt_${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}

export function createNotificationEvent(content: NotificationEventContent): NotificationEvent {
  return { ...content, eventId: notificationEventId(content) } as NotificationEvent;
}

export function validateNotificationEvent(input: unknown): input is NotificationEvent {
  return validateNotificationEventShape(input) && input.eventId === notificationEventId(input);
}

import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { normalizeEmail } from "@uptime-status/domain/subscription";
import type { SubscriptionService } from "../subscriptions/service";
import { emailKey } from "../subscriptions/tokens";

export type SesSuppression = { reason: "bounce" | "complaint"; recipients: string[] };

export function parseSesSuppression(body: string): SesSuppression | null {
  if (body.length > 256 * 1024) throw new Error("SES feedback payload is too large");
  const event: unknown = JSON.parse(body);
  if (!event || typeof event !== "object") throw new Error("SES feedback payload is invalid");
  const value = event as Record<string, unknown>;
  const type = String(value.eventType ?? value.notificationType ?? "").toLowerCase();
  if (type !== "bounce" && type !== "complaint") return null;
  const mail = value.mail as { destination?: unknown } | undefined;
  const detail = value[type] as Record<string, unknown> | undefined;
  const recipients = type === "bounce" ? detail?.bouncedRecipients : detail?.complainedRecipients;
  const addresses = Array.isArray(recipients)
    ? recipients.map((recipient) =>
        recipient && typeof recipient === "object"
          ? (recipient as Record<string, unknown>).emailAddress
          : null,
      )
    : Array.isArray(mail?.destination)
      ? mail.destination
      : [];
  const normalized = addresses
    .map(normalizeEmail)
    .filter((address): address is string => !!address);
  if (!normalized.length || normalized.length > 20) {
    throw new Error("SES suppression has no valid bounded recipient list");
  }
  return { reason: type, recipients: [...new Set(normalized)] };
}

export class SesFeedbackConsumer {
  private readonly client: SQSClient;

  constructor(
    region: string,
    private readonly queueUrl: string,
    private readonly siteId: string,
    private readonly lookupPepper: string,
    private readonly service: SubscriptionService,
  ) {
    this.client = new SQSClient({ region });
  }

  async runOnce() {
    const response = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 10,
      }),
    );
    let suppressed = 0;
    for (const message of response.Messages ?? []) {
      if (!message.Body || !message.ReceiptHandle) continue;
      const event = parseSesSuppression(message.Body);
      if (event) {
        for (const recipient of event.recipients) {
          const key = await emailKey(this.siteId, recipient, this.lookupPepper);
          if (await this.service.suppress(key, event.reason)) suppressed += 1;
        }
      }
      await this.client.send(
        new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: message.ReceiptHandle }),
      );
    }
    return { suppressed };
  }
}

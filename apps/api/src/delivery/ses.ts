import { readFile } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import type { RenderedMail } from "@uptime-status/email";

export interface MailSender {
  send(mail: RenderedMail): Promise<string>;
}

export class SesMailSender implements MailSender {
  private readonly client: SESv2Client;

  constructor(
    region: string,
    private readonly configurationSetName: string,
    private readonly siteRoot: string,
  ) {
    this.client = new SESv2Client({ region });
  }

  async send(mail: RenderedMail) {
    const attachments = await Promise.all(
      mail.attachments.map(async (attachment) => {
        const path = resolve(this.siteRoot, attachment.path);
        if (relative(this.siteRoot, path).startsWith("..")) {
          throw new Error("Mail attachment escapes the site root");
        }
        const contentType = path.toLowerCase().endsWith(".png")
          ? "image/png"
          : path.toLowerCase().endsWith(".jpg") || path.toLowerCase().endsWith(".jpeg")
            ? "image/jpeg"
            : path.toLowerCase().endsWith(".gif")
              ? "image/gif"
              : null;
        if (!contentType) throw new Error("Unsupported mail attachment type");
        return {
          RawContent: new Uint8Array(await readFile(path)),
          ContentDisposition: "INLINE" as const,
          FileName: basename(path),
          ContentId: attachment.contentId,
          ContentTransferEncoding: "BASE64" as const,
          ContentType: contentType,
        };
      }),
    );
    const response = await this.client.send(
      new SendEmailCommand({
        FromEmailAddress: `${mail.from.name} <${mail.from.email}>`,
        ...(mail.replyTo ? { ReplyToAddresses: [mail.replyTo] } : {}),
        Destination: { ToAddresses: [mail.to] },
        ConfigurationSetName: this.configurationSetName,
        EmailTags: [{ Name: "category", Value: mail.category }],
        Content: {
          Simple: {
            Subject: { Data: mail.subject, Charset: "UTF-8" },
            Body: {
              Text: { Data: mail.text, Charset: "UTF-8" },
              Html: { Data: mail.html, Charset: "UTF-8" },
            },
            Headers: Object.entries(mail.headers).map(([Name, Value]) => ({ Name, Value })),
            Attachments: attachments,
          },
        },
      }),
    );
    if (!response.MessageId) throw new Error("SES did not return a message ID");
    return response.MessageId;
  }
}

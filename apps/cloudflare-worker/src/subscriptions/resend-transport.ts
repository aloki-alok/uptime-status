const RESEND_EMAILS_URL = "https://api.resend.com/emails";
const DEFAULT_USER_AGENT = "uptime-status-cloudflare-worker/0.1.0";
const MAX_SUCCESS_RESPONSE_BYTES = 4096;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export type MailDeliveryReceipt = {
  providerMessageId: string;
};

export type TransportMail = {
  messageId: string;
  from: { name: string; email: string };
  replyTo?: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>;
  attachments: Array<{ contentId: string; path: string }>;
};

export interface MailTransport {
  send(mail: TransportMail): Promise<MailDeliveryReceipt>;
}

export class MailTransportError extends Error {
  readonly retryable: boolean;
  readonly status?: number;

  constructor(message: string, options: { retryable: boolean; status?: number }) {
    super(message);
    this.name = "MailTransportError";
    this.retryable = options.retryable;
    this.status = options.status;
  }
}

export type ResendTransportOptions = {
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  userAgent?: string;
  resolveAttachmentPath?: (path: string) => string | Promise<string>;
};

function permanent(message: string, status?: number): never {
  throw new MailTransportError(message, { retryable: false, status });
}

function validHeaderValue(value: string) {
  return (
    value.length > 0 &&
    value === value.trim() &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  );
}

function sender(mail: TransportMail) {
  if (!validHeaderValue(mail.from.name) || !validHeaderValue(mail.from.email)) {
    permanent("Rendered mail contains an invalid sender");
  }
  const name = mail.from.name.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return `"${name}" <${mail.from.email}>`;
}

function attachmentFilename(attachment: TransportMail["attachments"][number]) {
  const filename = attachment.path.split("/").at(-1);
  if (!filename || filename === "." || filename === ".." || !validHeaderValue(filename)) {
    permanent("Rendered mail contains an invalid attachment path");
  }
  return filename;
}

async function resendAttachment(
  attachment: TransportMail["attachments"][number],
  resolvePath: ResendTransportOptions["resolveAttachmentPath"],
) {
  if (!validHeaderValue(attachment.contentId) || attachment.contentId.length >= 128) {
    permanent("Rendered mail contains an invalid attachment content ID");
  }
  let path: string;
  try {
    path = resolvePath ? await resolvePath(attachment.path) : attachment.path;
  } catch {
    permanent("A rendered attachment path could not be resolved to HTTPS");
  }
  let url: URL;
  try {
    url = new URL(path);
  } catch {
    permanent("A rendered attachment path could not be resolved to HTTPS");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    permanent("A rendered attachment path could not be resolved to HTTPS");
  }
  return {
    path: url.href,
    filename: attachmentFilename(attachment),
    content_id: attachment.contentId,
  };
}

async function boundedSuccessJson(response: Response) {
  if (!response.body) throw new Error("missing response body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_SUCCESS_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("response body is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(body)) as unknown;
}

function providerMessageId(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = (value as Record<string, unknown>).id;
  return typeof id === "string" && id.length <= 256 && validHeaderValue(id) ? id : null;
}

export function createResendTransport(options: ResendTransportOptions): MailTransport {
  if (!validHeaderValue(options.apiKey)) permanent("A Resend API key is required");
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  if (!validHeaderValue(userAgent)) permanent("The Resend User-Agent is invalid");
  const fetcher = options.fetch ?? globalThis.fetch;

  return {
    async send(mail) {
      if (
        !validHeaderValue(mail.messageId) ||
        mail.messageId.length > 256 ||
        !validHeaderValue(mail.to) ||
        !validHeaderValue(mail.subject)
      ) {
        permanent("Rendered mail contains invalid delivery fields");
      }
      if (mail.replyTo && !validHeaderValue(mail.replyTo)) {
        permanent("Rendered mail contains an invalid reply-to address");
      }
      if (
        Object.entries(mail.headers).some(
          ([name, value]) => !HEADER_NAME.test(name) || !validHeaderValue(value),
        )
      ) {
        permanent("Rendered mail contains invalid custom headers");
      }

      const attachments = await Promise.all(
        mail.attachments.map((attachment) =>
          resendAttachment(attachment, options.resolveAttachmentPath),
        ),
      );
      const payload = {
        from: sender(mail),
        to: [mail.to],
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        headers: mail.headers,
        ...(mail.replyTo ? { reply_to: mail.replyTo } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
      };

      let response: Response;
      try {
        response = await fetcher(RESEND_EMAILS_URL, {
          method: "POST",
          redirect: "error",
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            "content-type": "application/json",
            "idempotency-key": mail.messageId,
            "user-agent": userAgent,
          },
          body: JSON.stringify(payload),
        });
      } catch {
        throw new MailTransportError("Resend could not be reached", { retryable: true });
      }

      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        try {
          await response.body?.cancel();
        } catch {
          // The delivery classification does not depend on consuming an error body.
        }
        throw new MailTransportError("Resend rejected the delivery request", {
          retryable,
          status: response.status,
        });
      }

      let responseBody: unknown;
      try {
        responseBody = await boundedSuccessJson(response);
      } catch {
        throw new MailTransportError("Resend returned an invalid success response", {
          retryable: true,
          status: response.status,
        });
      }
      const id = providerMessageId(responseBody);
      if (!id) {
        throw new MailTransportError("Resend returned an invalid success response", {
          retryable: true,
          status: response.status,
        });
      }
      return { providerMessageId: id };
    },
  };
}

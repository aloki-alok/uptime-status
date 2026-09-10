import { type SiteConfig, validateSiteConfig } from "@uptime-status/domain/site";
import { normalizeEmail } from "@uptime-status/domain/subscription";

const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

type ConfirmationEvent = {
  kind: "confirmation";
  eventId: string;
  token: string;
  expiresAt: string;
};

type IncidentEvent = {
  kind: "incident" | "resolved";
  eventId: string;
  title: string;
  message: string;
  publishedAt: string;
};

type MaintenanceEvent = {
  kind: "maintenance";
  eventId: string;
  title: string;
  message: string;
  startsAt: string;
  endsAt: string;
  publishedAt: string;
};

export type MailEvent = ConfirmationEvent | IncidentEvent | MaintenanceEvent;

export type MailAttachmentReference = {
  contentId: string;
  path: string;
  alt: string;
};

export type RenderedMail = {
  messageId: string;
  category: MailEvent["kind"];
  from: { name: string; email: string };
  replyTo?: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>;
  attachments: MailAttachmentReference[];
};

export type RenderMailInput = {
  site: SiteConfig;
  recipient: string;
  publicBaseUrl: string;
  event: MailEvent;
  unsubscribeToken?: string;
};

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeBaseUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Public mail base URL must be a plain HTTPS origin");
  }
  return url.origin;
}

function nonBlank(value: string, name: string) {
  if (value !== value.trim() || value.length === 0) throw new Error(`${name} must be non-blank`);
  return value;
}

function safeHeaderValue(value: string, name: string) {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) throw new Error(`${name} contains unsafe characters`);
  }
  return nonBlank(value, name);
}

function eventIdentifier(value: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error("Event ID must contain only safe identifier characters");
  }
  return value;
}

function normalizedAddress(value: string, name: string) {
  const normalized = normalizeEmail(value);
  if (!normalized || normalized !== value)
    throw new Error(`${name} must be a normalized email address`);
  return normalized;
}

function isoTimestamp(value: string, name: string) {
  if (!ISO_TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`${name} must be an ISO timestamp`);
  }
  return value;
}

function delivery(site: SiteConfig) {
  if (!site.subscriptions.enabled) throw new Error("Site subscriptions are disabled");
  return site.subscriptions.delivery;
}

function eventCopy(event: MailEvent) {
  if (event.kind === "confirmation") {
    return {
      eyebrow: "Confirm subscription",
      title: "Confirm status updates",
      message: "Confirm your address to receive important incident and maintenance updates.",
      action: "Confirm subscription",
    };
  }
  if (event.kind === "maintenance") {
    return {
      eyebrow: "Maintenance update",
      title: event.title,
      message: event.message,
      action: "View maintenance",
    };
  }
  if (event.kind === "resolved") {
    return {
      eyebrow: "Incident resolved",
      title: event.title,
      message: event.message,
      action: "View status",
    };
  }
  return {
    eyebrow: "Incident update",
    title: event.title,
    message: event.message,
    action: "View incident",
  };
}

function eventEmoticon(site: SiteConfig, event: MailEvent) {
  const templates = site.subscriptions.enabled ? site.subscriptions.templates : undefined;
  if (event.kind === "maintenance") return templates?.maintenanceEmoticon ?? "";
  if (event.kind === "resolved") return templates?.resolvedEmoticon ?? "";
  if (event.kind === "incident") return templates?.incidentEmoticon ?? "";
  return "";
}

export function renderStatusMail(input: RenderMailInput): RenderedMail {
  if (!validateSiteConfig(input.site)) throw new Error("Site configuration is invalid");
  const selectedDelivery = delivery(input.site);
  const baseUrl = safeBaseUrl(input.publicBaseUrl);
  const recipient = normalizedAddress(input.recipient, "Recipient");
  const eventId = eventIdentifier(input.event.eventId);
  if (input.event.kind === "confirmation") {
    isoTimestamp(input.event.expiresAt, "Confirmation expiry");
  } else {
    isoTimestamp(input.event.publishedAt, "Published time");
    if (!input.unsubscribeToken) {
      throw new Error("Customer update mail requires an unsubscribe token");
    }
  }
  if (input.event.kind === "maintenance") {
    const startsAt = isoTimestamp(input.event.startsAt, "Maintenance start");
    const endsAt = isoTimestamp(input.event.endsAt, "Maintenance end");
    if (Date.parse(startsAt) >= Date.parse(endsAt)) {
      throw new Error("Maintenance end must be after its start");
    }
  }
  const templates = input.site.subscriptions.enabled
    ? input.site.subscriptions.templates
    : undefined;
  const copy = eventCopy(input.event);
  const emoticon = eventEmoticon(input.site, input.event);
  const subjectPrefix = safeHeaderValue(
    templates?.subjectPrefix ?? `${input.site.displayName} status`,
    "Subject prefix",
  );
  const subject = safeHeaderValue(`${subjectPrefix}: ${copy.title}`, "Subject");
  const actionUrl =
    input.event.kind === "confirmation"
      ? `${baseUrl}/api/v1/subscriptions/confirm?token=${encodeURIComponent(input.event.token)}`
      : baseUrl;
  const unsubscribeUrl = input.unsubscribeToken
    ? `${baseUrl}/api/v1/subscriptions/unsubscribe?token=${encodeURIComponent(input.unsubscribeToken)}`
    : null;
  const attachments: MailAttachmentReference[] = [];
  if (templates?.logoPath) {
    attachments.push({
      contentId: "site-logo",
      path: templates.logoPath,
      alt: input.site.brand.logoAlt,
    });
  }
  if (templates?.headerMedia) {
    attachments.push({
      contentId: "header-media",
      path: templates.headerMedia.path,
      alt: templates.headerMedia.alt,
    });
  }

  const mediaHtml = attachments
    .map(
      (attachment) =>
        `<img src="cid:${attachment.contentId}" alt="${escapeHtml(attachment.alt)}" style="display:block;max-width:100%;height:auto;margin:0 0 24px">`,
    )
    .join("");
  const signOff = templates?.signOff ?? `${input.site.displayName} status`;
  const unsubscribeText = unsubscribeUrl
    ? `\n\nUnsubscribe: ${unsubscribeUrl}`
    : "\n\nYou will not receive updates until you confirm your address.";
  const headers: Record<string, string> = {
    "X-Status-Event": eventId,
  };
  if (unsubscribeUrl) {
    headers["List-Unsubscribe"] = `<${unsubscribeUrl}>`;
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }

  return {
    messageId: `${input.site.siteId}:${eventId}:${input.event.kind}`,
    category: input.event.kind,
    from: {
      name: safeHeaderValue(selectedDelivery.senderName ?? input.site.displayName, "Sender name"),
      email: normalizedAddress(selectedDelivery.senderEmail, "Sender email"),
    },
    ...(selectedDelivery.replyToEmail
      ? {
          replyTo: normalizedAddress(selectedDelivery.replyToEmail, "Reply-to email"),
        }
      : {}),
    to: recipient,
    subject,
    text: `${emoticon ? `${emoticon} ` : ""}${copy.eyebrow}\n\n${copy.title}\n\n${copy.message}\n\n${copy.action}: ${actionUrl}\n\n${signOff}${unsubscribeText}`,
    html: `<!doctype html><html><body style="margin:0;background:#f4f6f5;color:#17201d;font-family:Arial,sans-serif"><main style="max-width:600px;margin:0 auto;padding:40px 24px">${mediaHtml}<p style="margin:0 0 12px;color:#596762;font-size:12px;font-weight:700;text-transform:uppercase">${escapeHtml(emoticon ? `${emoticon} ${copy.eyebrow}` : copy.eyebrow)}</p><h1 style="margin:0 0 18px;font-size:30px;line-height:1.15">${escapeHtml(copy.title)}</h1><p style="margin:0 0 24px;color:#44514d;font-size:16px;line-height:1.6">${escapeHtml(copy.message)}</p><p><a href="${escapeHtml(actionUrl)}" style="display:inline-block;padding:12px 18px;background:#17201d;color:#ffffff;text-decoration:none">${escapeHtml(copy.action)}</a></p><p style="margin:30px 0 0;color:#596762;font-size:13px">${escapeHtml(signOff)}</p>${unsubscribeUrl ? `<p style="margin:20px 0 0;font-size:12px"><a href="${escapeHtml(unsubscribeUrl)}" style="color:#596762">Unsubscribe</a></p>` : '<p style="margin:20px 0 0;color:#596762;font-size:12px">You will not receive updates until you confirm your address.</p>'}</main></body></html>`,
    headers,
    attachments,
  };
}

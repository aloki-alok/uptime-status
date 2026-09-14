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
  affectedServices?: string[];
};

type MaintenanceEvent = {
  kind: "maintenance";
  eventId: string;
  title: string;
  message: string;
  startsAt: string;
  endsAt: string;
  publishedAt: string;
  affectedServices?: string[];
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
  deliveryId?: string;
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

function eventDetails(site: SiteConfig, event: MailEvent) {
  if (event.kind === "confirmation") return [];
  const details: Array<[string, string]> = [];
  if (event.affectedServices?.length) {
    if (event.affectedServices.length > 20) throw new Error("Too many affected services");
    const names = event.affectedServices.map((name) => {
      if (name.length > 120) throw new Error("Affected service name is too long");
      return safeHeaderValue(name, "Affected service");
    });
    details.push(["Affected services", names.join(", ")]);
  }
  if (event.kind === "maintenance") {
    const format = new Intl.DateTimeFormat(site.locale, {
      timeZone: site.timeZone,
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });
    details.push([
      "Scheduled window",
      `${format.format(new Date(event.startsAt))} to ${format.format(new Date(event.endsAt))}`,
    ]);
  }
  return details;
}

export function renderStatusMail(input: RenderMailInput): RenderedMail {
  if (!validateSiteConfig(input.site)) throw new Error("Site configuration is invalid");
  const selectedDelivery = delivery(input.site);
  const baseUrl = safeBaseUrl(input.publicBaseUrl);
  const recipient = normalizedAddress(input.recipient, "Recipient");
  const eventId = eventIdentifier(input.event.eventId);
  let deliveryId: string | null = null;
  if (input.event.kind === "confirmation") {
    isoTimestamp(input.event.expiresAt, "Confirmation expiry");
  } else {
    isoTimestamp(input.event.publishedAt, "Published time");
    if (!input.unsubscribeToken) {
      throw new Error("Customer update mail requires an unsubscribe token");
    }
    if (!input.deliveryId) {
      throw new Error("Customer update mail requires a delivery ID");
    }
    deliveryId = eventIdentifier(input.deliveryId);
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
  const details = eventDetails(input.site, input.event);
  const emoticon = eventEmoticon(input.site, input.event);
  const subjectPrefix = safeHeaderValue(
    templates?.subjectPrefix ?? `${input.site.displayName} status`,
    "Subject prefix",
  );
  const subject = safeHeaderValue(`${subjectPrefix}: ${copy.title}`, "Subject");
  const actionUrl =
    input.event.kind === "confirmation"
      ? `${baseUrl}/api/v1/subscriptions/confirm?token=${encodeURIComponent(input.event.token)}`
      : input.event.kind === "maintenance"
        ? `${baseUrl}/maintenance/`
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
    .map((attachment) =>
      attachment.contentId === "site-logo"
        ? `<img src="cid:${attachment.contentId}" alt="${escapeHtml(attachment.alt)}" width="190" style="display:block;max-width:100%;height:auto">`
        : `<img src="cid:${attachment.contentId}" alt="${escapeHtml(attachment.alt)}" style="display:block;max-width:100%;height:auto;margin:22px 0 0">`,
    )
    .join("");
  const detailText = details.map(([label, value]) => `${label}: ${value}`).join("\n");
  const detailHtml = details.length
    ? `<div style="margin:28px 0;padding:20px 22px;background:#f5f7f4;border:1px solid #e1e8e3;border-radius:10px">${details.map(([label, value]) => `<p style="margin:0 0 12px;font-size:13px;line-height:1.5"><strong style="display:block;color:#596762;font-size:11px;letter-spacing:.08em;text-transform:uppercase">${escapeHtml(label)}</strong><span style="color:#17201d">${escapeHtml(value)}</span></p>`).join("")}</div>`
    : "";
  const accent =
    input.event.kind === "maintenance"
      ? "#2f6feb"
      : input.event.kind === "resolved"
        ? "#16805c"
        : "#b7433c";
  const accentBackground =
    input.event.kind === "maintenance"
      ? "#eaf1ff"
      : input.event.kind === "resolved"
        ? "#e9f5ef"
        : "#fbefed";
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
    messageId:
      input.event.kind === "confirmation"
        ? `${input.site.siteId}:${eventId}:${input.event.kind}`
        : `${input.site.siteId}:${deliveryId}`,
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
    text: `${emoticon ? `${emoticon} ` : ""}${copy.eyebrow}\n\n${copy.title}\n\n${copy.message}${detailText ? `\n\n${detailText}` : ""}\n\n${copy.action}: ${actionUrl}\n\n${signOff}${unsubscribeText}`,
    html: `<!doctype html><html><body style="margin:0;background:#f4f6f5;color:#17201d;font-family:Arial,sans-serif"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f6f5"><tr><td align="center" style="padding:36px 16px"><table role="presentation" width="600" cellspacing="0" cellpadding="0" style="width:100%;max-width:600px;background:#ffffff;border:1px solid #dce5de;border-radius:14px"><tr><td style="padding:32px 36px 36px">${mediaHtml}<p style="margin:26px 0 22px"><span style="display:inline-block;padding:7px 10px;border-radius:5px;background:${accentBackground};color:${accent};font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase">${escapeHtml(emoticon ? `${emoticon} ${copy.eyebrow}` : copy.eyebrow)}</span></p><h1 style="margin:0 0 16px;color:#17201d;font-size:28px;line-height:1.2">${escapeHtml(copy.title)}</h1><p style="margin:0;color:#44514d;font-size:16px;line-height:1.6;white-space:pre-line">${escapeHtml(copy.message)}</p>${detailHtml}<p style="margin:28px 0 0"><a href="${escapeHtml(actionUrl)}" style="display:inline-block;padding:12px 18px;border-radius:6px;background:#17201d;color:#ffffff;font-size:14px;font-weight:700;text-decoration:none">${escapeHtml(copy.action)}</a></p></td></tr><tr><td style="padding:24px 36px 30px;border-top:1px solid #e7ece8;color:#63716b;font-size:12px;line-height:1.6"><strong style="display:block;margin-bottom:8px;color:#17201d">${escapeHtml(signOff)}</strong>${unsubscribeUrl ? `<a href="${escapeHtml(unsubscribeUrl)}" style="color:#596762">Unsubscribe from status updates</a>` : "You will not receive updates until you confirm your address."}</td></tr></table></td></tr></table></body></html>`,
    headers,
    attachments,
  };
}

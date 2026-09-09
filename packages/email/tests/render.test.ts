import { describe, expect, test } from "bun:test";
import type { SiteConfig } from "@uptime-status/domain";
import example from "../../../examples/status.config.json";
import { renderStatusMail } from "../src/render";

const site = {
  ...example,
  subscriptions: {
    enabled: true,
    doubleOptIn: true,
    notificationFanoutEnabled: false,
    delivery: {
      provider: "ses",
      region: "us-east-1",
      senderName: "Example status",
      senderEmail: "status@example.com",
      replyToEmail: "support@example.com",
      contactListName: "status-updates",
      topicName: "incidents",
    },
    templates: {
      logoPath: "./assets/logo-light.svg",
      headerMedia: { path: "./assets/wave.gif", alt: "A calm status wave" },
      subjectPrefix: "Example updates",
      incidentEmoticon: ":(",
      maintenanceEmoticon: ":)",
      resolvedEmoticon: "^_^",
      signOff: "The Example team",
    },
    confirmationTtlSeconds: 3600,
    resendCooldownSeconds: 300,
  },
} as SiteConfig;

describe("status mail renderer", () => {
  test("renders deterministic confirmation alternatives without unsubscribe headers", () => {
    const mail = renderStatusMail({
      site,
      recipient: "person@example.com",
      publicBaseUrl: "https://status.example.com",
      event: {
        kind: "confirmation",
        eventId: "confirm-001",
        token: "secret.token",
        expiresAt: "2026-09-08T11:00:00Z",
      },
    });
    expect(mail.subject).toBe("Example updates: Confirm status updates");
    expect(mail.text).toContain("confirm?token=secret.token");
    expect(mail.html).toContain("cid:site-logo");
    expect(mail.html).toContain("cid:header-media");
    expect(mail.headers["List-Unsubscribe"]).toBeUndefined();
    expect(mail.attachments).toHaveLength(2);
  });

  test("adds one-click unsubscribe headers to curated updates", () => {
    const mail = renderStatusMail({
      site,
      recipient: "person@example.com",
      publicBaseUrl: "https://status.example.com/",
      unsubscribeToken: "unsubscribe-token",
      event: {
        kind: "incident",
        eventId: "incident-001",
        title: "API latency",
        message: "Requests are slower than usual.",
        publishedAt: "2026-09-08T10:00:00Z",
      },
    });
    expect(mail.text).toStartWith(":( Incident update");
    expect(mail.headers["List-Unsubscribe"]).toContain("unsubscribe-token");
    expect(mail.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(mail.messageId).toBe("example-service:incident-001:incident");
  });

  test("escapes site-controlled copy and refuses unsafe origins", () => {
    const mail = renderStatusMail({
      site,
      recipient: "person@example.com",
      publicBaseUrl: "https://status.example.com",
      unsubscribeToken: "unsubscribe-token",
      event: {
        kind: "resolved",
        eventId: "resolved-001",
        title: "Resolved <script>alert(1)</script>",
        message: "Everything is stable & monitored.",
        publishedAt: "2026-09-08T10:00:00Z",
      },
    });
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).toContain("&lt;script&gt;");
    expect(mail.html).toContain("stable &amp; monitored");
    expect(() =>
      renderStatusMail({
        site,
        recipient: "person@example.com",
        publicBaseUrl: "http://status.example.com",
        unsubscribeToken: "unsubscribe-token",
        event: {
          kind: "resolved",
          eventId: "resolved-001",
          title: "Resolved",
          message: "Stable",
          publishedAt: "2026-09-08T10:00:00Z",
        },
      }),
    ).toThrow("plain HTTPS origin");
  });

  test("refuses rendering while site subscriptions are disabled", () => {
    expect(() =>
      renderStatusMail({
        site: example as SiteConfig,
        recipient: "person@example.com",
        publicBaseUrl: "https://status.example.com",
        event: {
          kind: "confirmation",
          eventId: "confirm-001",
          token: "secret",
          expiresAt: "2026-09-08T11:00:00Z",
        },
      }),
    ).toThrow("disabled");
  });

  test("refuses unnormalized or header-injected recipients", () => {
    for (const recipient of [" Person@example.com ", "person@example.com\nBcc: bad@example.com"]) {
      expect(() =>
        renderStatusMail({
          site,
          recipient,
          publicBaseUrl: "https://status.example.com",
          event: {
            kind: "confirmation",
            eventId: "confirm-001",
            token: "secret",
            expiresAt: "2026-09-08T11:00:00Z",
          },
        }),
      ).toThrow("normalized email address");
    }
  });

  test("requires unsubscribe for customer updates and rejects unsafe header values", () => {
    expect(() =>
      renderStatusMail({
        site,
        recipient: "person@example.com",
        publicBaseUrl: "https://status.example.com",
        event: {
          kind: "incident",
          eventId: "incident-001",
          title: "API latency",
          message: "Requests are slower than usual.",
          publishedAt: "2026-09-08T10:00:00Z",
        },
      }),
    ).toThrow("requires an unsubscribe token");

    expect(() =>
      renderStatusMail({
        site,
        recipient: "person@example.com",
        publicBaseUrl: "https://status.example.com",
        unsubscribeToken: "unsubscribe-token",
        event: {
          kind: "incident",
          eventId: "incident-001\nBcc: bad@example.com",
          title: "API latency",
          message: "Requests are slower than usual.",
          publishedAt: "2026-09-08T10:00:00Z",
        },
      }),
    ).toThrow("safe identifier characters");
  });

  test("rejects ambiguous timestamps and reversed maintenance windows", () => {
    expect(() =>
      renderStatusMail({
        site,
        recipient: "person@example.com",
        publicBaseUrl: "https://status.example.com",
        unsubscribeToken: "unsubscribe-token",
        event: {
          kind: "resolved",
          eventId: "resolved-001",
          title: "Resolved",
          message: "Stable",
          publishedAt: "2026-09-08T10:00:00",
        },
      }),
    ).toThrow("ISO timestamp");

    expect(() =>
      renderStatusMail({
        site,
        recipient: "person@example.com",
        publicBaseUrl: "https://status.example.com",
        unsubscribeToken: "unsubscribe-token",
        event: {
          kind: "maintenance",
          eventId: "maintenance-001",
          title: "Database maintenance",
          message: "Brief interruptions are possible.",
          startsAt: "2026-09-08T11:00:00Z",
          endsAt: "2026-09-08T10:00:00Z",
          publishedAt: "2026-09-08T09:00:00Z",
        },
      }),
    ).toThrow("after its start");
  });
});

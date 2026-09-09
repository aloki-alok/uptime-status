import { describe, expect, test } from "bun:test";
import example from "../../../examples/status.config.json";
import { semanticForeground, siteConfigIssues, validateSiteConfig } from "../src/site";

function channel(value: number) {
  const normalized = value / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string) {
  const values = [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)].map((value) =>
    channel(Number.parseInt(value, 16)),
  );
  return 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2];
}

function contrast(first: string, second: string) {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

describe("site configuration", () => {
  test("accepts the generic example deployment", () => {
    expect(validateSiteConfig(example)).toBe(true);
  });

  test("rejects unknown keys, duplicate bindings, and unsafe stale policy", () => {
    expect(validateSiteConfig({ ...example, unexpected: true })).toBe(false);
    expect(
      validateSiteConfig({
        ...example,
        components: [
          example.components[0],
          { ...example.components[1], sourceId: "sample", monitorRef: "public-api" },
        ],
      }),
    ).toBe(false);
    expect(
      validateSiteConfig({
        ...example,
        monitoring: {
          ...example.monitoring,
          pollIntervalSeconds: 61,
          staleAfterSeconds: 120,
        },
      }),
    ).toBe(false);
  });

  test("reports schema and semantic failures at the owning field", () => {
    expect(siteConfigIssues({ ...example, siteId: "Not valid" })).toContainEqual(
      expect.objectContaining({ kind: "schema", path: "/siteId" }),
    );
    expect(
      siteConfigIssues({
        ...example,
        monitoring: { ...example.monitoring, staleAfterSeconds: 60 },
      }),
    ).toContainEqual({
      kind: "semantic",
      path: "/monitoring/staleAfterSeconds",
      message: "must be at least two polling intervals",
    });
  });

  test("keeps operational and maintenance colors distinct and readable", () => {
    expect(
      validateSiteConfig({
        ...example,
        presentation: {
          ...example.presentation,
          semanticColors: {
            ...example.presentation.semanticColors,
            maintenance: example.presentation.semanticColors.operational,
          },
        },
      }),
    ).toBe(false);
    expect(
      validateSiteConfig({
        ...example,
        presentation: {
          ...example.presentation,
          semanticColors: {
            ...example.presentation.semanticColors,
            outage: example.presentation.semanticColors.operational,
          },
        },
      }),
    ).toBe(false);

    for (const color of Object.values(example.presentation.semanticColors)) {
      expect(contrast(color, semanticForeground(color))).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("rejects malformed destinations and paths that escape the deployment", () => {
    expect(
      validateSiteConfig({
        ...example,
        domains: { primary: "https://evil.test/path" },
      }),
    ).toBe(false);
    expect(validateSiteConfig({ ...example, displayName: "   " })).toBe(false);
    expect(
      validateSiteConfig({
        ...example,
        brand: { ...example.brand, homeUrl: "https:// " },
      }),
    ).toBe(false);
    expect(
      validateSiteConfig({
        ...example,
        brand: { ...example.brand, logoLightPath: "./../../.env" },
      }),
    ).toBe(false);
  });

  test("does not permit fixture monitoring in production mode", () => {
    expect(validateSiteConfig({ ...example, deploymentMode: "production" })).toBe(false);
  });

  test("accepts a direct HTTPS source in production and rejects unsafe targets", () => {
    const source = {
      sourceId: "website",
      adapter: "https",
      url: "https://example.com/health",
      timeoutMs: 10_000,
    } as const;
    expect(
      validateSiteConfig({
        ...example,
        deploymentMode: "production",
        monitoring: { ...example.monitoring, sources: [source] },
        components: example.components.map((component) => ({
          ...component,
          sourceId: source.sourceId,
        })),
      }),
    ).toBe(true);
    expect(
      validateSiteConfig({
        ...example,
        deploymentMode: "production",
        monitoring: {
          ...example.monitoring,
          sources: [{ ...source, url: "https://user:secret@example.com/health" }],
        },
        components: example.components.map((component) => ({
          ...component,
          sourceId: source.sourceId,
        })),
      }),
    ).toBe(false);
  });

  test("requires complete mail configuration before subscriptions can enable", () => {
    expect(
      validateSiteConfig({
        ...example,
        subscriptions: { enabled: true, doubleOptIn: true },
      }),
    ).toBe(false);
  });

  test("accepts subscriptions only with complete valid mail configuration", () => {
    expect(
      validateSiteConfig({
        ...example,
        subscriptions: {
          enabled: true,
          doubleOptIn: true,
          notificationFanoutEnabled: false,
          delivery: {
            provider: "ses",
            region: "us-east-1",
            senderEmail: "status@example.com",
            contactListName: "status-updates",
            topicName: "incidents",
          },
          confirmationTtlSeconds: 86_400,
          resendCooldownSeconds: 900,
        },
      }),
    ).toBe(true);
    expect(
      validateSiteConfig({
        ...example,
        subscriptions: {
          enabled: true,
          disabledReason: "not-ready",
          doubleOptIn: true,
          notificationFanoutEnabled: false,
          delivery: {
            provider: "ses",
            region: "us-east-1",
            senderEmail: "status@example.com",
            contactListName: "status-updates",
            topicName: "incidents",
          },
          confirmationTtlSeconds: 86_400,
          resendCooldownSeconds: 900,
        },
      }),
    ).toBe(false);
    expect(
      validateSiteConfig({
        ...example,
        subscriptions: {
          enabled: true,
          doubleOptIn: true,
          notificationFanoutEnabled: false,
          delivery: {
            provider: "ses",
            region: "us-east-1",
            senderEmail: "not-an-email",
            contactListName: "status-updates",
            topicName: "incidents",
          },
          confirmationTtlSeconds: 86_400,
          resendCooldownSeconds: 900,
        },
      }),
    ).toBe(false);
    expect(
      validateSiteConfig({
        ...example,
        subscriptions: {
          enabled: true,
          doubleOptIn: true,
          notificationFanoutEnabled: false,
          delivery: {
            provider: "ses",
            region: "us-east-1",
            senderEmail: "status@example.com",
            contactListName: "status-updates",
            topicName: "incidents",
          },
          confirmationTtlSeconds: 900,
          resendCooldownSeconds: 900,
        },
      }),
    ).toBe(false);
  });

  test("accepts SMTP through a secret reference with site-owned template options", () => {
    expect(
      validateSiteConfig({
        ...example,
        subscriptions: {
          enabled: true,
          doubleOptIn: true,
          notificationFanoutEnabled: false,
          delivery: {
            provider: "smtp",
            connection: {
              provider: "aws-secrets-manager",
              reference: "example/status/smtp",
            },
            senderName: "Example Service status",
            senderEmail: "status@example.com",
            replyToEmail: "support@example.com",
          },
          templates: {
            logoPath: "./assets/logo-light.svg",
            headerMedia: {
              path: "./assets/status-wave.gif",
              alt: "A calm status indicator",
            },
            subjectPrefix: "Example status",
            incidentEmoticon: ":(",
            maintenanceEmoticon: ":)",
            resolvedEmoticon: "^_^",
            signOff: "The Example Service team",
          },
          confirmationTtlSeconds: 86_400,
          resendCooldownSeconds: 900,
        },
      }),
    ).toBe(true);
  });

  test("accepts Resend through a secret reference", () => {
    expect(
      validateSiteConfig({
        ...example,
        subscriptions: {
          enabled: true,
          doubleOptIn: true,
          notificationFanoutEnabled: false,
          delivery: {
            provider: "resend",
            connection: { provider: "environment", reference: "RESEND_API_KEY" },
            senderName: "Example Service status",
            senderEmail: "status@example.com",
          },
          confirmationTtlSeconds: 86_400,
          resendCooldownSeconds: 900,
        },
      }),
    ).toBe(true);
  });

  test("rejects inline template markup and unsafe mail asset paths", () => {
    const smtp = {
      enabled: true,
      doubleOptIn: true,
      notificationFanoutEnabled: false,
      delivery: {
        provider: "smtp",
        connection: { provider: "environment", reference: "SMTP_CONNECTION" },
        senderEmail: "status@example.com",
      },
      confirmationTtlSeconds: 86_400,
      resendCooldownSeconds: 900,
    } as const;

    expect(
      validateSiteConfig({
        ...example,
        subscriptions: { ...smtp, templates: { rawHtml: "<script>bad()</script>" } },
      }),
    ).toBe(false);
    expect(
      validateSiteConfig({
        ...example,
        subscriptions: {
          ...smtp,
          templates: {
            headerMedia: { path: "./../private.gif", alt: "Private image" },
          },
        },
      }),
    ).toBe(false);
  });
});

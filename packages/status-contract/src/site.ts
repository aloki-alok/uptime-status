import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

const SlugSchema = Type.String({
  minLength: 1,
  maxLength: 80,
  pattern: "^[a-z0-9-]+$",
});
const HttpsUrlSchema = Type.String({
  minLength: 8,
  maxLength: 500,
  pattern: "^https://",
});
const HexColorSchema = Type.String({ pattern: "^#[0-9a-fA-F]{6}$" });
const NonBlankStringSchema = Type.String({
  minLength: 1,
  maxLength: 180,
  pattern: "\\S",
});

const SecretReferenceSchema = Type.Object(
  {
    provider: Type.Union([Type.Literal("aws-secrets-manager"), Type.Literal("environment")]),
    reference: Type.String({ minLength: 3, maxLength: 300, pattern: "\\S" }),
  },
  { additionalProperties: false },
);

const CommunitySchema = Type.Object(
  {
    kind: Type.Union([Type.Literal("discord"), Type.Literal("forum"), Type.Literal("community")]),
    label: Type.String({ minLength: 1, maxLength: 120 }),
    url: HttpsUrlSchema,
  },
  { additionalProperties: false },
);

const UptimeKumaSourceSchema = Type.Object(
  {
    sourceId: SlugSchema,
    adapter: Type.Literal("uptime-kuma"),
    connection: SecretReferenceSchema,
  },
  { additionalProperties: false },
);

const FixtureSourceSchema = Type.Object(
  {
    sourceId: SlugSchema,
    adapter: Type.Literal("fixture"),
    fixture: Type.Literal("generated"),
  },
  { additionalProperties: false },
);

const ComponentConfigSchema = Type.Object(
  {
    componentId: SlugSchema,
    name: Type.String({ minLength: 1, maxLength: 120 }),
    group: Type.String({ minLength: 1, maxLength: 120 }),
    sourceId: SlugSchema,
    monitorRef: Type.String({ minLength: 1, maxLength: 160 }),
    showLatency: Type.Boolean(),
  },
  { additionalProperties: false },
);

const SenderFields = {
  senderName: Type.Optional(NonBlankStringSchema),
  senderEmail: Type.String({
    pattern: EMAIL.source,
    minLength: 3,
    maxLength: 254,
  }),
  replyToEmail: Type.Optional(Type.String({ pattern: EMAIL.source, minLength: 3, maxLength: 254 })),
};

const EmailDeliverySchema = Type.Union([
  Type.Object(
    {
      provider: Type.Literal("ses"),
      region: Type.String({
        minLength: 3,
        maxLength: 30,
        pattern: "^[a-z]{2}-[a-z]+-[0-9]+$",
      }),
      ...SenderFields,
      contactListName: Type.String({
        minLength: 1,
        maxLength: 64,
        pattern: "^[A-Za-z0-9_-]+$",
      }),
      topicName: Type.String({
        minLength: 1,
        maxLength: 64,
        pattern: "^[A-Za-z0-9_-]+$",
      }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      provider: Type.Literal("smtp"),
      connection: SecretReferenceSchema,
      ...SenderFields,
    },
    { additionalProperties: false },
  ),
]);

const EmailTemplateSchema = Type.Object(
  {
    logoPath: Type.Optional(Type.String({ minLength: 3, maxLength: 300, pattern: "^\\./" })),
    headerMedia: Type.Optional(
      Type.Object(
        {
          path: Type.String({
            minLength: 7,
            maxLength: 300,
            pattern: "^\\./.*\\.(gif|png|jpg|jpeg)$",
          }),
          alt: Type.String({ minLength: 1, maxLength: 160, pattern: "\\S" }),
        },
        { additionalProperties: false },
      ),
    ),
    subjectPrefix: Type.Optional(Type.String({ minLength: 1, maxLength: 40, pattern: "\\S" })),
    incidentEmoticon: Type.Optional(Type.String({ minLength: 1, maxLength: 16, pattern: "\\S" })),
    maintenanceEmoticon: Type.Optional(
      Type.String({ minLength: 1, maxLength: 16, pattern: "\\S" }),
    ),
    resolvedEmoticon: Type.Optional(Type.String({ minLength: 1, maxLength: 16, pattern: "\\S" })),
    signOff: Type.Optional(Type.String({ minLength: 1, maxLength: 120, pattern: "\\S" })),
  },
  { additionalProperties: false },
);

const SubscriptionConfigSchema = Type.Union([
  Type.Object(
    {
      enabled: Type.Literal(false),
      disabledReason: Type.String({
        minLength: 1,
        maxLength: 120,
        pattern: "\\S",
      }),
      doubleOptIn: Type.Literal(true),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      enabled: Type.Literal(true),
      doubleOptIn: Type.Literal(true),
      notificationFanoutEnabled: Type.Boolean(),
      delivery: EmailDeliverySchema,
      templates: Type.Optional(EmailTemplateSchema),
      confirmationTtlSeconds: Type.Integer({ minimum: 900, maximum: 604_800 }),
      resendCooldownSeconds: Type.Integer({ minimum: 60, maximum: 86_400 }),
    },
    { additionalProperties: false },
  ),
]);

export const SiteConfigSchema = Type.Object(
  {
    schemaVersion: Type.Literal("1.0.0"),
    deploymentMode: Type.Union([Type.Literal("example"), Type.Literal("production")]),
    siteId: SlugSchema,
    displayName: Type.String({ minLength: 1, maxLength: 120, pattern: "\\S" }),
    legalName: NonBlankStringSchema,
    locale: Type.String({ minLength: 2, maxLength: 35 }),
    timeZone: Type.String({ minLength: 1, maxLength: 80 }),
    domains: Type.Object(
      {
        primary: Type.String({ minLength: 3, maxLength: 253 }),
        legacy: Type.Optional(Type.String({ minLength: 3, maxLength: 253 })),
        preview: Type.Optional(Type.String({ minLength: 3, maxLength: 253 })),
      },
      { additionalProperties: false },
    ),
    brand: Type.Object(
      {
        homeUrl: HttpsUrlSchema,
        logoLightPath: Type.String({
          minLength: 3,
          maxLength: 300,
          pattern: "^\\./",
        }),
        logoDarkPath: Type.String({
          minLength: 3,
          maxLength: 300,
          pattern: "^\\./",
        }),
        iconLightPath: Type.String({
          minLength: 3,
          maxLength: 300,
          pattern: "^\\./",
        }),
        iconDarkPath: Type.String({
          minLength: 3,
          maxLength: 300,
          pattern: "^\\./",
        }),
        faviconPath: Type.String({
          minLength: 3,
          maxLength: 300,
          pattern: "^\\./",
        }),
        logoAlt: Type.String({ minLength: 1, maxLength: 160 }),
      },
      { additionalProperties: false },
    ),
    community: Type.Optional(CommunitySchema),
    presentation: Type.Object(
      {
        bannerVariant: Type.Optional(
          Type.Union([Type.Literal("classic"), Type.Literal("compact"), Type.Literal("plain")]),
        ),
        statusCopy: Type.Object(
          {
            operational: Type.String({ minLength: 1, maxLength: 120 }),
            degraded: Type.String({ minLength: 1, maxLength: 120 }),
            partialOutage: Type.String({ minLength: 1, maxLength: 120 }),
            majorOutage: Type.String({ minLength: 1, maxLength: 120 }),
            maintenance: Type.String({ minLength: 1, maxLength: 120 }),
            unknown: Type.String({ minLength: 1, maxLength: 120 }),
          },
          { additionalProperties: false },
        ),
        semanticColors: Type.Object(
          {
            operational: HexColorSchema,
            maintenance: HexColorSchema,
            degraded: HexColorSchema,
            outage: HexColorSchema,
            unknown: HexColorSchema,
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
    monitoring: Type.Object(
      {
        pollIntervalSeconds: Type.Integer({ minimum: 30, maximum: 300 }),
        staleAfterSeconds: Type.Integer({ minimum: 60, maximum: 900 }),
        sources: Type.Array(Type.Union([UptimeKumaSourceSchema, FixtureSourceSchema]), {
          minItems: 1,
        }),
      },
      { additionalProperties: false },
    ),
    components: Type.Array(ComponentConfigSchema, {
      minItems: 1,
      maxItems: 200,
    }),
    subscriptions: SubscriptionConfigSchema,
  },
  { additionalProperties: false },
);

export type SiteConfig = Static<typeof SiteConfigSchema>;

function unique(values: string[]) {
  return new Set(values).size === values.length;
}

function channel(value: number) {
  const normalized = value / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string) {
  const channels = [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)].map((value) =>
    channel(Number.parseInt(value, 16)),
  );
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(first: string, second: string) {
  const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

function hasReadableForeground(color: string) {
  return Math.max(contrast(color, "#ffffff"), contrast(color, "#101513")) >= 4.5;
}

function isHostname(value: string) {
  if (value.length > 253 || value.endsWith(".") || !value.includes(".")) return false;
  return value.split(".").every((label) => HOST_LABEL.test(label));
}

function isHttpsUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      isHostname(url.hostname)
    );
  } catch {
    return false;
  }
}

function isSafeRelativePath(value: string) {
  const segments = value.slice(2).split("/");
  return (
    value.startsWith("./") &&
    !value.includes("\\") &&
    Array.from(value).every((character) => {
      const code = character.charCodeAt(0);
      return code > 31 && code !== 127;
    }) &&
    segments.every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

function isTrimmedNonBlank(value: string) {
  return value === value.trim() && value.length > 0;
}

export function semanticForeground(color: string) {
  return contrast(color, "#ffffff") >= contrast(color, "#101513") ? "#ffffff" : "#101513";
}

export type SiteConfigIssue = {
  kind: "schema" | "semantic";
  path: string;
  message: string;
};

export function siteConfigIssues(input: unknown): SiteConfigIssue[] {
  const schemaIssues = [...Value.Errors(SiteConfigSchema, input)].map((error) => ({
    kind: "schema" as const,
    path: error.path || "/",
    message: error.message,
  }));
  if (schemaIssues.length > 0) return schemaIssues;

  const config = input as SiteConfig;
  const issues: SiteConfigIssue[] = [];
  const add = (path: string, message: string) => issues.push({ kind: "semantic", path, message });

  try {
    new Intl.Locale(config.locale);
  } catch {
    add("/locale", "must be a valid locale");
  }
  try {
    new Intl.DateTimeFormat(config.locale, { timeZone: config.timeZone });
  } catch {
    add("/timeZone", "must be a valid IANA time zone for the configured locale");
  }

  const domains = Object.entries(config.domains).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  for (const [name, value] of domains) {
    if (!isHostname(value)) add(`/domains/${name}`, "must be a valid hostname");
  }
  if (!unique(domains.map(([, value]) => value.toLowerCase()))) {
    add("/domains", "domain values must be unique");
  }
  if (!isHttpsUrl(config.brand.homeUrl)) {
    add("/brand/homeUrl", "must be an HTTPS URL without credentials, query, or fragment");
  }
  if (config.community && !isHttpsUrl(config.community.url)) {
    add("/community/url", "must be an HTTPS URL without credentials, query, or fragment");
  }

  const paths: Array<[string, string]> = [
    ["/brand/logoLightPath", config.brand.logoLightPath],
    ["/brand/logoDarkPath", config.brand.logoDarkPath],
    ["/brand/iconLightPath", config.brand.iconLightPath],
    ["/brand/iconDarkPath", config.brand.iconDarkPath],
    ["/brand/faviconPath", config.brand.faviconPath],
  ];
  if (config.subscriptions.enabled && config.subscriptions.templates?.logoPath) {
    paths.push(["/subscriptions/templates/logoPath", config.subscriptions.templates.logoPath]);
  }
  if (config.subscriptions.enabled && config.subscriptions.templates?.headerMedia) {
    paths.push([
      "/subscriptions/templates/headerMedia/path",
      config.subscriptions.templates.headerMedia.path,
    ]);
  }
  for (const [path, value] of paths) {
    if (!isSafeRelativePath(value)) add(path, "must be a safe ./ relative path");
  }

  if (config.deploymentMode === "production") {
    config.monitoring.sources.forEach((source, index) => {
      if (source.adapter === "fixture") {
        add(
          `/monitoring/sources/${index}/adapter`,
          "fixture monitoring is not allowed in production",
        );
      }
    });
  }

  const textValues: Array<[string, string]> = [
    ["/displayName", config.displayName],
    ["/legalName", config.legalName],
    ...Object.entries(config.presentation.statusCopy).map(
      ([key, value]) => [`/presentation/statusCopy/${key}`, value] as [string, string],
    ),
    ...config.components.flatMap((component, index) => [
      [`/components/${index}/name`, component.name] as [string, string],
      [`/components/${index}/group`, component.group] as [string, string],
      [`/components/${index}/monitorRef`, component.monitorRef] as [string, string],
    ]),
  ];
  config.monitoring.sources.forEach((source, index) => {
    if (source.adapter === "uptime-kuma") {
      textValues.push([
        `/monitoring/sources/${index}/connection/reference`,
        source.connection.reference,
      ]);
    }
  });
  if (config.community) textValues.push(["/community/label", config.community.label]);
  if (config.subscriptions.enabled) {
    textValues.push([
      "/subscriptions/delivery/senderName",
      config.subscriptions.delivery.senderName ?? config.displayName,
    ]);
    if (config.subscriptions.delivery.provider === "smtp") {
      textValues.push([
        "/subscriptions/delivery/connection/reference",
        config.subscriptions.delivery.connection.reference,
      ]);
    }
    const templates = config.subscriptions.templates;
    const optionalTexts: Array<[string, string | undefined]> = [
      ["/subscriptions/templates/headerMedia/alt", templates?.headerMedia?.alt],
      ["/subscriptions/templates/subjectPrefix", templates?.subjectPrefix],
      ["/subscriptions/templates/incidentEmoticon", templates?.incidentEmoticon],
      ["/subscriptions/templates/maintenanceEmoticon", templates?.maintenanceEmoticon],
      ["/subscriptions/templates/resolvedEmoticon", templates?.resolvedEmoticon],
      ["/subscriptions/templates/signOff", templates?.signOff],
    ];
    for (const [path, value] of optionalTexts) {
      if (value !== undefined) textValues.push([path, value]);
    }
  } else {
    textValues.push(["/subscriptions/disabledReason", config.subscriptions.disabledReason]);
  }
  for (const [path, value] of textValues) {
    if (!isTrimmedNonBlank(value)) add(path, "must be trimmed and non-blank");
  }

  const sourceIds = config.monitoring.sources.map((source) => source.sourceId);
  const componentIds = config.components.map((component) => component.componentId);
  const bindings = config.components.map(
    (component) => `${component.sourceId}\u0000${component.monitorRef}`,
  );
  if (!unique(sourceIds)) add("/monitoring/sources", "sourceId values must be unique");
  if (!unique(componentIds)) add("/components", "componentId values must be unique");
  if (!unique(bindings)) add("/components", "source and monitor bindings must be unique");
  config.components.forEach((component, index) => {
    if (!sourceIds.includes(component.sourceId)) {
      add(`/components/${index}/sourceId`, "must reference a configured monitoring source");
    }
  });
  if (config.monitoring.staleAfterSeconds < config.monitoring.pollIntervalSeconds * 2) {
    add("/monitoring/staleAfterSeconds", "must be at least two polling intervals");
  }

  const colors = Object.entries(config.presentation.semanticColors);
  if (!unique(colors.map(([, color]) => color.toLowerCase()))) {
    add("/presentation/semanticColors", "semantic colors must be unique");
  }
  for (const [name, color] of colors) {
    if (!hasReadableForeground(color)) {
      add(
        `/presentation/semanticColors/${name}`,
        "must support 4.5:1 contrast with black or white text",
      );
    }
  }
  if (
    config.subscriptions.enabled &&
    config.subscriptions.resendCooldownSeconds >= config.subscriptions.confirmationTtlSeconds
  ) {
    add("/subscriptions/resendCooldownSeconds", "must be shorter than confirmationTtlSeconds");
  }

  return issues;
}

export function validateSiteConfig(input: unknown): input is SiteConfig {
  return siteConfigIssues(input).length === 0;
}

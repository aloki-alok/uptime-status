export type DeploymentEnvironment = "preview" | "production";

export type DisabledDelivery = {
  subscriptionsEnabled: false;
  fanoutEnabled: false;
};

export type SesDelivery = {
  subscriptionsEnabled: true;
  fanoutEnabled: boolean;
  region: string;
  senderEmail: string;
  configurationSetName: string;
  contactListName: string;
  topicName: string;
};

export type HistoryMigration =
  | {
      mode: "required";
      sourceSystemId: string;
      importId: string;
      bundleSha256: string;
      topologyRevision: string;
      minimumDays: number;
    }
  | { mode: "not-required"; reason: string };

export type DeploymentInputs = {
  schemaVersion: "1.0.0";
  siteId: string;
  environment: DeploymentEnvironment;
  aws: {
    accountId: string;
    region: string;
  };
  build: {
    siteConfigPath: string;
    snapshotPath: string;
    platformRevision: string;
  };
  monitoringSecretArn: string;
  historyMigration: HistoryMigration;
  subscriptionSecretArns?: {
    emailLookupPepper: string;
    confirmationTokenPepper: string;
    unsubscribeSigningKey: string;
  };
  domain: {
    customHostname?: string;
    certificateArn?: string;
  };
  delivery: DisabledDelivery | SesDelivery;
};

export type ValidationIssue = {
  path: string;
  message: string;
};

export type ValidationResult =
  | { ok: true; value: DeploymentInputs }
  | { ok: false; issues: ValidationIssue[] };

const SITE_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const AWS_ACCOUNT_ID = /^\d{12}$/;
const AWS_REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/;
const PLATFORM_REVISION = /^(?:[a-f0-9]{7,40}|v?\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?)$/i;
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONFIGURATION_NAME = /^[A-Za-z0-9_-]{1,64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isNonBlank(value: unknown): value is string {
  return typeof value === "string" && value === value.trim() && value.length > 0;
}

function isAbsolutePath(value: unknown): value is string {
  return isNonBlank(value) && value.startsWith("/") && !value.includes("\0");
}

function isHostname(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 253 &&
    value.includes(".") &&
    !value.endsWith(".") &&
    value.split(".").every((label) => HOST_LABEL.test(label))
  );
}

function isSecretArn(value: unknown, accountId: string, region: string): value is string {
  if (typeof value !== "string") return false;
  const prefix = `arn:aws:secretsmanager:${region}:${accountId}:secret:`;
  return value.startsWith(prefix) && value.length > prefix.length;
}

function issue(issues: ValidationIssue[], path: string, message: string) {
  issues.push({ path, message });
}

export function validateDeploymentInputs(input: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (!isRecord(input)) return { ok: false, issues: [{ path: "$", message: "Must be an object" }] };

  if (
    !hasOnlyKeys(input, [
      "schemaVersion",
      "siteId",
      "environment",
      "aws",
      "build",
      "monitoringSecretArn",
      "historyMigration",
      "subscriptionSecretArns",
      "domain",
      "delivery",
    ])
  ) {
    issue(issues, "$", "Contains unknown fields");
  }
  if (input.schemaVersion !== "1.0.0") issue(issues, "schemaVersion", "Must equal 1.0.0");
  if (typeof input.siteId !== "string" || !SITE_ID.test(input.siteId)) {
    issue(issues, "siteId", "Must be a lowercase DNS-safe identifier");
  }
  if (input.environment !== "preview" && input.environment !== "production") {
    issue(issues, "environment", "Must be preview or production");
  }

  const aws = input.aws;
  if (!isRecord(aws) || !hasOnlyKeys(aws, ["accountId", "region"])) {
    issue(issues, "aws", "Must contain only accountId and region");
  }
  const accountId = isRecord(aws) && typeof aws.accountId === "string" ? aws.accountId : "";
  const region = isRecord(aws) && typeof aws.region === "string" ? aws.region : "";
  if (!AWS_ACCOUNT_ID.test(accountId))
    issue(issues, "aws.accountId", "Must be a 12-digit AWS account ID");
  if (!AWS_REGION.test(region)) issue(issues, "aws.region", "Must be an AWS region");

  const build = input.build;
  if (
    !isRecord(build) ||
    !hasOnlyKeys(build, ["siteConfigPath", "snapshotPath", "platformRevision"])
  ) {
    issue(issues, "build", "Must contain only siteConfigPath, snapshotPath, and platformRevision");
  } else {
    if (!isAbsolutePath(build.siteConfigPath)) {
      issue(issues, "build.siteConfigPath", "Must be an absolute path");
    }
    if (!isAbsolutePath(build.snapshotPath)) {
      issue(issues, "build.snapshotPath", "Must be an absolute path");
    }
    if (
      typeof build.platformRevision !== "string" ||
      !PLATFORM_REVISION.test(build.platformRevision)
    ) {
      issue(issues, "build.platformRevision", "Must be a Git revision or semantic version");
    }
  }

  if (!isSecretArn(input.monitoringSecretArn, accountId, region)) {
    issue(
      issues,
      "monitoringSecretArn",
      "Must be a Secrets Manager ARN in the deployment account and region",
    );
  }

  const historyMigration = input.historyMigration;
  if (!isRecord(historyMigration) || typeof historyMigration.mode !== "string") {
    issue(issues, "historyMigration", "Must explicitly select required or not-required");
  } else if (historyMigration.mode === "required") {
    if (
      !hasOnlyKeys(historyMigration, [
        "mode",
        "sourceSystemId",
        "importId",
        "bundleSha256",
        "topologyRevision",
        "minimumDays",
      ])
    ) {
      issue(issues, "historyMigration", "Required migration contains unknown fields");
    }
    if (!isNonBlank(historyMigration.sourceSystemId)) {
      issue(issues, "historyMigration.sourceSystemId", "Must identify the legacy source");
    }
    if (
      typeof historyMigration.importId !== "string" ||
      !/^[a-f0-9]{64}$/.test(historyMigration.importId)
    ) {
      issue(issues, "historyMigration.importId", "Must be a canonical SHA-256 import ID");
    }
    if (
      typeof historyMigration.bundleSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(historyMigration.bundleSha256)
    ) {
      issue(issues, "historyMigration.bundleSha256", "Must be a SHA-256 bundle digest");
    }
    if (!isNonBlank(historyMigration.topologyRevision)) {
      issue(issues, "historyMigration.topologyRevision", "Must bind the mapped component topology");
    }
    if (
      typeof historyMigration.minimumDays !== "number" ||
      !Number.isInteger(historyMigration.minimumDays) ||
      historyMigration.minimumDays < 90 ||
      historyMigration.minimumDays > 3660
    ) {
      issue(issues, "historyMigration.minimumDays", "Must require between 90 and 3660 days");
    }
  } else if (historyMigration.mode === "not-required") {
    if (
      !hasOnlyKeys(historyMigration, ["mode", "reason"]) ||
      !isNonBlank(historyMigration.reason)
    ) {
      issue(issues, "historyMigration", "New sites require an explicit non-empty reason");
    }
  } else {
    issue(issues, "historyMigration.mode", "Must be required or not-required");
  }

  const domain = input.domain;
  if (!isRecord(domain) || !hasOnlyKeys(domain, ["customHostname", "certificateArn"])) {
    issue(issues, "domain", "Must contain only customHostname and certificateArn");
  } else {
    if (domain.customHostname !== undefined && !isHostname(domain.customHostname)) {
      issue(issues, "domain.customHostname", "Must be a valid hostname");
    }
    if (
      domain.certificateArn !== undefined &&
      (typeof domain.certificateArn !== "string" ||
        !domain.certificateArn.startsWith(`arn:aws:acm:us-east-1:${accountId}:certificate/`))
    ) {
      issue(
        issues,
        "domain.certificateArn",
        "CloudFront certificate must be an ACM ARN in us-east-1",
      );
    }
    if (input.environment === "preview" && (domain.customHostname || domain.certificateArn)) {
      issue(issues, "domain", "Preview deployments use the generated CloudFront hostname");
    }
    if (input.environment === "production" && (!domain.customHostname || !domain.certificateArn)) {
      issue(issues, "domain", "Production requires a custom hostname and us-east-1 certificate");
    }
  }

  const delivery = input.delivery;
  if (!isRecord(delivery) || typeof delivery.subscriptionsEnabled !== "boolean") {
    issue(issues, "delivery", "Must select disabled delivery or SES delivery");
  } else if (delivery.subscriptionsEnabled === false) {
    if (
      !hasOnlyKeys(delivery, ["subscriptionsEnabled", "fanoutEnabled"]) ||
      delivery.fanoutEnabled !== false
    ) {
      issue(issues, "delivery", "Disabled subscriptions require fanoutEnabled=false");
    }
    if (input.subscriptionSecretArns !== undefined) {
      issue(
        issues,
        "subscriptionSecretArns",
        "Subscription secrets are not accepted while subscriptions are disabled",
      );
    }
  } else {
    const allowed = [
      "subscriptionsEnabled",
      "fanoutEnabled",
      "region",
      "senderEmail",
      "configurationSetName",
      "contactListName",
      "topicName",
    ];
    if (!hasOnlyKeys(delivery, allowed))
      issue(issues, "delivery", "SES delivery contains unknown fields");
    if (typeof delivery.fanoutEnabled !== "boolean") {
      issue(issues, "delivery.fanoutEnabled", "Must be a boolean");
    }
    if (delivery.region !== region)
      issue(issues, "delivery.region", "Must match the core deployment region");
    if (typeof delivery.senderEmail !== "string" || !EMAIL.test(delivery.senderEmail)) {
      issue(issues, "delivery.senderEmail", "Must be a valid sender address");
    }
    for (const key of ["configurationSetName", "contactListName", "topicName"] as const) {
      if (typeof delivery[key] !== "string" || !CONFIGURATION_NAME.test(delivery[key])) {
        issue(issues, `delivery.${key}`, "Must be a valid SES configuration name");
      }
    }
    const secrets = input.subscriptionSecretArns;
    if (
      !isRecord(secrets) ||
      !hasOnlyKeys(secrets, [
        "emailLookupPepper",
        "confirmationTokenPepper",
        "unsubscribeSigningKey",
      ])
    ) {
      issue(
        issues,
        "subscriptionSecretArns",
        "Enabled subscriptions require exactly three secret ARNs",
      );
    } else {
      for (const key of [
        "emailLookupPepper",
        "confirmationTokenPepper",
        "unsubscribeSigningKey",
      ] as const) {
        if (!isSecretArn(secrets[key], accountId, region)) {
          issue(
            issues,
            `subscriptionSecretArns.${key}`,
            "Must be a secret ARN in the deployment account and region",
          );
        }
      }
    }
  }

  return issues.length === 0
    ? { ok: true, value: input as DeploymentInputs }
    : { ok: false, issues };
}

export function assertDeploymentInputs(input: unknown): DeploymentInputs {
  const result = validateDeploymentInputs(input);
  if (result.ok) return result.value;
  throw new Error(result.issues.map(({ path, message }) => `${path}: ${message}`).join("\n"));
}

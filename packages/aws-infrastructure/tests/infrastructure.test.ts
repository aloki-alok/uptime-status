import { describe, expect, test } from "bun:test";
import {
  createDeploymentNames,
  createDeploymentPlan,
  createIamRoleBoundaries,
  type DeploymentInputs,
  deploymentIsReady,
  type ReleaseEvidence,
  releaseGateIds,
  requiredReleaseGates,
  validateDeploymentInputs,
  validateIamRoleBoundaries,
} from "../src";

const ACCOUNT_ID = "123456789012";
const REGION = "ap-south-1";

function secret(name: string) {
  return `arn:aws:secretsmanager:${REGION}:${ACCOUNT_ID}:secret:${name}-abc123`;
}

function previewInput(overrides: Partial<DeploymentInputs> = {}): DeploymentInputs {
  return {
    schemaVersion: "1.0.0",
    siteId: "example-service",
    environment: "preview",
    aws: { accountId: ACCOUNT_ID, region: REGION },
    build: {
      siteConfigPath: "/workspace/status.config.json",
      snapshotPath: "/workspace/current.json",
      platformRevision: "0123456789abcdef0123456789abcdef01234567",
    },
    monitoringSecretArn: secret("monitoring"),
    historyMigration: { mode: "not-required", reason: "Synthetic new-site test deployment" },
    domain: {},
    delivery: { subscriptionsEnabled: false, fanoutEnabled: false },
    ...overrides,
  };
}

function requiredHistory() {
  return {
    historyMigration: {
      mode: "required" as const,
      sourceSystemId: "uptime-kuma",
      importId: "a".repeat(64),
      bundleSha256: "b".repeat(64),
      topologyRevision: "topology-001",
      minimumDays: 90,
    },
  };
}

function productionInput(overrides: Partial<DeploymentInputs> = {}): DeploymentInputs {
  return previewInput({
    environment: "production",
    domain: {
      customHostname: "status.example.com",
      certificateArn: `arn:aws:acm:us-east-1:${ACCOUNT_ID}:certificate/12345678-abcd-1234-abcd-123456789012`,
    },
    ...overrides,
  });
}

function sesDelivery() {
  return {
    delivery: {
      subscriptionsEnabled: true as const,
      fanoutEnabled: true,
      region: REGION,
      senderEmail: "status@example.com",
      configurationSetName: "status_delivery",
      contactListName: "status_subscribers",
      topicName: "status_updates",
    },
    subscriptionSecretArns: {
      emailLookupPepper: secret("email-lookup"),
      confirmationTokenPepper: secret("confirmation-token"),
      unsubscribeSigningKey: secret("unsubscribe-signing"),
    },
  };
}

function passedEvidence(ids: readonly string[]): ReleaseEvidence {
  return Object.fromEntries(
    ids.map((id) => [
      id,
      {
        state: "passed",
        checkedAt: "2026-09-08T10:00:00.000Z",
        proof: `verified:${id}`,
        artifactRevision: previewInput().build.platformRevision,
      },
    ]),
  ) as ReleaseEvidence;
}

describe("deployment inputs", () => {
  test("accepts a delivery-disabled CloudFront preview", () => {
    expect(validateDeploymentInputs(previewInput())).toEqual({
      ok: true,
      value: previewInput(),
    });
  });

  test("requires a us-east-1 certificate and hostname for production", () => {
    const result = validateDeploymentInputs(
      productionInput({ domain: { customHostname: "status.example.com" } }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((item) => item.path)).toContain("domain");
  });

  test("rejects custom domains in preview and secrets from another account", () => {
    const result = validateDeploymentInputs(
      previewInput({
        domain: { customHostname: "preview.example.com" },
        monitoringSecretArn: `arn:aws:secretsmanager:${REGION}:999999999999:secret:monitoring`,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((item) => item.path)).toContain("domain");
      expect(result.issues.map((item) => item.path)).toContain("monitoringSecretArn");
    }
  });

  test("requires all subscription secrets and same-region SES", () => {
    const enabled = sesDelivery();
    const result = validateDeploymentInputs(
      previewInput({
        delivery: { ...enabled.delivery, region: "us-east-1" },
        subscriptionSecretArns: undefined,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((item) => item.path)).toContain("delivery.region");
      expect(result.issues.map((item) => item.path)).toContain("subscriptionSecretArns");
    }
  });

  test("rejects a non-boolean fanout gate", () => {
    const enabled = sesDelivery();
    const result = validateDeploymentInputs(
      previewInput({
        ...enabled,
        delivery: { ...enabled.delivery, fanoutEnabled: "yes" } as never,
      }),
    );
    expect(result.ok).toBe(false);
  });

  test("rejects unknown deployment fields", () => {
    const result = validateDeploymentInputs({ ...previewInput(), unexpected: true });
    expect(result.ok).toBe(false);
  });

  test("requires an explicit legacy-history decision and validates required imports", () => {
    const missing = validateDeploymentInputs({ ...previewInput(), historyMigration: undefined });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.issues.map((item) => item.path)).toContain("historyMigration");
    }

    expect(validateDeploymentInputs(previewInput(requiredHistory()))).toEqual({
      ok: true,
      value: previewInput(requiredHistory()),
    });
    const short = validateDeploymentInputs(
      previewInput({
        historyMigration: { ...requiredHistory().historyMigration, minimumDays: 30 },
      }),
    );
    expect(short.ok).toBe(false);
    if (!short.ok) {
      expect(short.issues.map((item) => item.path)).toContain("historyMigration.minimumDays");
    }
  });
});

describe("resource naming", () => {
  test("is deterministic, bounded, and separates environments", () => {
    const preview = createDeploymentNames(previewInput());
    const repeated = createDeploymentNames(previewInput());
    const production = createDeploymentNames(productionInput());

    expect(preview).toEqual(repeated);
    expect(preview.publicBucket.length).toBeLessThanOrEqual(63);
    expect(preview.publisherFunction.length).toBeLessThanOrEqual(64);
    expect(preview.deliveryQueue.length).toBeLessThanOrEqual(80);
    expect(preview.publicBucket).not.toBe(production.publicBucket);
    expect(preview.stack).not.toBe(production.stack);
  });

  test("keeps long valid site IDs within every AWS limit", () => {
    const input = previewInput({ siteId: `site-${"a".repeat(56)}` });
    const names = createDeploymentNames(input);
    expect(names.publicBucket.length).toBeLessThanOrEqual(63);
    expect(names.publisherFunction.length).toBeLessThanOrEqual(64);
    expect(names.deliveryDeadLetterQueue.length).toBeLessThanOrEqual(80);
    expect(names.stack.length).toBeLessThanOrEqual(128);
  });
});

describe("IAM role boundaries", () => {
  test("keeps delivery roles absent while subscriptions are disabled", () => {
    const roles = createIamRoleBoundaries(previewInput());
    expect(roles.map((item) => item.role)).toEqual(["publisher", "admin-api"]);
    expect(validateIamRoleBoundaries(roles)).toBe(true);
  });

  test("separates status publication, public writes, administration, and sending", () => {
    const enabled = sesDelivery();
    const roles = createIamRoleBoundaries(previewInput(enabled));
    expect(validateIamRoleBoundaries(roles)).toBe(true);

    const publisher = roles.find((item) => item.role === "publisher");
    const publicApi = roles.find((item) => item.role === "public-api");
    const adminApi = roles.find((item) => item.role === "admin-api");
    const sender = roles.find((item) => item.role === "sender");

    expect(publisher?.capabilities).toContain("snapshot:write");
    expect(publisher?.capabilities).not.toContain("ses:send");
    expect(publicApi?.capabilities).toContain("subscriber:write");
    expect(publicApi?.capabilities).not.toContain("control:write");
    expect(adminApi?.capabilities).toContain("control:write");
    expect(adminApi?.capabilities).not.toContain("subscriber:read");
    expect(sender?.capabilities).toContain("ses:send");
    expect(sender?.capabilities).not.toContain("subscriber:write");
  });

  test("rejects an accidental forbidden capability", () => {
    const roles = createIamRoleBoundaries(previewInput());
    roles[0]?.capabilities.push("ses:send");
    expect(validateIamRoleBoundaries(roles)).toBe(false);
  });

  test("adds a narrow history importer only when legacy migration is required", () => {
    const roles = createIamRoleBoundaries(previewInput(requiredHistory()));
    const importer = roles.find((item) => item.role === "history-importer");
    expect(importer?.capabilities).toContain("history:write");
    expect(importer?.capabilities).not.toContain("monitoring-secret:read");
    expect(importer?.capabilities).not.toContain("subscriber:read");
    expect(importer?.secretArns).toEqual([]);
    expect(validateIamRoleBoundaries(roles)).toBe(true);
  });
});

describe("release gates and deployment stages", () => {
  test("keeps preview limited to the independent read path when delivery is disabled", () => {
    const input = previewInput();
    expect(requiredReleaseGates(input)).not.toContain("ses-production-access");
    expect(createDeploymentPlan(input).map((item) => item.id)).toEqual([
      "validate-inputs",
      "build-artifacts",
      "review-infrastructure",
      "apply-core-stack",
      "seed-status-snapshot",
      "verify-independent-read-path",
    ]);
    expect(createDeploymentPlan(input).find((item) => item.id === "apply-core-stack")?.ready).toBe(
      false,
    );
  });

  test("cannot enable fanout without SES and suppression evidence", () => {
    const input = previewInput(sesDelivery());
    const evidence = passedEvidence([
      "quality-suite",
      "site-isolation",
      "production-build",
      "immutable-image",
      "infrastructure-plan-reviewed",
      "preview-read-path",
      "private-origin",
      "stale-source-failure",
      "invalid-snapshot-rejection",
      "subscription-lifecycle",
      "sender-kill-switch",
      "verified-recipient-delivery",
    ]);
    const fanout = createDeploymentPlan(input, evidence).find(
      (item) => item.id === "enable-notification-fanout",
    );
    expect(fanout?.ready).toBe(false);
    expect(fanout?.blockedBy).toEqual([
      "ses-production-access",
      "feedback-suppression",
      "delivery-replay",
    ]);
  });

  test("never makes a production mutation ready without explicit approval", () => {
    const input = productionInput();
    const evidence = passedEvidence(releaseGateIds.filter((id) => id !== "production-approval"));
    const productionMutations = createDeploymentPlan(input, evidence).filter(
      (item) => item.mutation === "production",
    );
    expect(productionMutations.some((item) => item.ready)).toBe(false);
    expect(deploymentIsReady(input, evidence)).toBe(false);
  });

  test("becomes ready only when every required gate passes", () => {
    const input = productionInput(sesDelivery());
    const evidence = passedEvidence(requiredReleaseGates(input));
    expect(deploymentIsReady(input, evidence)).toBe(true);
  });

  test("rejects passing evidence from a different artifact revision", () => {
    const input = previewInput();
    const evidence = passedEvidence(requiredReleaseGates(input));
    const quality = evidence["quality-suite"];
    if (quality) quality.artifactRevision = "abcdef0";
    expect(deploymentIsReady(input, evidence)).toBe(false);
  });

  test("blocks status seeding and DNS until bound history evidence passes", () => {
    const input = productionInput(requiredHistory());
    const withoutHistory = passedEvidence(
      requiredReleaseGates(input).filter((id) => !id.startsWith("history-import-")),
    );
    const blocked = createDeploymentPlan(input, withoutHistory);
    expect(blocked.map((item) => item.id)).toContain("preview-history-import");
    expect(blocked.find((item) => item.id === "seed-status-snapshot")?.blockedBy).toContain(
      "history-import-verified",
    );
    expect(blocked.find((item) => item.id === "cut-over-dns")?.blockedBy).toContain(
      "history-import-rollback-tested",
    );

    const evidence = passedEvidence(requiredReleaseGates(input));
    for (const id of requiredReleaseGates(input).filter((value) =>
      value.startsWith("history-import-"),
    )) {
      const base = evidence[id];
      if (!base) throw new Error(`Missing test evidence: ${id}`);
      evidence[id] = {
        ...base,
        siteId: input.siteId,
        topologyRevision: requiredHistory().historyMigration.topologyRevision,
        importId: requiredHistory().historyMigration.importId,
        bundleSha256: requiredHistory().historyMigration.bundleSha256,
      };
    }
    expect(deploymentIsReady(input, evidence)).toBe(true);

    const verified = evidence["history-import-verified"];
    if (verified) verified.importId = "c".repeat(64);
    expect(deploymentIsReady(input, evidence)).toBe(false);
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { SiteConfig } from "@uptime-status/domain";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import type { ReadPathDeploymentInputs } from "../src";
import { ReadPathStack } from "../src";

const ACCOUNT_ID = "123456789012";
const REGION = "ap-south-1";
const MONITORING_SECRET_ARN =
  "arn:aws:secretsmanager:ap-south-1:123456789012:secret:monitoring-abc123";
let assetRoot = "";
let publicAssetPath = "";
let publisherAssetPath = "";

function previewInput(): ReadPathDeploymentInputs {
  return {
    schemaVersion: "1.0.0",
    siteId: "example-service",
    environment: "preview",
    aws: { accountId: ACCOUNT_ID, region: REGION },
    monitoringSecretArn: MONITORING_SECRET_ARN,
  };
}

function publisherSite(): SiteConfig {
  const input = JSON.parse(
    readFileSync(resolve(import.meta.dir, "../../../examples/status.config.json"), "utf8"),
  ) as SiteConfig;
  return {
    ...input,
    deploymentMode: "production",
    monitoring: {
      pollIntervalSeconds: 60,
      staleAfterSeconds: 120,
      sources: [
        {
          sourceId: "kuma",
          adapter: "uptime-kuma",
          connection: { provider: "aws-secrets-manager", reference: MONITORING_SECRET_ARN },
        },
      ],
    },
    components: input.components.map((component) => ({ ...component, sourceId: "kuma" })),
  };
}

function synthesize() {
  const app = new App();
  const stack = new ReadPathStack(app, "ReadPath", {
    deploymentInputs: previewInput(),
    publicAssetPath,
    publisherAssetPath,
    publisher: {
      site: publisherSite(),
      sourceId: "kuma",
    },
  });
  return Template.fromStack(stack);
}

beforeAll(() => {
  assetRoot = mkdtempSync(join(tmpdir(), "uptime-status-read-path-"));
  publicAssetPath = join(assetRoot, "public");
  publisherAssetPath = join(assetRoot, "publisher");
  mkdirSync(publicAssetPath);
  mkdirSync(publisherAssetPath);
  writeFileSync(join(publicAssetPath, "index.html"), "<!doctype html><title>Status</title>");
  writeFileSync(join(publisherAssetPath, "index.mjs"), "export async function handler() {}");
});

afterAll(() => {
  rmSync(assetRoot, { recursive: true, force: true });
});

describe("AWS read path", () => {
  test("keeps the versioned encrypted S3 origin private behind CloudFront OAC", () => {
    const template = synthesize();

    template.hasResourceProperties("AWS::S3::Bucket", {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
        ],
      },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      VersioningConfiguration: { Status: "Enabled" },
    });
    template.resourceCountIs("AWS::CloudFront::OriginAccessControl", 1);
    const distributions = template.findResources("AWS::CloudFront::Distribution");
    const config = Object.values(distributions)[0]?.Properties?.DistributionConfig;
    expect(config.Aliases).toBeUndefined();
    expect(config.DefaultRootObject).toBe("index.html");
    expect(config.Enabled).toBe(true);
    expect(config.Origins).toHaveLength(1);
    expect(config.Origins[0].OriginAccessControlId).toBeDefined();
    expect(config.Origins[0].S3OriginConfig).toEqual({ OriginAccessIdentity: "" });
  });

  test("rewrites only static routes and caps current.json caching at 30 seconds", () => {
    const template = synthesize();
    const functions = template.findResources("AWS::CloudFront::Function");
    const functionCode = Object.values(functions)[0]?.Properties?.FunctionCode as string;

    expect(functionCode).toContain('uri === "/"');
    expect(functionCode).toContain('uri.endsWith("/")');
    expect(functionCode).toContain('!uri.split("/").pop().includes(".")');
    template.hasResourceProperties("AWS::CloudFront::CachePolicy", {
      CachePolicyConfig: {
        DefaultTTL: 30,
        MaxTTL: 30,
        MinTTL: 0,
      },
    });
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: {
        CacheBehaviors: [
          {
            PathPattern: "current.json",
            ViewerProtocolPolicy: "redirect-to-https",
          },
        ],
      },
    });
  });

  test("runs the prebuilt Node 22 publisher every minute with a DLQ and retained logs", () => {
    const template = synthesize();

    const functions = template.findResources("AWS::Lambda::Function");
    const publisher = Object.values(functions).find(
      (resource) =>
        resource.Properties?.FunctionName === "uptime-status-example-service-preview-publisher",
    );
    expect(publisher?.Properties?.Architectures).toEqual(["arm64"]);
    expect(publisher?.Properties?.Handler).toBe("index.handler");
    expect(publisher?.Properties?.Runtime).toBe("nodejs22.x");
    expect(publisher?.Properties?.ReservedConcurrentExecutions).toBe(1);
    expect(publisher?.Properties?.Environment?.Variables).toMatchObject({
      MONITORING_SECRET_ARN,
      STATUS_SOURCE_ID: "kuma",
    });
    expect(JSON.parse(publisher?.Properties?.Environment?.Variables?.STATUS_SITE_CONFIG)).toEqual(
      publisherSite(),
    );
    expect(publisher?.Properties?.Environment?.Variables?.STATUS_BUCKET.Ref).toBeString();
    template.hasResourceProperties("AWS::Logs::LogGroup", {
      RetentionInDays: 30,
    });
    template.hasResourceProperties("AWS::SQS::Queue", {
      MessageRetentionPeriod: 1_209_600,
      SqsManagedSseEnabled: true,
    });
    const rules = template.findResources("AWS::Events::Rule");
    const rule = Object.values(rules)[0]?.Properties;
    expect(rule.ScheduleExpression).toBe("rate(1 minute)");
    expect(rule.State).toBe("ENABLED");
    expect(rule.Targets).toHaveLength(1);
    expect(rule.Targets[0].Arn["Fn::GetAtt"][1]).toBe("Arn");
    expect(rule.Targets[0].DeadLetterConfig.Arn["Fn::GetAtt"][1]).toBe("Arn");
    expect(rule.Targets[0].RetryPolicy).toEqual({
      MaximumEventAgeInSeconds: 300,
      MaximumRetryAttempts: 2,
    });
  });

  test("limits publisher S3 access to current.json and immutable snapshots", () => {
    const template = synthesize();
    template.resourceCountIs("AWS::SecretsManager::Secret", 0);
    const functions = template.findResources("AWS::Lambda::Function");
    const publisher = Object.values(functions).find(
      (resource) =>
        resource.Properties?.FunctionName === "uptime-status-example-service-preview-publisher",
    );
    const publisherRole = publisher?.Properties?.Role?.["Fn::GetAtt"]?.[0];
    const policies = template.findResources("AWS::IAM::Policy");
    const publisherPolicy = Object.values(policies).find((resource) =>
      resource.Properties?.Roles?.some((role: { Ref?: string }) => role.Ref === publisherRole),
    );
    const statements = (publisherPolicy?.Properties?.PolicyDocument?.Statement ?? []) as Array<{
      Action?: string | string[];
      Resource?: unknown;
    }>;
    const get = statements.find((statement) => statement.Action === "s3:GetObject");
    const put = statements.find((statement) => statement.Action === "s3:PutObject");

    expect(JSON.stringify(get?.Resource)).toContain("current.json");
    expect(JSON.stringify(get?.Resource)).not.toContain("snapshots/*");
    expect(JSON.stringify(put?.Resource)).toContain("current.json");
    expect(JSON.stringify(put?.Resource)).toContain("snapshots/*");
    expect(
      statements.some((statement) => JSON.stringify(statement.Action).includes("s3:Delete")),
    ).toBe(false);
    const secret = statements.find(
      (statement) => statement.Action === "secretsmanager:GetSecretValue",
    );
    expect(secret?.Resource).toBe(MONITORING_SECRET_ARN);
    expect(JSON.stringify(secret?.Resource)).not.toContain("*");
  });

  test("publishes the generated preview endpoint and operational resource identifiers", () => {
    const template = synthesize();
    const outputs = template.toJSON().Outputs;

    expect(Object.keys(outputs)).toEqual(
      expect.arrayContaining([
        "BucketName",
        "DistributionId",
        "DistributionDomainName",
        "PreviewUrl",
        "PublisherFunctionName",
        "PublisherDeadLetterQueueUrl",
      ]),
    );
  });

  test("rejects production, other regions, and a cross-account monitoring secret", () => {
    const app = new App();
    expect(
      () =>
        new ReadPathStack(app, "Production", {
          deploymentInputs: {
            ...previewInput(),
            environment: "production",
          } as unknown as ReadPathDeploymentInputs,
          publicAssetPath,
          publisherAssetPath,
          publisher: {
            site: publisherSite(),
            sourceId: "kuma",
          },
        }),
    ).toThrow("supports preview deployments only");

    expect(
      () =>
        new ReadPathStack(new App(), "WrongRegion", {
          deploymentInputs: {
            ...previewInput(),
            aws: { accountId: ACCOUNT_ID, region: "us-east-1" },
          },
          publicAssetPath,
          publisherAssetPath,
          publisher: {
            site: publisherSite(),
            sourceId: "kuma",
          },
        }),
    ).toThrow("must deploy in ap-south-1");

    expect(
      () =>
        new ReadPathStack(new App(), "WrongSecret", {
          deploymentInputs: {
            ...previewInput(),
            monitoringSecretArn:
              "arn:aws:secretsmanager:ap-south-1:999999999999:secret:monitoring-abc123",
          },
          publicAssetPath,
          publisherAssetPath,
          publisher: {
            site: publisherSite(),
            sourceId: "kuma",
          },
        }),
    ).toThrow("deployment account and region");
  });
});

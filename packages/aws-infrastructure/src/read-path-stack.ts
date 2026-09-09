import { fileURLToPath } from "node:url";
import {
  App,
  CfnOutput,
  aws_cloudfront as cloudfront,
  Duration,
  aws_events as events,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_cloudfront_origins as origins,
  RemovalPolicy,
  Stack,
  type StackProps,
  aws_s3 as s3,
  aws_s3_deployment as s3deploy,
  aws_sqs as sqs,
  aws_events_targets as targets,
} from "aws-cdk-lib";
import type { Construct } from "constructs";
import type { DeploymentInputs } from "./inputs";
import { createDeploymentNames } from "./naming";

const DEFAULT_PUBLISHER_ASSET_PATH = fileURLToPath(new URL("../../snapshot/dist", import.meta.url));

export type PublisherComponent = {
  targetUrl: string;
  slug: string;
  name: string;
  group: string;
};

export type ReadPathDeploymentInputs = Pick<
  DeploymentInputs,
  "schemaVersion" | "siteId" | "aws"
> & { environment: "preview" };

export type ReadPathStackProps = Omit<StackProps, "env"> & {
  deploymentInputs: ReadPathDeploymentInputs;
  publicAssetPath: string;
  publisherAssetPath?: string;
  publisher: PublisherComponent;
};

function assertReadPathDeploymentInputs(inputs: ReadPathDeploymentInputs) {
  if (inputs.schemaVersion !== "1.0.0") {
    throw new TypeError("deploymentInputs.schemaVersion must equal 1.0.0");
  }
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(inputs.siteId)) {
    throw new TypeError("deploymentInputs.siteId must be a lowercase DNS-safe identifier");
  }
  if (!/^\d{12}$/.test(inputs.aws.accountId)) {
    throw new TypeError("deploymentInputs.aws.accountId must be a 12-digit AWS account ID");
  }
  if (inputs.environment !== "preview") {
    throw new TypeError("The first read-path stack supports preview deployments only");
  }
  if (inputs.aws.region !== "ap-south-1") {
    throw new TypeError("The first read-path stack must deploy in ap-south-1");
  }
}

function assertPublisherComponent(component: PublisherComponent) {
  let target: URL;
  try {
    target = new URL(component.targetUrl);
  } catch {
    throw new TypeError("publisher.targetUrl must be a valid HTTPS URL");
  }
  if (target.protocol !== "https:") {
    throw new TypeError("publisher.targetUrl must be a valid HTTPS URL");
  }
  for (const [field, value] of Object.entries(component)) {
    if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
      throw new TypeError(`publisher.${field} must be a non-empty trimmed string`);
    }
  }
}

function routeRewriteCode() {
  return cloudfront.FunctionCode.fromInline(`function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (uri === "/") {
    request.uri = "/index.html";
  } else if (uri.endsWith("/")) {
    request.uri = uri + "index.html";
  } else if (!uri.split("/").pop().includes(".")) {
    request.uri = uri + "/index.html";
  }
  return request;
}`);
}

export class ReadPathStack extends Stack {
  readonly bucket: s3.Bucket;
  readonly distribution: cloudfront.Distribution;
  readonly publisherFunction: lambda.Function;
  readonly publisherDeadLetterQueue: sqs.Queue;

  constructor(scope: Construct, id: string, props: ReadPathStackProps) {
    const inputs = props.deploymentInputs;
    assertReadPathDeploymentInputs(inputs);
    assertPublisherComponent(props.publisher);

    const {
      deploymentInputs: _,
      publicAssetPath,
      publisherAssetPath,
      publisher,
      ...stackProps
    } = props;
    super(scope, id, {
      ...stackProps,
      env: { account: inputs.aws.accountId, region: inputs.aws.region },
      stackName: stackProps.stackName ?? createDeploymentNames(inputs).stack,
    });

    const names = createDeploymentNames(inputs);
    this.bucket = new s3.Bucket(this, "PublicBucket", {
      bucketName: names.publicBucket,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
      lifecycleRules: [
        {
          noncurrentVersionExpiration: Duration.days(90),
          abortIncompleteMultipartUploadAfter: Duration.days(1),
        },
      ],
    });

    const rewrite = new cloudfront.Function(this, "StaticRouteRewrite", {
      code: routeRewriteCode(),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      comment: "Resolve extensionless Astro routes without masking missing assets",
    });
    const siteCachePolicy = new cloudfront.CachePolicy(this, "SiteCachePolicy", {
      defaultTtl: Duration.seconds(60),
      minTtl: Duration.seconds(0),
      maxTtl: Duration.days(365),
      enableAcceptEncodingBrotli: true,
      enableAcceptEncodingGzip: true,
    });
    const snapshotCachePolicy = new cloudfront.CachePolicy(this, "SnapshotCachePolicy", {
      defaultTtl: Duration.seconds(30),
      minTtl: Duration.seconds(0),
      maxTtl: Duration.seconds(30),
      enableAcceptEncodingBrotli: true,
      enableAcceptEncodingGzip: true,
    });
    const securityHeaders = new cloudfront.ResponseHeadersPolicy(this, "SecurityHeaders", {
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          contentSecurityPolicy:
            "default-src 'self'; base-uri 'self'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER,
          override: true,
        },
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(365),
          includeSubdomains: true,
          preload: true,
          override: true,
        },
        xssProtection: { protection: true, modeBlock: true, override: true },
      },
    });

    const origin = origins.S3BucketOrigin.withOriginAccessControl(this.bucket);
    this.distribution = new cloudfront.Distribution(this, "Distribution", {
      defaultRootObject: "index.html",
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      defaultBehavior: {
        origin,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
        cachePolicy: siteCachePolicy,
        compress: true,
        responseHeadersPolicy: securityHeaders,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        functionAssociations: [
          {
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
            function: rewrite,
          },
        ],
      },
      additionalBehaviors: {
        "current.json": {
          origin,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
          cachePolicy: snapshotCachePolicy,
          compress: true,
          responseHeadersPolicy: securityHeaders,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        },
      },
    });

    new s3deploy.BucketDeployment(this, "PublicAssets", {
      destinationBucket: this.bucket,
      distribution: this.distribution,
      distributionPaths: ["/*"],
      prune: false,
      sources: [s3deploy.Source.asset(publicAssetPath, { exclude: ["current.json"] })],
    });

    const publisherLogGroup = new logs.LogGroup(this, "PublisherLogs", {
      logGroupName: `/aws/lambda/${names.publisherFunction}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    this.publisherFunction = new lambda.Function(this, "Publisher", {
      functionName: names.publisherFunction,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: "index.handler",
      code: lambda.Code.fromAsset(publisherAssetPath ?? DEFAULT_PUBLISHER_ASSET_PATH),
      logGroup: publisherLogGroup,
      memorySize: 256,
      timeout: Duration.seconds(30),
      environment: {
        STATUS_BUCKET: this.bucket.bucketName,
        TARGET_URL: publisher.targetUrl,
        COMPONENT_SLUG: publisher.slug,
        COMPONENT_NAME: publisher.name,
        COMPONENT_GROUP: publisher.group,
      },
    });
    this.publisherFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject"],
        resources: [this.bucket.arnForObjects("current.json")],
      }),
    );
    this.publisherFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:PutObject"],
        resources: [
          this.bucket.arnForObjects("current.json"),
          this.bucket.arnForObjects("snapshots/*"),
        ],
      }),
    );

    this.publisherDeadLetterQueue = new sqs.Queue(this, "PublisherDeadLetterQueue", {
      queueName: names.snapshotDeadLetterQueue,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });
    new events.Rule(this, "PublisherSchedule", {
      schedule: events.Schedule.rate(Duration.minutes(1)),
      targets: [
        new targets.LambdaFunction(this.publisherFunction, {
          deadLetterQueue: this.publisherDeadLetterQueue,
          maxEventAge: Duration.minutes(5),
          retryAttempts: 2,
        }),
      ],
    });

    new CfnOutput(this, "BucketName", { value: this.bucket.bucketName });
    new CfnOutput(this, "DistributionId", { value: this.distribution.distributionId });
    new CfnOutput(this, "DistributionDomainName", {
      value: this.distribution.distributionDomainName,
    });
    new CfnOutput(this, "PreviewUrl", {
      value: `https://${this.distribution.distributionDomainName}`,
    });
    new CfnOutput(this, "PublisherFunctionName", {
      value: this.publisherFunction.functionName,
    });
    new CfnOutput(this, "PublisherDeadLetterQueueUrl", {
      value: this.publisherDeadLetterQueue.queueUrl,
    });
  }
}

export function createReadPathApp(props: ReadPathStackProps) {
  const app = new App();
  new ReadPathStack(app, "ReadPath", props);
  return app;
}

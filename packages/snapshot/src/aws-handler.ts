import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { type SiteConfig, type StatusSnapshot, validateSiteConfig } from "@uptime-status/domain";
import { publishUptimeKumaSnapshot, type UptimeKumaPublisherConfig } from "./uptime-kuma-publisher";

type RuntimeEnvironment = {
  STATUS_BUCKET?: string;
  MONITORING_SECRET_ARN?: string;
  STATUS_SITE_CONFIG?: string;
  STATUS_SOURCE_ID?: string;
};

type S3Port = Pick<S3Client, "send">;
type SecretsPort = Pick<SecretsManagerClient, "send">;
type HandlerFetcher = (url: string, init: RequestInit) => Promise<Response>;

function required(value: string | undefined, name: string) {
  if (!value) throw new TypeError(`${name} is required`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function parseJson(value: string | undefined, name: string, maxBytes: number) {
  if (!value || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new TypeError(`${name} is missing or too large`);
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new TypeError(`${name} is not valid JSON`);
  }
}

function monitoringConfig(
  secretString: string | undefined,
  environment: RuntimeEnvironment,
): UptimeKumaPublisherConfig {
  if (!secretString || secretString.length > 65_536) {
    throw new TypeError("The monitoring secret is missing or too large");
  }
  const input = parseJson(secretString, "The monitoring secret", 65_536);
  const site = parseJson(environment.STATUS_SITE_CONFIG, "STATUS_SITE_CONFIG", 3_500);
  if (
    !isRecord(input) ||
    !hasOnlyKeys(input, ["schemaVersion", "endpointUrl", "bearerToken"]) ||
    input.schemaVersion !== "1.0.0" ||
    typeof input.endpointUrl !== "string" ||
    typeof input.bearerToken !== "string" ||
    !/^[!-~]{32,2000}$/.test(input.bearerToken) ||
    !validateSiteConfig(site)
  ) {
    throw new TypeError("The monitoring secret has an invalid shape");
  }

  return {
    site: site as SiteConfig,
    sourceId: required(environment.STATUS_SOURCE_ID, "STATUS_SOURCE_ID"),
    endpointUrl: input.endpointUrl,
    authorization: `Bearer ${input.bearerToken}`,
  };
}

function isMissingObject(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return candidate.name === "NoSuchKey" || candidate.$metadata?.httpStatusCode === 404;
}

function isExistingObject(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return candidate.name === "PreconditionFailed" || candidate.$metadata?.httpStatusCode === 412;
}

export function createAwsSnapshotHandler(
  s3: S3Port,
  secrets: SecretsPort,
  environment: RuntimeEnvironment,
  fetcher: HandlerFetcher = (url, init) => globalThis.fetch(url, init),
  now: () => Date = () => new Date(),
) {
  const bucket = required(environment.STATUS_BUCKET, "STATUS_BUCKET");
  const monitoringSecretArn = required(environment.MONITORING_SECRET_ARN, "MONITORING_SECRET_ARN");

  return async function handler() {
    const secret = await secrets.send(new GetSecretValueCommand({ SecretId: monitoringSecretArn }));
    const config = monitoringConfig(secret.SecretString, environment);
    const result = await publishUptimeKumaSnapshot(config, {
      fetch: fetcher,
      now,
      readCurrent: async () => {
        try {
          const response = await s3.send(
            new GetObjectCommand({ Bucket: bucket, Key: "current.json" }),
          );
          const body = await response.Body?.transformToString();
          return body ? JSON.parse(body) : null;
        } catch (error) {
          if (isMissingObject(error)) return null;
          throw error;
        }
      },
      publish: async (snapshot: StatusSnapshot) => {
        const body = `${JSON.stringify(snapshot)}\n`;
        const common = {
          Bucket: bucket,
          Body: body,
          ContentType: "application/json; charset=utf-8",
          ServerSideEncryption: "AES256" as const,
        };
        try {
          await s3.send(
            new PutObjectCommand({
              ...common,
              Key: `snapshots/${snapshot.sourceRevision}.json`,
              CacheControl: "public, max-age=31536000, immutable",
              IfNoneMatch: "*",
            }),
          );
        } catch (error) {
          if (!isExistingObject(error)) throw error;
        }
        await s3.send(
          new PutObjectCommand({
            ...common,
            Key: "current.json",
            CacheControl: "no-cache, no-store, must-revalidate",
          }),
        );
      },
    });

    console.log(JSON.stringify({ kind: result.kind, revision: result.snapshot.sourceRevision }));
    return result;
  };
}

const runtimeS3 = new S3Client({});
const runtimeSecrets = new SecretsManagerClient({});

export async function handler() {
  return createAwsSnapshotHandler(runtimeS3, runtimeSecrets, process.env as RuntimeEnvironment)();
}

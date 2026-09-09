import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { StatusSnapshot } from "@uptime-status/domain";
import { publishProbeSnapshot } from "./publisher";

type RuntimeEnvironment = {
  STATUS_BUCKET?: string;
  TARGET_URL?: string;
  COMPONENT_SLUG?: string;
  COMPONENT_NAME?: string;
  COMPONENT_GROUP?: string;
};

type S3Port = Pick<S3Client, "send">;
type HandlerFetcher = (url: string, init: RequestInit) => Promise<Response>;

function required(value: string | undefined, name: string) {
  if (!value) throw new TypeError(`${name} is required`);
  return value;
}

function isMissingObject(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return candidate.name === "NoSuchKey" || candidate.$metadata?.httpStatusCode === 404;
}

export function createAwsSnapshotHandler(
  s3: S3Port,
  environment: RuntimeEnvironment,
  fetcher: HandlerFetcher = (url, init) => globalThis.fetch(url, init),
) {
  const bucket = required(environment.STATUS_BUCKET, "STATUS_BUCKET");
  const component = {
    slug: required(environment.COMPONENT_SLUG, "COMPONENT_SLUG"),
    name: required(environment.COMPONENT_NAME, "COMPONENT_NAME"),
    group: required(environment.COMPONENT_GROUP, "COMPONENT_GROUP"),
    url: required(environment.TARGET_URL, "TARGET_URL"),
  };

  return async function handler() {
    const result = await publishProbeSnapshot(component, {
      fetch: fetcher,
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
        await s3.send(
          new PutObjectCommand({
            ...common,
            Key: `snapshots/${snapshot.sourceRevision}.json`,
            CacheControl: "public, max-age=31536000, immutable",
          }),
        );
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

export async function handler() {
  return createAwsSnapshotHandler(runtimeS3, process.env as RuntimeEnvironment)();
}

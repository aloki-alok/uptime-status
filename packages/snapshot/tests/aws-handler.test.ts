import { describe, expect, test } from "bun:test";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { createAwsSnapshotHandler } from "../src/aws-handler";

describe("AWS snapshot handler", () => {
  test("writes an immutable snapshot before replacing current.json", async () => {
    const commands: unknown[] = [];
    const s3 = {
      send: async (command: unknown) => {
        commands.push(command);
        if (command instanceof GetObjectCommand) {
          const error = Object.assign(new Error("missing"), { name: "NoSuchKey" });
          throw error;
        }
        return {};
      },
    };
    const handler = createAwsSnapshotHandler(
      s3 as never,
      {
        STATUS_BUCKET: "status-bucket",
        TARGET_URL: "https://example.test/health",
        COMPONENT_SLUG: "website",
        COMPONENT_NAME: "Website",
        COMPONENT_GROUP: "Web",
      },
      async () => new Response(null, { status: 204 }),
    );
    const result = await handler();

    expect(result.kind).toBe("published");
    const writes = commands.filter((command) => command instanceof PutObjectCommand);
    expect(writes).toHaveLength(2);
    expect((writes[0] as PutObjectCommand).input.Key).toStartWith("snapshots/probe-");
    expect((writes[1] as PutObjectCommand).input).toMatchObject({
      Bucket: "status-bucket",
      Key: "current.json",
      CacheControl: "no-cache, no-store, must-revalidate",
      ServerSideEncryption: "AES256",
    });
  });

  test("fails before touching S3 when required runtime configuration is missing", () => {
    expect(() => createAwsSnapshotHandler({ send: async () => ({}) } as never, {})).toThrow(
      "STATUS_BUCKET is required",
    );
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyHistoryArtifact } from "../src";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function artifact(contents = "offline database fixture") {
  const directory = await mkdtemp(join(tmpdir(), "uptime-status-history-"));
  directories.push(directory);
  const path = join(directory, "kuma-backup.sqlite");
  await writeFile(path, contents);
  return {
    kind: "sqlite-backup",
    path,
    sha256: createHash("sha256").update(contents).digest("hex"),
    cutoffAt: "2026-09-09T10:00:00Z",
    exportedAt: "2026-09-09T10:05:00Z",
    sourceTimeZone: "UTC",
  };
}

describe("offline history artifact verification", () => {
  test("hashes a regular file through a read-only handle and records its identity", async () => {
    const verified = await verifyHistoryArtifact(await artifact());
    expect(verified.size).toBeGreaterThan(0);
    expect(verified.device).not.toBe("");
    expect(verified.inode).not.toBe("");
    expect(verified.path).toEndWith("/kuma-backup.sqlite");
  });

  test("rejects an artifact when the recorded digest does not match", async () => {
    const input = await artifact();
    await expect(verifyHistoryArtifact({ ...input, sha256: "a".repeat(64) })).rejects.toThrow(
      "SHA-256 does not match",
    );
  });
});

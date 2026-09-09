import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import type { HistoryArtifact } from "./request";

export type VerifiedHistoryArtifact = HistoryArtifact & {
  path: string;
  size: number;
  device: string;
  inode: string;
  modifiedAtNanoseconds: string;
};

const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;

export async function verifyHistoryArtifact(
  artifact: HistoryArtifact,
): Promise<VerifiedHistoryArtifact> {
  const canonicalPath = await realpath(artifact.path);
  const handle = await open(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile()) throw new Error("History artifact must be a regular file");
    if (stat.size < 1 || stat.size > BigInt(MAX_ARTIFACT_BYTES)) {
      throw new Error("History artifact size is outside the supported range");
    }

    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (BigInt(position) < stat.size) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    if (BigInt(position) !== stat.size) throw new Error("History artifact changed while hashing");
    const sha256 = digest.digest("hex");
    if (sha256 !== artifact.sha256) throw new Error("History artifact SHA-256 does not match");

    return {
      ...artifact,
      path: canonicalPath,
      sha256,
      size: Number(stat.size),
      device: String(stat.dev),
      inode: String(stat.ino),
      modifiedAtNanoseconds: String(stat.mtimeNs),
    };
  } finally {
    await handle.close();
  }
}

export function sameVerifiedArtifact(
  first: VerifiedHistoryArtifact,
  second: VerifiedHistoryArtifact,
) {
  return (
    first.path === second.path &&
    first.sha256 === second.sha256 &&
    first.size === second.size &&
    first.device === second.device &&
    first.inode === second.inode &&
    first.modifiedAtNanoseconds === second.modifiedAtNanoseconds
  );
}

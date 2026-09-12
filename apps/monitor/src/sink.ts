// Where a published snapshot ends up (disk, S3, KV, ...) is undecided, so the engine
// depends on this seam instead of a hardcoded filesystem call.
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type PublishSink = {
  publish(name: string, body: string): Promise<void>;
};

/** Writes to a .tmp file then renames, so a reader never sees a half-written file. */
export function createFilesystemSink(dir: string): PublishSink {
  return {
    async publish(name, body) {
      await mkdir(dir, { recursive: true });
      const target = join(dir, name);
      const tmp = `${target}.tmp`;
      await writeFile(tmp, body, "utf8");
      await rename(tmp, target);
    },
  };
}

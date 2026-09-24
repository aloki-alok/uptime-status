// Where a published snapshot ends up (disk, S3, KV, ...) is undecided, so the engine
// depends on this seam instead of a hardcoded filesystem call.
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type PublishSink = {
  publish(name: string, body: string): Promise<void>;
};

export type CloudflareKvSinkOptions = {
  accountId: string;
  namespaceId: string;
  apiToken: string;
  siteId: string;
  fetchImpl?: typeof fetch;
};

function kvUrl(accountId: string, namespaceId: string, key: string) {
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`;
}

/** Publishes an immutable revision first, then advances the public current pointer. */
export function createCloudflareKvSink(options: CloudflareKvSinkOptions): PublishSink {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  return {
    async publish(name, body) {
      if (name !== "current.json") throw new Error(`Unsupported Cloudflare KV object: ${name}`);
      const parsed = JSON.parse(body) as { sourceRevision?: unknown };
      if (typeof parsed.sourceRevision !== "string" || !parsed.sourceRevision) {
        throw new Error("Snapshot sourceRevision is required for Cloudflare KV publication");
      }
      const prefix = `sites/${options.siteId}`;
      const headers = {
        authorization: `Bearer ${options.apiToken}`,
        "content-type": "application/json",
      };
      for (const key of [
        `${prefix}/snapshots/${parsed.sourceRevision}.json`,
        `${prefix}/current.json`,
      ]) {
        const response = await fetchImpl(kvUrl(options.accountId, options.namespaceId, key), {
          method: "PUT",
          headers,
          body,
        });
        if (!response.ok) {
          const detail = (await response.text()).slice(0, 500);
          throw new Error(`Cloudflare KV publish failed for ${key}: ${response.status} ${detail}`);
        }
      }
    },
  };
}

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

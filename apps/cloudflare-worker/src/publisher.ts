import { publishProbeSnapshot } from "@uptime-status/snapshot/publisher";

const SNAPSHOT_RETENTION_SECONDS = 90 * 24 * 60 * 60;

export function currentKey(siteId: string) {
  return `sites/${siteId}/current.json`;
}

export async function runPublisher(env: Env, fetcher: typeof globalThis.fetch = globalThis.fetch) {
  const current = currentKey(env.SITE_ID);
  return publishProbeSnapshot(
    {
      slug: env.COMPONENT_SLUG,
      name: env.COMPONENT_NAME,
      group: env.COMPONENT_GROUP,
      url: env.TARGET_URL,
      showLatency: env.SHOW_LATENCY === "true",
    },
    {
      readCurrent: () => env.STATUS.get(current, "json"),
      publish: async (snapshot) => {
        const body = `${JSON.stringify(snapshot)}\n`;
        await env.STATUS.put(
          `sites/${env.SITE_ID}/snapshots/${snapshot.sourceRevision}.json`,
          body,
          {
            expirationTtl: SNAPSHOT_RETENTION_SECONDS,
          },
        );
        await env.STATUS.put(current, body);
      },
      fetch: fetcher,
    },
  );
}

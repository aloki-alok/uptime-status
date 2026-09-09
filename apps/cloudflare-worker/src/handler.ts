import { validateStatusSnapshot } from "@uptime-status/domain/snapshot";
import { currentKey, runPublisher } from "./publisher";

const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'; upgrade-insecure-requests",
  "cross-origin-opener-policy": "same-origin",
  "permissions-policy": "camera=(), geolocation=(), microphone=()",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=31536000",
  "x-content-type-options": "nosniff",
};

function secured(response: Response) {
  const securedResponse = new Response(response.body, response);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    securedResponse.headers.set(name, value);
  }
  return securedResponse;
}

function refreshDue(snapshot: { latestCheckAt: string }, pollIntervalSeconds: string) {
  const intervalMs = Number.parseInt(pollIntervalSeconds, 10) * 1000;
  return Date.now() - Date.parse(snapshot.latestCheckAt) >= intervalMs;
}

export function createWorker(fetcher: typeof globalThis.fetch = globalThis.fetch) {
  return {
    async fetch(request, env): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname !== "/current.json") return secured(await env.ASSETS.fetch(request));

      let snapshot = await env.STATUS.get(currentKey(env.SITE_ID), "json");
      if (!validateStatusSnapshot(snapshot)) {
        return secured(
          Response.json(
            { error: "status-initializing" },
            { status: 503, headers: { "cache-control": "no-store" } },
          ),
        );
      }
      if (refreshDue(snapshot, env.POLL_INTERVAL_SECONDS)) {
        snapshot = (await runPublisher(env, fetcher)).snapshot;
      }
      return secured(
        new Response(`${JSON.stringify(snapshot)}\n`, {
          headers: {
            "cache-control": "no-cache, no-store, must-revalidate",
            "content-type": "application/json; charset=utf-8",
          },
        }),
      );
    },

    async scheduled(_controller, env): Promise<void> {
      const result = await runPublisher(env, fetcher);
      console.log(JSON.stringify({ kind: result.kind, revision: result.snapshot.sourceRevision }));
    },
  } satisfies ExportedHandler<Env>;
}

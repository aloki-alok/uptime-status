import { validateStatusSnapshot } from "@uptime-status/domain/snapshot";
import { currentKey, runPublisher } from "./publisher";
import {
  handleResendWebhook,
  handleSubscriptionApi,
  hasSubscriptionRuntime,
  processSubscriptionQueue,
  repairSubscriptionOutbox,
  type SubscriptionRuntimeEnv,
} from "./subscriptions/runtime";

const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self' https://static.cloudflareinsights.com; style-src 'self'; upgrade-insecure-requests",
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
    async fetch(request, env, context): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname === "/runtime/site-config.json") {
        return secured(new Response("Not found", { status: 404 }));
      }
      if (url.pathname === "/current.json") {
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
      }
      const runtimeConfigured = hasSubscriptionRuntime(env as unknown as Record<string, unknown>);
      if (url.pathname === "/api/v1/webhooks/resend") {
        if (!runtimeConfigured) {
          return secured(new Response("Subscriptions unavailable", { status: 503 }));
        }
        try {
          return secured(
            await handleResendWebhook(request, env as unknown as SubscriptionRuntimeEnv),
          );
        } catch {
          console.error(JSON.stringify({ kind: "subscription-webhook-failed" }));
          return secured(new Response("Webhook unavailable", { status: 503 }));
        }
      }
      if (url.pathname.startsWith("/api/v1/subscriptions")) {
        if (!runtimeConfigured) {
          return secured(
            Response.json(
              {
                error: {
                  code: "subscriptions_unavailable",
                  message: "Subscriptions are temporarily unavailable",
                  requestId: crypto.randomUUID(),
                },
              },
              { status: 503, headers: { "cache-control": "no-store" } },
            ),
          );
        }
        try {
          return secured(
            await handleSubscriptionApi(
              request,
              env as unknown as SubscriptionRuntimeEnv,
              (promise) => context.waitUntil(promise),
            ),
          );
        } catch {
          console.error(JSON.stringify({ kind: "subscription-api-failed" }));
          return secured(
            Response.json(
              {
                error: {
                  code: "subscriptions_unavailable",
                  message: "Subscriptions are temporarily unavailable",
                  requestId: crypto.randomUUID(),
                },
              },
              { status: 503, headers: { "cache-control": "no-store" } },
            ),
          );
        }
      }
      return secured(await env.ASSETS.fetch(request));
    },

    async scheduled(_controller, env): Promise<void> {
      const result = await runPublisher(env, fetcher);
      console.log(JSON.stringify({ kind: result.kind, revision: result.snapshot.sourceRevision }));
      if (hasSubscriptionRuntime(env as unknown as Record<string, unknown>)) {
        try {
          await repairSubscriptionOutbox(env as unknown as SubscriptionRuntimeEnv);
        } catch {
          console.error(JSON.stringify({ kind: "subscription-outbox-repair-failed" }));
        }
      }
    },

    async queue(batch, env): Promise<void> {
      if (!hasSubscriptionRuntime(env as unknown as Record<string, unknown>)) {
        batch.retryAll({ delaySeconds: 300 });
        return;
      }
      await processSubscriptionQueue(
        batch as MessageBatch<import("./subscriptions/d1-repository").SubscriptionQueueMessage>,
        env as unknown as SubscriptionRuntimeEnv,
      );
    },
  } satisfies ExportedHandler<Env>;
}

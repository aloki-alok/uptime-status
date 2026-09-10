import { SubscriptionService } from "@uptime-status/api/subscriptions/service";
import { emailKey, parseConfirmationToken } from "@uptime-status/api/subscriptions/tokens";
import { type SiteConfig, validateSiteConfig } from "@uptime-status/domain/site";
import { renderStatusMail } from "@uptime-status/email";
import {
  cloudflareDatabase,
  D1SubscriptionRepository,
  type SubscriptionQueueMessage,
} from "./d1-repository";
import { ConfirmationOutboxCipher, importOutboxEncryptionKey } from "./outbox-crypto";
import { createResendTransport, MailTransportError } from "./resend-transport";
import { verifyResendSuppressionWebhook } from "./resend-webhook";

export type SubscriptionRuntimeEnv = {
  ASSETS: Fetcher;
  SUBSCRIPTIONS_DATABASE: D1Database;
  SUBSCRIPTION_CONFIRMATIONS: Queue<SubscriptionQueueMessage>;
  SUBSCRIPTION_ACCEPTANCE_ENABLED: string;
  LOOKUP_PEPPER: string;
  CONFIRMATION_PEPPER: string;
  UNSUBSCRIBE_PEPPER: string;
  RATE_LIMIT_PEPPER: string;
  OUTBOX_ENCRYPTION_KEY: string;
  RESEND_API_KEY: string;
  RESEND_WEBHOOK_SECRET: string;
};

type Runtime = {
  site: SiteConfig & { subscriptions: Extract<SiteConfig["subscriptions"], { enabled: true }> };
  publicBaseUrl: string;
  acceptanceEnabled: boolean;
  repository: D1SubscriptionRepository;
  service: SubscriptionService;
  rateLimitPepper: string;
  resendApiKey: string;
  resendWebhookSecret: string;
};

function required(value: unknown, name: string) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Subscription runtime is missing ${name}`);
  }
  return value;
}

function decodeBase64urlKey(value: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new Error("OUTBOX_ENCRYPTION_KEY must be a base64url-encoded 32-byte key");
  }
  const encoded = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(`${encoded}=`);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function parseSite(value: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("SITE_CONFIG_JSON must contain valid JSON");
  }
  if (!validateSiteConfig(parsed) || !parsed.subscriptions.enabled) {
    throw new Error("SITE_CONFIG_JSON must enable a valid subscription configuration");
  }
  if (parsed.subscriptions.delivery.provider !== "resend") {
    throw new Error("The Cloudflare subscription runtime currently requires Resend");
  }
  return parsed as Runtime["site"];
}

async function loadSite(fetcher: Fetcher) {
  const response = await fetcher.fetch(
    new Request("https://status-runtime.invalid/runtime/site-config.json"),
  );
  if (!response.ok) throw new Error("The built site configuration is unavailable");
  const content = await response.text();
  if (new TextEncoder().encode(content).byteLength > 64 * 1024) {
    throw new Error("The built site configuration is too large");
  }
  return parseSite(content);
}

export function hasSubscriptionRuntime(env: Record<string, unknown>) {
  return Boolean(env.SUBSCRIPTIONS_DATABASE && env.SUBSCRIPTION_CONFIRMATIONS && env.ASSETS);
}

export async function buildSubscriptionRuntime(env: SubscriptionRuntimeEnv): Promise<Runtime> {
  const site = await loadSite(env.ASSETS);
  const publicBaseUrl = `https://${site.domains.primary}`;
  const delivery = site.subscriptions.delivery;
  if (delivery.provider !== "resend") {
    throw new Error("The Cloudflare subscription runtime currently requires Resend");
  }
  const resendApiKey = required(
    (env as unknown as Record<string, unknown>)[delivery.connection.reference],
    delivery.connection.reference,
  );
  const cipher = new ConfirmationOutboxCipher({
    version: 1,
    key: await importOutboxEncryptionKey(
      decodeBase64urlKey(required(env.OUTBOX_ENCRYPTION_KEY, "OUTBOX_ENCRYPTION_KEY")),
    ),
  });
  const repository = new D1SubscriptionRepository(
    cloudflareDatabase(env.SUBSCRIPTIONS_DATABASE),
    cipher,
  );
  const lookupPepper = required(env.LOOKUP_PEPPER, "LOOKUP_PEPPER");
  const confirmationPepper = required(env.CONFIRMATION_PEPPER, "CONFIRMATION_PEPPER");
  const unsubscribePepper = required(env.UNSUBSCRIBE_PEPPER, "UNSUBSCRIBE_PEPPER");
  return {
    site,
    publicBaseUrl,
    acceptanceEnabled: env.SUBSCRIPTION_ACCEPTANCE_ENABLED === "true",
    repository,
    service: new SubscriptionService(repository, {
      siteId: site.siteId,
      lookupPepper,
      confirmationPepper,
      unsubscribePepper,
      confirmationTtlSeconds: site.subscriptions.confirmationTtlSeconds,
      resendCooldownSeconds: site.subscriptions.resendCooldownSeconds,
    }),
    rateLimitPepper: required(env.RATE_LIMIT_PEPPER, "RATE_LIMIT_PEPPER"),
    resendApiKey,
    resendWebhookSecret: required(env.RESEND_WEBHOOK_SECRET, "RESEND_WEBHOOK_SECRET"),
  };
}

function rateLimitAddress(request: Request) {
  const address = request.headers.get("cf-connecting-ip") ?? "unknown";
  return address.length <= 64 ? address : "invalid";
}

const CONFIRMATION_COOKIE = "uptime_status_confirmation";
const UNSUBSCRIBE_COOKIE = "uptime_status_unsubscribe";

function apiError(status: number, code: string, message: string) {
  return Response.json(
    { error: { code, message, requestId: crypto.randomUUID() } },
    { status, headers: { "cache-control": "no-store" } },
  );
}

function redirect(location: string, cookie?: string) {
  const headers: Record<string, string> = {
    location,
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  };
  if (cookie) headers["set-cookie"] = cookie;
  return new Response(null, { status: 303, headers });
}

function lifecycleCookie(name: string, token: string, maxAge: number, endpoint: string) {
  return `${name}=${encodeURIComponent(token)}; Max-Age=${maxAge}; Path=${endpoint}; HttpOnly; Secure; SameSite=Strict`;
}

function readCookie(request: Request, name: string) {
  for (const candidate of request.headers.get("cookie")?.split(";") ?? []) {
    const [key, ...value] = candidate.split("=");
    if (key?.trim() !== name) continue;
    try {
      return decodeURIComponent(value.join("=").trim());
    } catch {
      return null;
    }
  }
  return null;
}

async function boundedBody(request: Request, maximum: number) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) return null;
  const body = await request.arrayBuffer();
  return body.byteLength <= maximum ? body : null;
}

async function formFields(request: Request) {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim();
  if (
    contentType !== "application/x-www-form-urlencoded" &&
    contentType !== "multipart/form-data"
  ) {
    return null;
  }
  const body = await boundedBody(request, 2048);
  if (!body) return null;
  const copy = new Request(request.url, {
    method: "POST",
    headers: request.headers,
    body,
  });
  return copy.formData();
}

export async function handleSubscriptionApi(
  request: Request,
  env: SubscriptionRuntimeEnv,
  waitUntil: (promise: Promise<unknown>) => void,
) {
  const runtime = await buildSubscriptionRuntime(env);
  const url = new URL(request.url);
  const confirmationPath = "/api/v1/subscriptions/confirm";
  const unsubscribePath = "/api/v1/subscriptions/unsubscribe";

  if (url.pathname === "/api/v1/subscriptions" && request.method === "POST") {
    if (!runtime.acceptanceEnabled) {
      return apiError(
        503,
        "subscriptions_unavailable",
        "Subscriptions are temporarily unavailable",
      );
    }
    if (request.headers.get("content-type")?.split(";", 1)[0].trim() !== "application/json") {
      return apiError(415, "invalid_request", "Content-Type must be application/json");
    }
    const raw = await boundedBody(request, 1024);
    if (!raw) return apiError(413, "invalid_request", "Request body is too large");
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return apiError(422, "invalid_request", "Enter a valid email address");
    }
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      typeof (body as Record<string, unknown>).email !== "string"
    ) {
      return apiError(422, "invalid_request", "Enter a valid email address");
    }
    const bucketKey = await emailKey(
      runtime.site.siteId,
      `ip:${rateLimitAddress(request)}`,
      runtime.rateLimitPepper,
    );
    const allowed = await runtime.repository.consumeRateLimit({
      siteId: runtime.site.siteId,
      bucketKey,
      nowEpochSeconds: Math.floor(Date.now() / 1000),
      windowSeconds: 10 * 60,
      limit: 5,
    });
    if (!allowed) return apiError(429, "rate_limited", "Too many requests. Try again later");
    try {
      const response = Response.json(
        await runtime.service.requestSubscription((body as Record<string, unknown>).email),
        { status: 202, headers: { "cache-control": "no-store" } },
      );
      waitUntil(
        runtime.repository.enqueuePending(
          runtime.site.siteId,
          env.SUBSCRIPTION_CONFIRMATIONS,
          new Date().toISOString(),
        ),
      );
      return response;
    } catch (error) {
      if (error instanceof Error && error.message === "Invalid email address") {
        return apiError(422, "invalid_request", "Enter a valid email address");
      }
      return apiError(500, "internal_error", "The request could not be completed");
    }
  }

  if (url.pathname === confirmationPath && request.method === "GET") {
    const token = url.searchParams.get("token");
    if (!token || !parseConfirmationToken(token)) return redirect("/subscriptions/invalid/");
    return redirect(
      "/subscriptions/confirm/",
      lifecycleCookie(CONFIRMATION_COOKIE, token, 600, confirmationPath),
    );
  }
  if (url.pathname === confirmationPath && request.method === "POST") {
    const fields = await formFields(request);
    const token =
      fields?.get("intent") === "confirm" ? readCookie(request, CONFIRMATION_COOKIE) : null;
    const cleared = lifecycleCookie(CONFIRMATION_COOKIE, "", 0, confirmationPath);
    if (!token) return redirect("/subscriptions/invalid/", cleared);
    const outcome = await runtime.service.confirm(token);
    return redirect(`/subscriptions/${outcome}/`, cleared);
  }

  if (url.pathname === unsubscribePath && request.method === "GET") {
    const token = url.searchParams.get("token");
    if (!token || !parseConfirmationToken(token)) {
      return redirect("/subscriptions/unsubscribe-invalid/");
    }
    return redirect(
      "/subscriptions/unsubscribe/",
      lifecycleCookie(UNSUBSCRIBE_COOKIE, token, 600, unsubscribePath),
    );
  }
  if (url.pathname === unsubscribePath && request.method === "POST") {
    const fields = await formFields(request);
    const machine = request.headers.get("list-unsubscribe-post") === "List-Unsubscribe=One-Click";
    const token = machine
      ? fields?.get("List-Unsubscribe") === "One-Click"
        ? url.searchParams.get("token")
        : null
      : fields?.get("intent") === "unsubscribe"
        ? readCookie(request, UNSUBSCRIBE_COOKIE)
        : null;
    const outcome = token ? await runtime.service.unsubscribe(token) : "invalid";
    if (machine)
      return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    return redirect(
      outcome === "unsubscribed"
        ? "/subscriptions/unsubscribed/"
        : "/subscriptions/unsubscribe-invalid/",
      lifecycleCookie(UNSUBSCRIBE_COOKIE, "", 0, unsubscribePath),
    );
  }

  return apiError(404, "invalid_request", "Not found");
}

function attachmentUrl(path: string, runtime: Runtime) {
  const templates = runtime.site.subscriptions.templates;
  const name =
    path === templates?.logoPath
      ? "mail-logo"
      : path === templates?.headerMedia?.path
        ? "mail-header"
        : null;
  const extension = path.match(/\.[A-Za-z0-9]+$/)?.[0];
  if (!name || !extension) throw new Error("Mail attachment is not a published site asset");
  return `${runtime.publicBaseUrl}/site-assets/${name}${extension.toLowerCase()}`;
}

export async function processSubscriptionQueue(
  batch: MessageBatch<SubscriptionQueueMessage>,
  env: SubscriptionRuntimeEnv,
  fetcher: typeof globalThis.fetch = globalThis.fetch,
) {
  const runtime = await buildSubscriptionRuntime(env);
  const transport = createResendTransport({
    apiKey: runtime.resendApiKey,
    fetch: fetcher,
    resolveAttachmentPath: (path) => attachmentUrl(path, runtime),
  });
  for (const message of batch.messages) {
    try {
      const claimed = await runtime.repository.claim(
        message.body,
        message.id,
        new Date().toISOString(),
      );
      if (!claimed) {
        message.ack();
        continue;
      }
      const expiresAt = new Date(
        Date.parse(claimed.createdAt) + runtime.site.subscriptions.confirmationTtlSeconds * 1000,
      ).toISOString();
      const mail = renderStatusMail({
        site: runtime.site,
        recipient: claimed.normalizedEmail,
        publicBaseUrl: runtime.publicBaseUrl,
        event: {
          kind: "confirmation",
          eventId: `${claimed.emailKey}:${claimed.tokenVersion}`,
          token: claimed.token,
          expiresAt,
        },
      });
      const receipt = await transport.send(mail);
      if (
        !(await runtime.repository.markSent(
          claimed.outboxId,
          claimed.claimId,
          receipt.providerMessageId,
          new Date().toISOString(),
        ))
      ) {
        throw new Error("Sent confirmation could not be committed");
      }
      message.ack();
    } catch (error) {
      if (error instanceof MailTransportError && !error.retryable) {
        await runtime.repository.markFailed(
          message.body.outboxId,
          message.id,
          "provider_rejected",
          new Date().toISOString(),
        );
        message.ack();
        console.error(
          JSON.stringify({ kind: "subscription-confirmation-failed", retryable: false }),
        );
      } else {
        message.retry({ delaySeconds: 60 });
        console.error(
          JSON.stringify({ kind: "subscription-confirmation-failed", retryable: true }),
        );
      }
    }
  }
}

export async function repairSubscriptionOutbox(env: SubscriptionRuntimeEnv) {
  const runtime = await buildSubscriptionRuntime(env);
  return runtime.repository.enqueuePending(
    runtime.site.siteId,
    env.SUBSCRIPTION_CONFIRMATIONS,
    new Date().toISOString(),
  );
}

export async function handleResendWebhook(request: Request, env: SubscriptionRuntimeEnv) {
  const runtime = await buildSubscriptionRuntime(env);
  const event = await verifyResendSuppressionWebhook(request, runtime.resendWebhookSecret);
  if (!event) return new Response("Invalid webhook", { status: 400 });
  await runtime.repository.recordSuppression({ ...event, receivedAt: new Date().toISOString() });
  return new Response(null, { status: 200 });
}

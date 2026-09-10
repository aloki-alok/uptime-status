import { Elysia } from "elysia";
import type { SubscriptionService } from "./subscriptions/service";
import { parseConfirmationToken } from "./subscriptions/tokens";

const UNSUBSCRIBE_COOKIE = "uptime_status_unsubscribe";
const UNSUBSCRIBE_PATH = "/api/v1/subscriptions/unsubscribe";
const CONFIRMATION_COOKIE = "uptime_status_confirmation";
const CONFIRMATION_PATH = "/api/v1/subscriptions/confirm";
const encoder = new TextEncoder();

type AppDependencies = {
  subscriptions?: {
    acceptanceEnabled: boolean;
    allowRequest?: (request: Request) => Promise<boolean>;
    service: SubscriptionService;
  };
  requestId?: () => string;
};

function apiError(status: number, code: string, message: string, requestId: string) {
  return Response.json(
    { error: { code, message, requestId } },
    {
      status,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
        "x-content-type-options": "nosniff",
      },
    },
  );
}

function redirect(location: string, headers: Record<string, string> = {}) {
  return new Response(null, {
    status: 303,
    headers: {
      location,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}

function readCookie(request: Request, name: string) {
  const cookies = request.headers.get("cookie")?.split(";") ?? [];
  for (const cookie of cookies) {
    const separator = cookie.indexOf("=");
    if (separator < 0 || cookie.slice(0, separator).trim() !== name) continue;
    const encodedValue = cookie.slice(separator + 1).trim();
    if (encodedValue.length > 1024) return null;
    try {
      return decodeURIComponent(encodedValue);
    } catch {
      return null;
    }
  }
  return null;
}

function unsubscribeCookie(token: string, maxAge: number) {
  return `${UNSUBSCRIBE_COOKIE}=${encodeURIComponent(token)}; Max-Age=${maxAge}; Path=${UNSUBSCRIBE_PATH}; HttpOnly; Secure; SameSite=Strict`;
}

function confirmationCookie(token: string, maxAge: number) {
  return `${CONFIRMATION_COOKIE}=${encodeURIComponent(token)}; Max-Age=${maxAge}; Path=${CONFIRMATION_PATH}; HttpOnly; Secure; SameSite=Strict`;
}

export function createApp(dependencies: AppDependencies = {}) {
  const requestId = dependencies.requestId ?? (() => crypto.randomUUID());
  return new Elysia({ name: "uptime-status-api" })
    .get("/healthz", () => ({ status: "ok" as const }))
    .get("/readyz", () => ({ status: "ready" as const }))
    .post("/api/v1/subscriptions", async ({ body, request }) => {
      const id = requestId();
      const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim();
      if (contentType !== "application/json") {
        return apiError(415, "invalid_request", "Content-Type must be application/json", id);
      }
      const contentLength = Number(request.headers.get("content-length"));
      const bodyBytes = encoder.encode(JSON.stringify(body ?? null)).byteLength;
      if ((Number.isFinite(contentLength) && contentLength > 1024) || bodyBytes > 1024) {
        return apiError(413, "invalid_request", "Request body is too large", id);
      }
      if (!dependencies.subscriptions?.acceptanceEnabled) {
        return apiError(
          503,
          "subscriptions_unavailable",
          "Subscriptions are temporarily unavailable",
          id,
        );
      }
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).length !== 1 ||
        !("email" in body)
      ) {
        return apiError(422, "invalid_request", "Enter a valid email address", id);
      }
      try {
        if (
          dependencies.subscriptions.allowRequest &&
          !(await dependencies.subscriptions.allowRequest(request))
        ) {
          return apiError(429, "rate_limited", "Too many requests. Try again later", id);
        }
        const accepted = await dependencies.subscriptions.service.requestSubscription(body.email);
        return Response.json(accepted, {
          status: 202,
          headers: {
            "cache-control": "no-store",
            "content-type": "application/json; charset=utf-8",
            "x-content-type-options": "nosniff",
          },
        });
      } catch (error) {
        if (error instanceof Error && error.message === "Invalid email address") {
          return apiError(422, "invalid_request", "Enter a valid email address", id);
        }
        return apiError(500, "internal_error", "The request could not be completed", id);
      }
    })
    .get(CONFIRMATION_PATH, ({ query }) => {
      if (
        !dependencies.subscriptions ||
        typeof query.token !== "string" ||
        !parseConfirmationToken(query.token)
      ) {
        return redirect("/subscriptions/invalid/");
      }
      return redirect("/subscriptions/confirm/", {
        "set-cookie": confirmationCookie(query.token, 600),
      });
    })
    .post(CONFIRMATION_PATH, async ({ body, request }) => {
      const invalid = () =>
        redirect("/subscriptions/invalid/", {
          "set-cookie": confirmationCookie("", 0),
        });
      if (!dependencies.subscriptions) return invalid();

      const contentLength = Number(request.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > 2048) return invalid();
      const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim();
      if (
        contentType !== "application/x-www-form-urlencoded" &&
        contentType !== "multipart/form-data"
      ) {
        return invalid();
      }
      const fields = body && typeof body === "object" && !Array.isArray(body) ? body : {};
      const token =
        queryValue(fields, "intent") === "confirm"
          ? readCookie(request, CONFIRMATION_COOKIE)
          : null;
      if (!token) return invalid();

      try {
        const outcome = await dependencies.subscriptions.service.confirm(token);
        return redirect(`/subscriptions/${outcome}/`, {
          "set-cookie": confirmationCookie("", 0),
        });
      } catch {
        return invalid();
      }
    })
    .get(UNSUBSCRIBE_PATH, ({ query }) => {
      if (
        !dependencies.subscriptions ||
        typeof query.token !== "string" ||
        !parseConfirmationToken(query.token)
      ) {
        return redirect("/subscriptions/unsubscribe-invalid/");
      }
      return redirect("/subscriptions/unsubscribe/", {
        "set-cookie": unsubscribeCookie(query.token, 600),
      });
    })
    .post(UNSUBSCRIBE_PATH, async ({ body, request }) => {
      const machineRequest =
        request.headers.get("list-unsubscribe-post") === "List-Unsubscribe=One-Click";
      const unavailable = () => {
        if (machineRequest) {
          return apiError(
            503,
            "subscriptions_unavailable",
            "Subscriptions are temporarily unavailable",
            requestId(),
          );
        }
        return redirect("/subscriptions/unsubscribe-invalid/", {
          "set-cookie": unsubscribeCookie("", 0),
        });
      };
      if (!dependencies.subscriptions) return unavailable();

      const contentLength = Number(request.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > 2048) {
        if (machineRequest) {
          return apiError(413, "invalid_request", "Request body is too large", requestId());
        }
        return redirect("/subscriptions/unsubscribe-invalid/");
      }
      const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim();
      if (
        contentType !== "application/x-www-form-urlencoded" &&
        contentType !== "multipart/form-data"
      ) {
        if (machineRequest) {
          return apiError(415, "invalid_request", "Content-Type must be form encoded", requestId());
        }
        return redirect("/subscriptions/unsubscribe-invalid/");
      }

      const fields = body && typeof body === "object" && !Array.isArray(body) ? body : {};
      const token = machineRequest
        ? typeof queryValue(fields, "List-Unsubscribe") === "string" &&
          queryValue(fields, "List-Unsubscribe") === "One-Click"
          ? new URL(request.url).searchParams.get("token")
          : null
        : queryValue(fields, "intent") === "unsubscribe"
          ? readCookie(request, UNSUBSCRIBE_COOKIE)
          : null;

      let outcome: "unsubscribed" | "invalid" = "invalid";
      if (token) {
        try {
          outcome = await dependencies.subscriptions.service.unsubscribe(token);
        } catch {
          return unavailable();
        }
      }
      if (machineRequest) {
        return new Response(null, {
          status: 204,
          headers: {
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          },
        });
      }
      return redirect(
        outcome === "unsubscribed"
          ? "/subscriptions/unsubscribed/"
          : "/subscriptions/unsubscribe-invalid/",
        { "set-cookie": unsubscribeCookie("", 0) },
      );
    });
}

function queryValue(value: object, key: string): unknown {
  return (value as Record<string, unknown>)[key];
}

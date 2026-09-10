# Cloudflare and Resend

Use this path for double opt-in email subscriptions on a Cloudflare Worker. Keep acceptance off until the final canary passes.

## Requirements

- A Cloudflare account with Workers, D1, and Queues available.
- A Resend API key and a verified sending domain.
- A production site configuration that uses Resend.
- A sender address on the verified domain.

## Site configuration

Set the subscription block in the site repository. The secret reference names a Worker secret and never contains the key itself.

```json
{
  "subscriptions": {
    "enabled": true,
    "doubleOptIn": true,
    "notificationFanoutEnabled": false,
    "delivery": {
      "provider": "resend",
      "connection": {
        "provider": "environment",
        "reference": "RESEND_API_KEY"
      },
      "senderName": "Your status name",
      "senderEmail": "status@example.com",
      "replyToEmail": "support@example.com"
    },
    "templates": {
      "logoPath": "./assets/favicon.svg",
      "subjectPrefix": "Your status name",
      "signOff": "Your name"
    },
    "confirmationTtlSeconds": 86400,
    "resendCooldownSeconds": 900
  }
}
```

Keep `notificationFanoutEnabled` false. Incident and maintenance fanout is not part of the current release.

## Cloudflare resources

Create one D1 database, one confirmation queue, and one dead-letter queue per status site. Add their bindings to the site's Wrangler configuration using the names shown in `apps/cloudflare-worker/wrangler.jsonc`.

```sh
bunx wrangler d1 create your-status-subscriptions
bunx wrangler queues create your-status-confirmations
bunx wrangler queues create your-status-confirmations-dlq
```

Apply the subscription schema only after the D1 binding points at the intended database:

```sh
bunx wrangler d1 migrations apply SUBSCRIPTIONS_DATABASE --remote
```

Set `SUBSCRIPTION_ACCEPTANCE_ENABLED` to `false` for the first deployment.

## Worker secrets

Set these with `wrangler secret put`. Do not store them in JSON, shell history, CI output, or git.

- `RESEND_API_KEY`: the key named by the site configuration.
- `LOOKUP_PEPPER`: at least 32 random bytes.
- `CONFIRMATION_PEPPER`: at least 32 random bytes.
- `UNSUBSCRIBE_PEPPER`: at least 32 random bytes.
- `RATE_LIMIT_PEPPER`: at least 32 random bytes.
- `OUTBOX_ENCRYPTION_KEY`: exactly 32 random bytes encoded as unpadded base64url.
- `RESEND_WEBHOOK_SECRET`: the signing secret returned for the production webhook.

Example interactive secret command:

```sh
bunx wrangler secret put RESEND_API_KEY
```

## Resend webhook

Create a Resend webhook at this endpoint:

```text
https://status.example.com/api/v1/webhooks/resend
```

Subscribe it to `email.bounced` and `email.complained`. Store its signing secret as `RESEND_WEBHOOK_SECRET`. The runtime verifies the raw signed request, deduplicates retries, and suppresses the matching subscriber.

## Activation gate

Deploy once with acceptance still false. Then verify all of the following against the intended site:

1. The status page and `current.json` still pass their canaries.
2. The D1 migration is present.
3. Queue producer, consumer, retries, and dead-letter queue resolve to the intended Worker.
4. A controlled subscription returns `202` without exposing subscriber state.
5. The confirmation email arrives with the configured sender, subject, and logo.
6. Opening the confirmation link does not activate the address until the explicit confirmation button is submitted.
7. A replay remains idempotent.
8. A signed bounce or complaint event suppresses future delivery.
9. Invalid signatures and oversized webhook requests are rejected.

Only after every check passes, set `SUBSCRIPTION_ACCEPTANCE_ENABLED` to `true`, deploy again, and repeat the public form canary. If any check fails, restore the flag to `false`. Existing confirmation and unsubscribe links remain usable while new acceptance is paused.

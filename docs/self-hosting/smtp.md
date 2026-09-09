# SMTP limitations

SMTP transport is planned. A provider-neutral mail renderer and an in-memory subscriber repository exist for deterministic tests, but no SMTP adapter, durable subscriber store, queue consumer, or feedback processor exists.

## Configuration shape

The site schema accepts a managed secret reference and public sender identity:

```json
{
  "subscriptions": {
    "enabled": true,
    "doubleOptIn": true,
    "notificationFanoutEnabled": false,
    "delivery": {
      "provider": "smtp",
      "connection": {
        "provider": "environment",
        "reference": "SMTP_CONNECTION"
      },
      "senderName": "Example status",
      "senderEmail": "status@example.com",
      "replyToEmail": "support@example.com"
    },
    "confirmationTtlSeconds": 86400,
    "resendCooldownSeconds": 300
  }
}
```

The current renderer uses public sender fields, and `doctor` checks the presence of an environment-backed connection reference. No code parses that secret or opens an SMTP connection. The referenced secret is intended to hold the host, port, username, password, and TLS policy. Never place those values in site configuration, source control, build output, or logs.

## Public fanout remains closed by default

A generic SMTP relay does not necessarily provide reliable bounce and complaint feedback, provider suppression, stable message acceptance identifiers, or account-level reputation controls. Without verified feedback handling, SMTP may be used only for local preview and tightly controlled canary delivery after the adapter exists.

Do not enable public incident or maintenance fanout through SMTP unless the chosen provider and integration have verified all of these behaviors:

- TLS certificate and hostname verification
- Authentication and secret rotation
- Deterministic text and HTML rendering
- Stable message identity and duplicate-send protection
- Standards-compliant `List-Unsubscribe` headers and one-click unsubscribe
- Hard-bounce and complaint ingestion
- Durable suppression before later sends
- Bounded retries, timeout behavior, and dead-letter handling
- Rate and concurrency controls
- Delivery kill switch
- Redacted application and provider logs
- Restore testing that cannot reactivate suppressed recipients

If the provider cannot supply trustworthy bounce and complaint signals, keep `notificationFanoutEnabled` false. A successful SMTP acceptance response proves relay acceptance, not inbox delivery.

## Local preview

The architecture proposes Mailpit for safe local rendering, but no Mailpit configuration or preview command exists in this repository yet. Do not infer production readiness from an email rendered in a local inbox.

# AWS preview

The preview stack serves static assets and `current.json` through CloudFront while
a single-concurrency Lambda refreshes status once per minute. Kuma is only the
monitoring source. A Kuma outage leaves the public page online with the last valid
snapshot, which the UI marks as delayed after the configured freshness window.

This stack does not create a custom domain, subscriber storage, queues, mail
delivery, or admin APIs.

## Monitoring secret

Create one Secrets Manager secret in the deployment account and `ap-south-1`.
Use the AWS-managed Secrets Manager key for this preview. The Lambda role receives
`secretsmanager:GetSecretValue` only for the exact secret ARN.

The secret value has this exact shape:

```json
{
  "schemaVersion": "1.0.0",
  "endpointUrl": "https://monitor.example.com/api/status-export/v1/all",
  "bearerToken": "replace-with-at-least-32-visible-ascii-characters"
}
```

The endpoint must use HTTPS and the versioned `/api/status-export/v1/:slug` path.
The token must match the Kuma server's `STATUS_EXPORT_TOKEN`. Never put the token
in site configuration, build output, command arguments, or logs.

On Kuma, `STATUS_EXPORT_COMPONENTS` maps private monitor IDs to the public
component IDs in `status.config.json`:

```json
{"all":{"1":"api","2":"website"}}
```

The mapping must exactly match the public monitors attached to that Kuma status
page. The endpoint returns `503` on a topology mismatch.

## Build and synthesize

Build the Lambda bundle:

```sh
bun run build:aws-publisher
```

Set the preview inputs described in `examples/.env.example`. Then synthesize:

```sh
bun run synth:aws-preview
```

The site configuration must be production mode, use one Uptime Kuma source for
every component, and keep subscriptions disabled. Synthesis stops if the site
configuration plus Lambda environment would approach the 4 KB AWS limit.

Review the synthesized template before deployment. It must contain only the
private versioned S3 origin, CloudFront distribution, one Lambda publisher, one
EventBridge one-minute rule, one dead-letter queue, retained logs, and the narrow
S3 and Secrets Manager permissions covered by the test suite.

## First publication

Do not share the preview hostname until all of these checks pass:

1. The private Kuma endpoint returns `200` with the bearer token and `401` without it.
2. The first Lambda invocation succeeds and writes both an immutable snapshot and `current.json`.
3. `current.json` contains the configured component IDs and a current `latestCheckAt`.
4. A forced invalid Kuma response causes no S3 writes and leaves `current.json` unchanged.
5. The CloudFront URL serves the page and `current.json` without console or asset errors.

Keep the existing status page and DNS unchanged until the preview passes these
checks. The generated CloudFront hostname is the only preview URL in this phase.

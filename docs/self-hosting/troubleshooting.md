# Troubleshooting

Start with the current capability boundary: site initialization, field-level validation, local preview, static builds, private Kuma snapshot publication, a delivery-disabled AWS preview read path, deterministic subscribe, confirmation, and unsubscribe route tests, provider-neutral mail rendering, and offline Uptime Kuma 2.2 SQLite history inspection are available. Production custom-domain deployment, durable subscription storage, destination history apply, and mail transport are planned.

## Install or command failures

Confirm the Bun version:

```sh
bun --version
```

The repository currently pins Bun 1.3.14. Install dependencies without changing the lock file:

```sh
bun install --frozen-lockfile
```

Show the available operator commands:

```sh
bun run status help
```

Deploy, import, and administrative commands remain unavailable until their durable backends exist.

## Site configuration fails to load

Run a build with an explicit site path:

```sh
STATUS_SITE_CONFIG=/absolute/path/status.config.json bun run build
```

Check these common causes:

- The path is resolved from `apps/web` when relative. Use an absolute path to remove ambiguity.
- JSON has an unknown field. The schema rejects additional properties.
- A hostname includes `https://`, a path, or a trailing dot.
- An asset path is not relative, contains `..`, or points outside the site directory.
- Locale or timezone is not accepted by the JavaScript `Intl` APIs.
- Semantic colors are duplicated or do not support readable foreground text.
- `staleAfterSeconds` is less than twice `pollIntervalSeconds`.
- Component IDs, source IDs, or source and monitor bindings are duplicated.
- A component refers to a missing source.
- Production mode contains a fixture source.
- A subscription cooldown is greater than or equal to its confirmation lifetime.

Get field-level diagnostics before running a build:

```sh
bun run status validate /absolute/path/status.config.json
```

## Production build requests a snapshot

`deploymentMode: "production"` requires `STATUS_SNAPSHOT_PATH`:

```sh
STATUS_SITE_CONFIG=/absolute/path/status.config.json STATUS_SNAPSHOT_PATH=/absolute/path/current.json bun run build
```

The snapshot must validate and contain exactly the site's configured component IDs. The AWS publisher can create and refresh it from a compatible private Kuma export. A local static build still requires an existing snapshot file.

## Assets fail during build

Asset paths are resolved relative to the site JSON file. Confirm the exact filename and case, and keep the file inside the site directory. Do not replace a missing asset with an external URL.

## The page says status data is delayed

This is a safety state. The latest observation is older than `staleAfterSeconds`, has invalid time ordering, or cannot be refreshed. Do not increase the threshold only to make the page appear healthy.

For a local production snapshot, inspect `generatedAt`, `latestCheckAt`, component timestamps, source revision, and the machine clock. The public page must remain independent of Kuma and retain the last valid snapshot during a source outage.

## Latency is absent

The response-time section appears only for components with latency data. `showLatency: true` declares presentation intent, but the normalized snapshot must also contain valid latency points for that component.

## Subscription controls say unavailable

This is expected for delivery-disabled sites. The repository has injectable subscribe, confirmation, and scanner-safe unsubscribe routes backed by an in-memory test repository, but the production server does not enable them without a durable repository. Do not enable subscription configuration to work around missing production storage and delivery.

## SES or SMTP mail does not send

No delivery adapter exists yet. Follow [Amazon SES gates](ses.md) or [SMTP limitations](smtp.md) when implementation becomes available. Never test by placing credentials in site JSON or shell history.

## History import command is missing

The normalized bundle validator exists, but extraction, preview, and apply commands do not. Preserve a consistent source backup or dump and its checksum, then stop. Do not query or transform a live monitoring database from this application. See [History migration](kuma-history-migration.md).

## API probe checks

Start the probe service:

```sh
bun run dev:api
```

Check liveness and readiness:

```sh
curl -fsS http://localhost:3000/healthz
```

```sh
curl -fsS http://localhost:3000/readyz
```

Both endpoints currently report process readiness only. They do not verify a database, queue, Kuma, SES, SMTP, or public snapshot.

## Escalation evidence

Capture the exact command, exit code, Bun version, site path, deployment mode, and redacted error. Never attach site secrets, monitor credentials, subscriber data, token-bearing URLs, or full environment dumps.

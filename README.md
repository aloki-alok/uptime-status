# uptime-status

A reusable customer-facing status platform. It includes a validated site contract, static Astro status UI, Bun setup CLI, direct HTTPS and private Uptime Kuma publishers, a delivery-disabled AWS CloudFront preview stack, encrypted subscriber storage for Cloudflare D1, queued Resend confirmation delivery, scanner-safe double opt-in, bounce and complaint suppression, provider-neutral mail rendering, and an offline Uptime Kuma 2.2 SQLite history extractor. Production custom-domain activation and destination history apply remain operator-gated.

See the [visual review](docs/visual-review.md) for light and dark screenshots, supported public states, and the interface review checklist.

## Local development

Requires Bun 1.3.14 or the version pinned in `packageManager`.

```sh
bun install --frozen-lockfile
bun run dev
```

The static site runs at `http://localhost:4321`. The Elysia probe service runs separately with `bun run dev:api`.

The default development build uses `examples/status.config.json`. Select another site with `STATUS_SITE_CONFIG`. Production sites must also provide `STATUS_SNAPSHOT_PATH`; production configuration cannot use generated fixture monitoring.

## Site CLI

Generate a neutral production site without editing platform source:

```sh
bun run status init ./my-status
```

Validate it with field-level diagnostics and run read-only local checks:

```sh
bun run status validate ./my-status/status.config.json
bun run status doctor ./my-status/status.config.json
```

After supplying a validated production snapshot, build its static site:

```sh
bun run status build --site ./my-status/status.config.json --snapshot ./current.json
```

Create a sanitized history bundle from a transactionally consistent offline Uptime Kuma backup:

```sh
bun run status history inspect --site ./my-status/status.config.json --source primary --artifact /secure/kuma-history-backup.sqlite --cutoff 2026-09-09T04:00:00Z --exported 2026-09-09T04:05:00Z --source-version 2.2.0 --out /secure/history.bundle.json
```

The inspect command reads only an offline backup, checks its integrity and allowlisted schema, verifies its identity before and after extraction, and writes a mode `0600` provider-neutral bundle. It does not provision AWS, connect through SSH, change DNS, touch the live Kuma database, or send email.

## Quality checks

```sh
bun run check
bun run check:all
```

`check` runs formatting, lint, type checks, unit tests, cross-site isolation, and the production build. `check:all` also runs the browser suite. Unit tests live under each workspace's `tests/` directory. Cross-workspace browser tests live under `tests/e2e/`.

The operator documentation and current capability boundary start at [`docs/self-hosting/README.md`](docs/self-hosting/README.md).

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before adding a package, adapter, or test.

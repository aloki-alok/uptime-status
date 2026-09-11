# Self-hosting

The repository currently provides a validated site contract, a static Astro status site, generated example data, health probes, site setup CLI, a private Uptime Kuma export consumer, a one-minute AWS snapshot publisher, a delivery-disabled CloudFront preview stack, tested double opt-in and scanner-safe unsubscribe lifecycle foundations, provider-neutral mail rendering, and an offline Uptime Kuma 2.2 SQLite history extractor. Production custom-domain deployment, destination history apply, durable subscriber storage, mail transports, queue workers, and feedback processing are not implemented.

## Quick start

You need Bun 1.3.14, or the version declared in the root `package.json`.

```sh
bun install --frozen-lockfile
bun run dev
```

Open `http://localhost:4321`. The default preview uses `examples/status.config.json` and generated status data.

Create and validate a neutral production site:

```sh
bun run status init ./my-status
bun run status validate ./my-status/status.config.json
```

The generated template references `UPTIME_KUMA_CONNECTION`. `doctor` checks that the variable exists, but does not connect to Kuma:

```sh
UPTIME_KUMA_CONNECTION=local-check-only bun run status doctor ./my-status/status.config.json
```

Run the available checks before sharing a build:

```sh
bun run check
bun run check:all
```

To preview another example-mode site, set `STATUS_SITE_CONFIG` to its JSON file:

```sh
STATUS_SITE_CONFIG=../../examples/second-site.config.json bun run dev
```

A production-mode build also requires a validated normalized snapshot:

```sh
STATUS_SITE_CONFIG=/absolute/path/status.config.json STATUS_SNAPSHOT_PATH=/absolute/path/current.json bun run build
```

This command builds static output only. It does not provision infrastructure, publish a snapshot, configure DNS, or deploy the site.

## What is available

| Capability                                                              | State                                                |
| ----------------------------------------------------------------------- | ---------------------------------------------------- |
| Site and snapshot validation during build                               | Available                                            |
| Local example preview                                                   | Available                                            |
| Static site build                                                       | Available                                            |
| API `/healthz` and `/readyz` probes                                     | Available                                            |
| Site `init`, `validate`, `build`, and `doctor` CLI commands             | Available                                            |
| Deploy, history import, and admin CLI commands                          | Planned                                              |
| Uptime Kuma HTTPS adapter and snapshot publisher                        | Available                                            |
| History validation, registry, and Uptime Kuma 2.2 SQLite extraction     | Available; preview, apply, rollback, and other extractors are planned    |
| AWS deployment input, naming, role-boundary, and release-gate contracts | Available                                            |
| Delivery-disabled AWS preview read path                                 | Available                                            |
| Subscription state service and injectable public routes                 | Available for tests, not wired to production storage |
| Provider-neutral mail rendering                                         | Available as a tested library; no transport is wired |
| SES and SMTP transports, workers, and feedback processing               | Planned                                              |
| Backup and restore automation                                           | Planned                                              |

Do not expose the current example build as a production status service. Its status and history are synthetic.

## Operator guides

- [Configuration](configuration.md)
- [AWS preview](aws-preview.md)
- [Kuma history migration](kuma-history-migration.md)
- [Amazon SES gates](ses.md)
- [SMTP limitations](smtp.md)
- [Backup and restore](backup-restore.md)
- [Troubleshooting](troubleshooting.md)

The detailed proposed architecture remains in [`../self-hosting-architecture.html`](../self-hosting-architecture.html). It is a design document, not a deployment manual.

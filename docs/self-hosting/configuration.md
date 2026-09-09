# Configuration

Site configuration is JSON validated against schema version `1.0.0`. Use `examples/status.config.json` as the smallest complete example and `examples/second-site.config.json` to verify site isolation.

Run field-level validation before building:

```sh
bun run status validate /absolute/path/status.config.json
```

The same canonical validator also runs when the web application loads build data, including during `bun run dev`, `bun run build`, and `bun run test:sites`.

## Build inputs

| Variable               | Required                                                | Purpose                                                                        |
| ---------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `STATUS_SITE_CONFIG` | No for the bundled example, yes for another site      | Absolute path, or path relative to `apps/web`, to a site JSON file           |
| `STATUS_SNAPSHOT_PATH` | Required for `production` mode                          | Absolute path, or path relative to `apps/web`, to a normalized status snapshot |
| `PORT`                 | Only for `bun run dev:api` when port 3000 is unsuitable | Port for the Elysia probe service                                              |

`examples/.env.example` is a variable reference. The repository does not currently provide a command that copies or validates an environment file.

`doctor` checks environment variables named by `environment` secret references in site configuration. The generated template uses `UPTIME_KUMA_CONNECTION`; an SMTP site may choose another variable name. It checks presence only and does not connect to either provider. AWS Secrets Manager references are not resolved by the current command.

## Site fields

### Identity and domains

- `schemaVersion` must be `1.0.0`.
- `deploymentMode` is `example` or `production`. Production mode rejects fixture monitoring.
- `siteId` is a lowercase slug containing letters, digits, and hyphens.
- `displayName` and `legalName` are public identity fields.
- `locale` must be accepted by `Intl.Locale`.
- `timeZone` must be an IANA timezone accepted by `Intl.DateTimeFormat`.
- `domains.primary` is required. `legacy` and `preview` are optional. Values are hostnames without schemes or paths and must be unique.

### Brand and community

- `brand.homeUrl` must be an HTTPS URL without credentials, query text, or a fragment.
- Logo, icon, favicon, and optional email media paths begin with `./`, stay inside the site directory, and contain no empty, `.` or `..` path segments.
- `brand.logoAlt` describes the site identity, not the image appearance.
- `community` is optional. Its `kind` is `discord`, `forum`, or `community`, and its URL must use HTTPS.

### Presentation

- `presentation.bannerVariant` is optional. Supported values are `classic`, `compact`, and `plain`; omission selects `classic`.
- `statusCopy` supplies public text for operational, degraded, partial outage, major outage, maintenance, and delayed states.
- Each semantic color is a six-digit hex value. Operational, maintenance, degraded, outage, and unknown colors must be distinct and must support readable light or dark text.

### Monitoring and components

- `pollIntervalSeconds` is an integer from 30 through 300.
- `staleAfterSeconds` is an integer from 60 through 900 and must be at least twice the poll interval.
- Each monitoring `sourceId` is unique.
- `fixture` sources are allowed only in example mode.
- An `uptime-kuma` source contains a managed secret reference. The adapter that consumes this reference is planned and is not present in the current repository.
- Each component has a unique `componentId`, a public name and group, a valid `sourceId`, a source-specific `monitorRef`, and a `showLatency` choice.
- A source and monitor reference pair may map to only one public component.

Never place a monitor URL, API token, SMTP password, AWS key, or subscriber address in this JSON file. Store only a secret provider and reference.

### Subscriptions

The only production-safe configuration today is delivery-disabled:

```json
{
  "subscriptions": {
    "enabled": false,
    "disabledReason": "delivery-not-configured",
    "doubleOptIn": true
  }
}
```

The schema also accepts SES and SMTP settings. An in-memory state service and injectable Elysia subscribe and confirm routes exist for deterministic testing, but no durable production repository or delivery adapter exists. Keep `enabled` false for real sites until those implementations and all provider gates are verified.

## Snapshot input

Production builds require `STATUS_SNAPSHOT_PATH`. The snapshot must pass the shared status schema, contain exactly the component IDs declared by the site, and contain a complete 90-day history for every component. Invalid, missing, extra, or mismatched components stop the build.

The build reads a file. It does not fetch Kuma, repair stale data, or publish output. Snapshot publication is planned.

## Asset boundary

Assets resolve relative to the selected site configuration file, not the repository root. Keep site configuration and its assets together. The asset route rejects paths that escape that directory.

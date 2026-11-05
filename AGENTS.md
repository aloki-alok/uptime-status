# AGENTS.md

uptime-status is a customer-facing status platform: a Bun workspace in TypeScript with an Astro status site, an Elysia API, a monitor, a Cloudflare Worker and an offline Uptime Kuma history importer. Key constraint: the portable status contract must stay free of any provider code.

## Commands

Use Bun 1.3.14 (pinned in `packageManager`). Do not use npm or yarn.

- Install: `bun install --frozen-lockfile`
- Lint: `bun run lint` (fix with `bun run lint:fix`)
- Check formatting: `bun run format:check`
- Test layout rule: `bun run test:layout`
- Type check: `bun run typecheck`
- Unit tests: `bun run test`
- Cross-site isolation: `bun run test:sites`
- Production build: `bun run build`
- All of the above in CI order: `bun run check`

## Layout

- `apps/web`: static Astro status site.
- `apps/api`: Elysia service for subscriptions and mail delivery (SQLite).
- `apps/monitor`: native monitor that probes, stores, rolls up and publishes a snapshot.
- `apps/cloudflare-worker`: Worker with D1 storage for encrypted subscribers and Resend mail.
- `packages/status-contract`: portable schemas, state rules and validation.
- `packages/uptime-math`: uptime calculations.
- `packages/history-import`: offline Uptime Kuma SQLite history extractor.
- `packages/snapshot`, `packages/monitor`, `packages/email`, `packages/cli`: publishers, probes, mail rendering, the `status` CLI.
- `packages/aws-infrastructure`: delivery-disabled CloudFront preview stack.
- `examples/`: runnable site configs. `tests/e2e/`: Playwright tests. `scripts/`: repo checks.
- `docs/self-hosting/`: operator docs. Start at `docs/self-hosting/README.md`.

## Rules

- Keep dependencies pointed inward. `status-contract` must not import AWS, databases, Elysia, Astro, SES or SMTP. Source adapters may import it, never the reverse.
- Keep tests out of `src/`. Put them in the owning workspace's `tests/` directory. Use `tests/integration/` for databases, containers and process boundaries. `bun run test:layout` enforces this.
- Include both `src/**/*.ts` and `tests/**/*.ts` in every workspace `tsconfig.json`.
- The public legend has exactly three states: `Operational`, `Maintenance`, `Outage`. Do not add more. Unknown or stale data is a neutral data-quality state, never "healthy".
- Name import adapters by source product and storage format (`uptime-kuma-sqlite`). Never write a generic SQL reader. Adapters never write the source database.
- Delivery adapters take the provider-neutral mail model. Templates never call SES or SMTP directly.
- A site repository holds identity, assets and mappings. It does not fork platform logic.
- Production sites need `STATUS_SNAPSHOT_PATH`. Production config cannot use generated fixture monitoring. Select a site with `STATUS_SITE_CONFIG`.
- Never commit secrets, subscriber data or Kuma backups. Report vulnerabilities through GitHub security advisories (`SECURITY.md`).
- CSS rules are set in `biome.json`. Two are off on purpose. Do not re-enable them.

## Before you open a PR

CI runs `bun run check` (job Quality) and `bun run test:e2e` (job Browser, needs `bunx playwright install` first). Run `bun install --frozen-lockfile`, then `bun run check`. Run `bun run check:all` if you changed browser behavior.

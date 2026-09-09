# Contributing

This project uses Bun for dependency management, scripts, tests, and TypeScript tooling.

## Before a change

```sh
bun install --frozen-lockfile
bun run check
```

Run `bun run check:all` before a release or after changing browser behavior.

Use `bun run lint:fix` for safe Biome fixes and `bun run format` when only formatting is needed. CI runs `bun run check`, so local and remote validation use the same command.

CSS is formatted and linted by Biome. The CSS override disables two rules deliberately: reduced-motion declarations need `!important` to defeat author animations, and descending-specificity reports are unreliable across unrelated component selectors in the shared stylesheet. All other recommended CSS rules remain enabled.

## Project boundaries

- `packages/status-contract/src` owns portable schemas, state rules, and validation. It must not know about AWS, databases, Elysia, Astro, SES, or SMTP.
- `apps` compose domain behavior for a runtime or user interface.
- Infrastructure packages translate validated inputs into provider plans. They do not weaken domain rules.
- Source adapters translate one external system and storage format into a normalized contract. They never write the source database.
- Delivery adapters accept the provider-neutral mail model. Templates do not call SES or SMTP directly.
- A site repository contains identity, assets, mappings, and environment references. It does not fork reusable platform logic.

Keep dependencies pointed inward. A source adapter may import the status contract. The status contract must never import a source adapter.

## Tests

Production code and tests are separate:

```text
apps/api/src/
apps/api/tests/
packages/example/src/
packages/example/tests/
packages/example/tests/integration/
tests/e2e/
```

- Put unit and contract tests in the owning workspace's `tests/` directory, mirroring the `src/` path when useful.
- Put tests that need a database, container, filesystem process boundary, or cloud event envelope under `tests/integration/`.
- Put test-only data under the owning workspace's `tests/fixtures/` directory.
- Keep `examples/` runnable and understandable. Do not use it as a hidden fixture directory.
- Keep cross-workspace browser and system tests under the root `tests/e2e/` directory.
- Include both `src/**/*.ts` and `tests/**/*.ts` in every workspace TypeScript configuration.

Do not add `*.test.ts` or `*.spec.ts` files under `src/`.

## Public status language

The public legend contains exactly three categories:

- `Operational`
- `Maintenance`
- `Outage`

Detailed outage severity stays in incident and machine-readable records. Unknown or stale data is a neutral data-quality condition and must not be relabeled as healthy. Do not add more public status tags to make an internal state visible.

## Import adapters

Import adapters are specific to both the source product and the storage format. Use identifiers such as `uptime-kuma-sqlite` and `uptime-kuma-mariadb`, not a generic SQL reader that guesses table meaning.

Every supported adapter needs:

1. Sanitized versioned source fixtures.
2. Strict table and column allowlists.
3. UTC and source-timezone tests.
4. Golden output parity against the source product.
5. Credential and private-field leakage tests.
6. Deterministic bundle output and idempotent apply tests.

An open adapter identifier in the bundle is an extension point, not proof that an adapter works.

# History migration

The provider-neutral history bundle, canonical identity validator, source extractor registry, offline artifact verifier, Uptime Kuma 2.2 SQLite extractor, and local `history inspect` command are implemented. Preview, apply, verify, and rollback commands are not. The registry rejects missing or duplicate extractors, invalid or forged canonical output, mutable requests, changed site or source identity, changed artifact provenance, changed topology, and changed source mappings. Do not apply a bundle until the remaining reviewed-plan and durable-receipt stages exist, and never give the status runtime access to a live monitoring database.

## Source adapter boundary

Import support is defined by the monitoring product and its storage engine, not by the database engine alone:

```text
offline SQLite backup or MariaDB dump
  -> source-specific extractor
  -> normalized history bundle
  -> shared validator and preview
  -> platform history store
```

[Uptime Kuma 2 officially supports SQLite and MariaDB storage](https://github.com/louislam/uptime-kuma/wiki/Environment-Variables). `uptime-kuma-sqlite` is implemented for the verified 2.2 schema. `uptime-kuma-mariadb` remains planned. The adapter identifier in the bundle is open so MySQL, PostgreSQL, portable JSON, CSV, and other monitoring products can be added without changing the bundle schema. An adapter is supported only after it has sanitized versioned fixtures and parity tests. A database driver by itself is not an importer because each monitoring product has different tables, timestamps, and outage semantics.

Database credentials and connection details belong only in a private extractor input. They never enter the normalized bundle, the public snapshot, or a runtime service.

## Safety rules

1. Treat every source database or dump as an offline migration input only.
2. Never copy a live SQLite database file, its WAL file, or its shared-memory file as a migration backup.
3. Use the source database's transactionally consistent backup or dump mechanism.
4. Preserve the original artifact as immutable evidence until migration verification and rollback retention are complete.
5. Record the artifact SHA-256, cutoff time, source system and schema versions, extractor version, timezone assumptions, topology revision, and explicit source-to-component mappings.
6. Inspect SQLite backups read only. Import MariaDB, MySQL, or PostgreSQL from an offline dump or a purpose-built read-only export account, never from status runtime credentials.
7. Run the engine-specific integrity checks before extraction.
8. Allowlist supported tables and columns. Never run source-product migrations against an import artifact.
9. Exclude URLs, headers, credentials, notifier settings, internal monitor names, and infrastructure topology from exported history.
10. Imported history must never create incidents, maintenance, subscriptions, or notification work automatically.

## Creating a source backup

Pause if the database path or ownership is uncertain. Run the backup on the Kuma host with enough free space and a destination outside Kuma's live data directory.

The SQLite shell's `.backup` command uses the online backup API:

```sh
sqlite3 /absolute/path/kuma.db ".backup '/absolute/path/kuma-history-backup.sqlite'"
```

Verify the backup, not the live database:

```sh
sqlite3 -readonly /absolute/path/kuma-history-backup.sqlite "PRAGMA integrity_check;"
```

The result must be exactly `ok`. Record a checksum:

```sh
shasum -a 256 /absolute/path/kuma-history-backup.sqlite
```

These commands create and verify a SQLite backup only. They do not produce a platform history bundle.

For MariaDB and future engines, use a transactionally consistent dump procedure documented and tested by that adapter. Do not assume MySQL and MariaDB schemas or timestamp behavior are interchangeable.

## Inspecting an offline backup

The site configuration supplies the site identity and explicit source-to-component mappings. Every mapped Uptime Kuma `monitorRef` must be the positive numeric monitor ID from the inspected backup.

```sh
bun run status history inspect \
  --site /absolute/path/status.config.json \
  --source primary \
  --artifact /absolute/private/path/kuma-history-backup.sqlite \
  --cutoff 2026-09-09T04:00:00Z \
  --exported 2026-09-09T04:05:00Z \
  --source-version 2.2.0 \
  --out /absolute/private/path/history.bundle.json
```

The command refuses to overwrite its output. It computes and rechecks the artifact SHA-256, records file identity, runs `PRAGMA integrity_check`, uses only allowlisted columns, excludes incomplete UTC days, and writes the sanitized bundle with mode `0600`. The canonical import ID is derived from sorted JSON object keys and cannot be supplied by an extractor.

## Remaining import workflow

The supported workflow will require:

1. A private extractor input with explicit component mappings and source provenance.
2. Schema allowlist validation and an integrity check.
3. A normalized bundle containing the site ID, source ID, topology revision, extractor identity, artifact hash, coverage, cutoff, and namespaced source bindings.
4. A preview showing record counts, time ranges, gaps, collisions, exclusions, and proposed writes.
5. Sampled comparison against the source product's pinned historical behavior. The current Kuma fork remains the golden oracle for its UTC daily buckets and confirmed-down intervals.
6. Explicit apply approval using the reviewed import ID and bundle hash.
7. An idempotency check proving the same import becomes a no-op.
8. Post-import comparison before any public history is promoted.

Only `uptime-status history inspect` exists today. Preview, apply, verify, and rollback remain planned interfaces and are required before any bundle can be promoted.

## Rollback contract

A failed import must be removable by import ID without deleting observations written after the import cutoff. Rollback must retain the original SQLite backup, import manifest, preview report, checksum, apply receipt, audit records, and any prior platform-native history version.

If an importer cannot meet this contract, do not apply the migration.

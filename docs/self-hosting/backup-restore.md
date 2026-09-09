# Backup and restore

Backup automation and the production AWS stack are planned. This document defines the required operator contract. It does not provide runnable platform backup or restore commands.

## Data classes

| Data                                                                        | Planned protection                                  | Restore priority                                               |
| --------------------------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------- |
| Published HTML, assets, immutable snapshots, and `current.json`             | S3 versioning and independent public delivery       | Restore the last validated public version first                |
| Incident, maintenance, subscriber, suppression, delivery, and audit records | DynamoDB point-in-time recovery and tested exports  | Restore with all write and fanout gates closed                 |
| Delivery queue and dead letters                                             | SQS retention, alarms, and replay controls          | Inspect before replay; never replay blindly                    |
| Site configuration and assets                                             | Version-controlled site repository                | Restore the last reviewed site revision                      |
| Imported Kuma history                                                       | Versioned bundle, manifest, checksum, and import ID | Restore or remove only the affected import                     |
| Original Kuma source backup                                                 | Immutable offline copy                              | Retain for verification and re-import                          |
| Managed secrets                                                             | Provider-managed versioning and documented rotation | Restore references, then verify access without printing values |

The live Kuma database is not a platform runtime backup. Historical migration uses a separate consistent SQLite backup as described in [Kuma history migration](kuma-history-migration.md).

## Backup requirements before production

- Enable S3 object versioning and block public bucket access. The public edge should read only approved objects.
- Enable DynamoDB point-in-time recovery for every state table.
- Retain audit records, import receipts, and delivery ledgers across application rollback.
- Document queue retention and dead-letter redrive policy.
- Store site configuration and assets at a reviewed revision.
- Record recovery point and recovery time objectives for each data class.
- Run a restore rehearsal in an isolated environment. A configured backup is not verified until restoration succeeds.

## Restore order

1. Freeze subscription acceptance, administrative writes, publisher promotion, and notification fanout.
2. Record the incident time, suspected bad revision, current public object version, and queue depth.
3. Restore the last validated public snapshot or site version so the read path is truthful.
4. Restore durable control and subscriber state to an isolated environment first.
5. Reconcile subscriber suppression with provider suppression before any canary send.
6. Inspect queued and dead-letter work against restored delivery ledgers.
7. Verify site scope, component topology, status freshness, incident revisions, maintenance timing, unsubscribe state, and audit continuity.
8. Enable read paths, then canary writes, then canary delivery. Public fanout is last and requires explicit approval.

## Scenario guidance

### Bad public snapshot

Restore a prior validated S3 object version. Do not change incident, subscriber, or audit state. Diagnose the publisher before allowing another promotion.

### Failed history import

Remove only rows carrying the failed deterministic import ID. Preserve live observations after the import cutoff and retain the source backup, manifest, preview, and apply receipt.

### Subscriber-state restore

Keep fanout disabled. Restore state, then reconcile unsubscribed and suppressed recipients against provider feedback. Test with verified canaries before reopening acceptance or delivery.

### Email incident

Stop delivery consumption first. Preserve queues and delivery records for investigation. Do not purge work as a rollback shortcut.

### Full deployment rollback

Redeploy the previously pinned platform revision to a preview hostname and verify it. If the public hostname has already moved, keep the retained legacy page available with valid TLS and restore routing only after the rollback target passes checks.

## Evidence to retain

For every rehearsal or real restore, retain timestamps, operator identity, source and target versions, checksums, commands used, redacted verification output, queue decisions, canary results, and the decision that reopened each gate.

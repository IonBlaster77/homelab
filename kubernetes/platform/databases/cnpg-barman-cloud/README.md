# CNPG Barman Cloud plugin

Continuous WAL archiving and daily base backups for the CNPG clusters, stored
in [RustFS](../../storage/rustfs/README.md). Together they give
**point-in-time recovery**: restore a database to any moment within the
retention window, not just the last volume backup. Plan and decisions:
[`docs/projects/agent-observability.md`](../../../../docs/projects/agent-observability.md)
(task #50).

| | |
|---|---|
| **Chart** | [`plugin-barman-cloud`](https://github.com/cloudnative-pg/charts) from `cloudnative-pg.github.io/charts`; chart 0.8.1 = plugin v0.15.1 |
| **Namespace** | `cnpg-system` (must be the operator's namespace) |
| **Needs** | CNPG ≥ 1.26 (running 1.30.1) and cert-manager (the chart makes its own Issuer and certificates for operator↔plugin gRPC) |
| **Storage** | None. Backups go to `s3://cnpg/<cluster>/` in RustFS |

## How it fits together

1. **This app** runs the plugin and installs the `ObjectStore` CRD.
2. **Each database** gets, in its own app folder:
   - `secret-<cluster>-backup.sops.yaml`: its own RustFS key, limited to `s3://cnpg/<cluster>/`
   - `objectstore-<cluster>.yaml`: where to back up, and retention
   - a `plugins:` entry on its `Cluster` (`isWALArchiver: true`)
   - `scheduledbackup-<cluster>.yaml`: the daily base backup
3. The plugin injects a sidecar into each Postgres pod, and the sidecar uploads
   WAL segments and base backups.

Bucket, users and policies are made by
`~/homelab/restructure-tools/rustfs-cnpg-provision.sh <cluster>`. It's
idempotent, and it writes the cluster's SOPS secret into the repo.

## Gotchas

- **The chart ships the `ObjectStore` CRD, so this app has `prune: false`,**
  like the `cnpg` app. Deleting the CRD deletes every `ObjectStore`.
- **Adding the plugin to a `Cluster` restarts its pods** (the sidecar is
  injected), including a primary switchover. Do one cluster at a time and
  check its app afterwards.
- **S3 checksum env vars are required for RustFS.** Every `ObjectStore` sets
  `AWS_REQUEST_CHECKSUM_CALCULATION` and `AWS_RESPONSE_CHECKSUM_VALIDATION`
  to `when_required` in `instanceSidecarConfiguration.env`, or newer boto3
  fails with `x-amz-content-sha256` errors.
- **`backups.postgresql.cnpg.io` collides with `backups.longhorn.io`.**
  Always use the full name with kubectl.
- **Don't set `immediate: true` on a new cluster's ScheduledBackup.** It's
  created in the same sync as the `plugins:` entry and fires before the pods
  restart with the sidecar, failing with "requested plugin is not available"
  (grafana-db, 2026-10-24). Once the pods are back, take the first base backup
  by hand, which opens the recovery window:

  ```yaml
  apiVersion: postgresql.cnpg.io/v1
  kind: Backup
  metadata:
    name: <cluster>-first
    namespace: <namespace>
  spec:
    cluster:
      name: <cluster>
    method: plugin
    pluginConfiguration:
      name: barman-cloud.cloudnative-pg.io
  ```

## Restoring

[`docs/runbooks/cnpg-point-in-time-restore.md`](../../../../docs/runbooks/cnpg-point-in-time-restore.md):
tested end to end on grafana-db, 2026-10-24.

## Rollout

| Cluster | Archiving | First base backup | Restore tested |
|---|---|---|---|
| grafana-db | 2026-10-24 (#288) | 2026-10-24 | 2026-10-24 |
| matrix-db | 2026-10-24 (+ PodMonitor) | 2026-10-24 | |
| harbor-db | 2026-10-24 (+ PodMonitor) | 2026-10-24 | |
| authentik-db | 2026-10-24 | 2026-10-24 | 2026-10-24 |
| kea-db | 2026-10-24 (included even though Kea is unused: it's tiny) | 2026-10-24 | |

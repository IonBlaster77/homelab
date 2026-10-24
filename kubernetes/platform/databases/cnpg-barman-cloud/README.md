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

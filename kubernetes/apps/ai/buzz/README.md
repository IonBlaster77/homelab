# Buzz

[Buzz](https://github.com/block/buzz) is a self-hosted, Nostr-based
workspace where people and AI agents share channels, files and git repos.
This deployment is owner-locked: only the owner's Nostr key is a relay member
until someone is invited.

| | |
|---|---|
| **URL** | https://buzz.jupitertech.net (web and relay; `/pair-relay` for mobile QR pairing), plus `relay.jupitertech.net` |
| **Images** | `ghcr.io/block/buzz:main` (relay and pairing relay), MinIO (the operator's default image), CloudNativePG Postgres 18 |
| **Namespace** | `buzz` |
| **Storage** | `buzz-db`, a 2-instance CloudNativePG cluster (5Gi each), and the `buzz-minio` Tenant (4 × 5Gi) for media |
| **Backups** | WAL archiving and daily base backups to the in-cluster MinIO (7-day retention), plus Longhorn's NAS backups |
| **Depends on** | CloudNativePG operator, MinIO Operator, the shared `redis` app, cnpg-backups MinIO, Longhorn, Gateway |

## How it's deployed

One Argo CD Application with three sources (see `app.yaml`):

```
github.com/block/buzz ── deploy/charts/buzz ──┐  relay + pairing relay
                                              ├──► Application "buzz"
this folder ── values.yaml ($values ref) ─────┤  chart settings
this folder ── *.yaml via sops-kustomize ─────┘  namespace, DB, MinIO, secrets, policy
```

The relay talks to Postgres for state, Redis for pub/sub and caching, and
MinIO (S3 API) for uploaded media. `DATABASE_URL` and `REDIS_URL` come from
`secret-relay.sops.yaml`.

## Files

| File | What it is |
|---|---|
| `app.yaml` | Argo CD Application: chart + values + this folder |
| `values.yaml` | Helm values for the upstream chart |
| `kustomization.yaml` | Lists the manifests below |
| `namespace.yaml` | Namespace with PSA `restricted` |
| `networkpolicy.yaml` | Default deny, then one rule per allowed flow (20 policies) |
| `secret-relay.sops.yaml` | Relay Nostr identity key, git hook HMAC secret, DB and Redis URLs |
| `monitoring.yaml` | PodMonitors for the database and MinIO |
| `secret-db.sops.yaml` | Credentials for the `buzz` database role |
| `secret-db-backup.sops.yaml` | S3 credentials for the database backup bucket |
| `database.yaml` | CloudNativePG `Cluster` `buzz-db` with Barman backups |
| `database-backup.yaml` | `ScheduledBackup`: daily base backup at 04:30 |
| `secret-minio.sops.yaml` | MinIO Tenant root credentials (also the relay's S3 keys) |
| `secret-minio-metrics.sops.yaml` | Scoped bearer token for MinIO's metrics endpoint |
| `minio-tenant.yaml` | Single-server MinIO Tenant `buzz-minio` |
| `job-minio-bucket.yaml` | PostSync hook that creates the `buzz-media` bucket |

The HTTPRoutes for `buzz.jupitertech.net` and `relay.jupitertech.net` still
live in the gateway app. They move here in a follow-up.

## Gotchas

- **Chart and image both float on `main`.** Upstream has no commit with both
  the chart and a published image yet, and an older pinned image didn't match
  the current schema. Argo CD follows upstream `main` and syncs on its own.
- **Git scratch storage is an `emptyDir`, not a PVC.** The chart hardcodes a
  `RollingUpdate` with `maxUnavailable: 0`, which deadlocks on an RWO volume
  at every rollout.
- **Migrations run as a pre-upgrade Job.** `migrate.autoMigrate` alone never
  created the schema.
- **The MinIO Service is called `minio`**, whatever the Tenant is named, and
  listens on port 80.
- **The relay's private key is its identity.** Rotating
  `BUZZ_RELAY_PRIVATE_KEY` changes who the relay is to every client.
- **MinIO's metrics endpoint needs a bearer token** from
  `mc admin prometheus generate`, and its Services carry no labels, so it's
  scraped with a PodMonitor rather than a ServiceMonitor.

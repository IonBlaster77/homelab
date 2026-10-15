# CloudNativePG

The PostgreSQL operator. Each database in the homelab is a `Cluster` object
that lives with its app; the operator turns it into a primary + replica pair
of Postgres pods with volumes, failover, connection Services
(`<name>-rw` / `-ro` / `-r`) and generated credentials.

| Database | Defined in | Instances |
|---|---|---|
| `authentik-db` | [`../../security/authentik/cluster-authentik-db.yaml`](../../security/authentik/cluster-authentik-db.yaml) | 2 |
| `grafana-db` | [`../../observability/monitoring/cluster-grafana-db.yaml`](../../observability/monitoring/cluster-grafana-db.yaml) | 2 |
| `kea-db` | [`../../../apps/network/kea/database.yaml`](../../../apps/network/kea/database.yaml) | 2 |

| | |
|---|---|
| **Chart** | [`cloudnative-pg`](https://github.com/cloudnative-pg/charts) from `cloudnative-pg.github.io/charts`, version pinned in `app.yaml` |
| **Namespace** | `cnpg-system` (the operator only; databases live with their apps) |
| **Storage** | None for the operator. Database volumes: 2 × 5Gi Longhorn per cluster, owned by each `Cluster` |
| **Depends on** | Longhorn |

## Files

| File | What it is |
|---|---|
| `app.yaml` | Argo CD Application: the upstream chart plus this repo as `$values`. Server-Side Apply |
| `values.yaml` | Tolerate the control-plane taint so the operator can run on any node |

## Gotchas

- **The chart ships the CRDs, including `Cluster`.** Deleting that CRD
  deletes every database in the cluster. This app still has `prune: true`;
  check any chart upgrade's rendered CRD list before syncing.
- **Exactly one operator.** A second, forgotten operator (installed in
  `default` in April) fought this one over the webhook certificate in
  October 2026 and caused x509 errors on every database change. If CNPG
  webhook TLS errors come back, look for a duplicate operator first
  (`kubectl get deploy -A -l app.kubernetes.io/name=cloudnative-pg`).
- **The operator injects the webhook `caBundle` itself.** With Server-Side
  Apply, Argo CD doesn't own that field, so it never resets it.
- **No database-native backups yet.** The databases are covered only by
  Longhorn's NAS backups of their volumes. CNPG can also back up via volume
  snapshots (see the `volumesnapshot-*` apps); the NAS has no S3, so the
  barman/object-store method isn't an option.
- **Upgrade the operator before the database images,** and read the CNPG
  release notes: some versions require a rolling restart of every cluster.

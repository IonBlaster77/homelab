# Loki

Grafana Loki stores and searches the cluster's logs. Unlike a full-text
search engine it indexes only **labels** (namespace, pod, node, job...) and
keeps the log lines compressed in chunks, so it's cheap to run. Queries use
LogQL, e.g. `{namespace="media", pod=~"jellyfin.*"} |= "error"`.

| | |
|---|---|
| **URL** | None directly. In-cluster `loki.logging.svc:3100`; browse it through Grafana's Explore view |
| **Chart** | [`loki`](https://github.com/grafana/loki/tree/main/production/helm/loki) from `grafana.github.io/helm-charts`, version pinned in `app.yaml` |
| **Namespace** | `logging` (shared with Alloy, which owns the namespace manifest) |
| **Storage** | `storage-loki-0`, 20Gi Longhorn (`longhorn-ssd`), from the StatefulSet template: chunks + TSDB index |
| **Depends on** | Longhorn. Fed by Alloy; read by Grafana and infra-mcp |

## Files

| File | What it is |
|---|---|
| `app.yaml` | Argo CD Application: the upstream chart plus this repo as `$values`. Uses Server-Side Apply |
| `values.yaml` | Single-binary mode, filesystem storage, TSDB schema v13, 30-day retention, everything else disabled |

There are no manifests here: everything comes from the chart.

## Gotchas

- **Single-binary on filesystem storage, on purpose.** The scalable
  read/write/backend modes need object storage and several GB of RAM; this
  homelab doesn't need them. Scaling up later means object storage first.
- **Retention is enforced by the compactor** (`retention_enabled: true`,
  `retention_period: 720h`). Without the compactor setting, the period alone
  deletes nothing.
- **Logs older than 7 days are rejected on ingest** (`reject_old_samples`),
  so backfilling old logs won't work.
- **Don't change `schemaConfig` in place.** To move to a new schema, add a
  new entry with a future `from:` date and keep the old one.
- **No auth** (`auth_enabled: false`): anything that can reach port 3100 can
  read and write logs. Network policy is what limits it.
- **Server-Side Apply** is required by this chart's large objects; keep the
  `ServerSideDiff` annotation with it.

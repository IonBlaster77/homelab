# Langfuse

Tracing and token/cost analytics for the agents: Hermes (official plugin),
Claude Code (Stop hook), Codex and Pi. Plan and decisions:
[`docs/projects/agent-observability.md`](../../../../docs/projects/agent-observability.md)
(task #50, phase 2).

**Status: running, LAN-only** at https://langfuse.jupitertech.net (chart
2.1.6 / Langfuse 4.63.0). Sign-in is the seeded admin (email and password in
`langfuse-secrets`, keys `init-user-email` / `init-user-password`); sign-up is
disabled. Authentik sign-in and Cloudflare Access come next.

The `agents` project's API keys (`init-project-public-key` /
`init-project-secret-key`) are what Hermes and the Claude Code hook report
with.

| | |
|---|---|
| **Namespace** | `langfuse` (PSA `restricted`, default-deny) |
| **ClickHouse** | `clickhouse` StatefulSet, 26.4.5.143 by digest, single node, 20Gi `longhorn-ssd`. User `langfuse` (password in `clickhouse-users`); the built-in `default` user only from localhost |
| **Postgres** | `langfuse-db` (CNPG, 2 × 5Gi `longhorn-nvme`), point-in-time recovery to `s3://cnpg/langfuse-db/`, daily base backup 15:50 UTC |
| **Object storage** | RustFS bucket `langfuse`, key `app-langfuse` (`langfuse-s3`), full access to that bucket only |
| **Redis** | The shared Sentinel HA Redis, as ACL user `langfuse` (keys `langfuse:*` only; `REDIS_KEY_PREFIX` covers the cache and the BullMQ queues) |
| **App** | `langfuse-web` + `langfuse-worker`, Docker Hub images by digest (through Harbor), UID 1001, no service-account token. Telemetry off. Batch export and media upload off (they'd hand browsers presigned URLs to the in-cluster S3 endpoint) |

## Why a hand-built ClickHouse

Since chart v2, the chart's bundled ClickHouse needs the ClickHouse operator
installed cluster-wide plus a 3-node ClickHouse Keeper ensemble: by default
about 1.75 CPU and 160Gi of disk. Langfuse documents a single-container mode
(`CLICKHOUSE_CLUSTER_ENABLED=false`, no Keeper). It's community-supported and
has no redundancy, which is fine here: traces are useful but not critical.
Durability is Longhorn's (3 replicas, hourly/daily NAS backups).

ClickHouse's system log tables are trimmed (query and part logs keep 7 days;
metric, trace and text logs are off). They're the usual way a small
ClickHouse fills its disk.

## Files

| File | What it is |
|---|---|
| `app.yaml` | Argo CD Application. The Langfuse chart is added as a second source next |
| `namespace.yaml` | PSA `restricted` |
| `networkpolicy.yaml` | Default-deny; free traffic inside the namespace; langfuse-db's operator, API server, RustFS and Prometheus access |
| `secret-clickhouse.sops.yaml` | `clickhouse-users`: the users.d XML (SHA-256 only) plus the plaintext password for Langfuse |
| `configmap-clickhouse.yaml` | Server settings: listen, UTC, warning-level logs, trimmed system logs |
| `statefulset-clickhouse.yaml`, `service-clickhouse.yaml` | ClickHouse, ports 8123 (HTTP) and 9000 (native) |
| `cluster-langfuse-db.yaml`, `podmonitor-langfuse-db.yaml` | Postgres and its metrics |
| `secret-langfuse-db-backup.sops.yaml`, `objectstore-langfuse-db.yaml`, `scheduledbackup-langfuse-db.yaml` | Point-in-time recovery, as for every CNPG cluster |
| `secret-langfuse-s3.sops.yaml` | Langfuse's RustFS key |

## Handy commands

```bash
# ClickHouse up, UTC, and the langfuse user's grants
kubectl -n langfuse exec clickhouse-0 -- clickhouse-client -q "SELECT version(), timezone()"
kubectl -n langfuse exec clickhouse-0 -- clickhouse-client -q "SHOW GRANTS FOR langfuse"
```

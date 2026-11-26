# Streamystats

Watch statistics and recommendations for Jellyfin: who watched what and when,
library stats, and "more like this" suggestions. Recommendations use text
embeddings generated locally by Ollama, so library metadata and watch history
never leave the cluster.

| | |
|---|---|
| **URL** | https://streamystats.jupitertech.net (web UI, via the Gateway) |
| **Images** | `ghcr.io/fredrikburmester/streamystats-nextjs` and `-job-server`, `ghcr.io/cloudnative-pg/postgresql` (`standard`), `ollama/ollama` |
| **Namespace** | `streamystats` |
| **Storage** | `streamystats-db-1`/`-2`, 5Gi Longhorn (`longhorn-nvme`) each, the CNPG database. `ollama-models`, 20Gi Longhorn (`longhorn-ssd`), the embedding model, re-downloadable |
| **Backups** | WAL archive + daily base backup to RustFS `s3://cnpg/streamystats-db/` (14 days point-in-time recovery), plus the Longhorn NAS backups |
| **Depends on** | Jellyfin (`media` namespace), Gateway (`homelab-gateway`), CloudNativePG + Barman Cloud plugin, RustFS, Longhorn, the sops-kustomize plugin |

## Components

| Component | Files | What it does |
|---|---|---|
| Web UI | `deployment.yaml`, `service.yaml`, `httproute.yaml`, `referencegrant.yaml` | Next.js dashboard; also validates the Jellyfin API key directly |
| Job server | `deployment-job-server.yaml`, `service-job-server.yaml` | Scheduled syncs from Jellyfin (activity, items, users), embeddings, cleanup. In-cluster only |
| Database | `cluster-streamystats-db.yaml`, `podmonitor-streamystats-db.yaml`, `objectstore-streamystats-db.yaml`, `scheduledbackup-streamystats-db.yaml`, `secret-streamystats-db-backup.sops.yaml` | CloudNativePG, PostgreSQL 18 with pgvector: app data and the embedding vectors. Credentials in the CNPG-generated `streamystats-db-app` secret (`uri` is the apps' `DATABASE_URL`) |
| Old database | `statefulset-vectorchord.yaml`, `service-vectorchord.yaml` | The previous PostgreSQL 17 + VectorChord server, unused since 2026-11-26 and kept only as a rollback. Remove after a clean run (see below) |
| Embeddings | `deployment-ollama.yaml`, `service-ollama.yaml`, `pvc-ollama.yaml` | CPU-only Ollama serving `nomic-embed-text` over an OpenAI-compatible API |

Shared: `namespace.yaml`, `secret.sops.yaml` (session and Next.js keys, and
the old server's password; SOPS/age encrypted), `networkpolicy.yaml`
(default-deny plus an allow per path between the components, the database,
Jellyfin, the Gateway, Homepage and the internet). `app.yaml` and
`kustomization.yaml` as usual.

## Gotchas

- **pgvector needs the CNPG `standard` image**, not `system` (which the older
  clusters use) or `minimal`. Streamystats' migrations create `vector`,
  `uuid-ossp` and `pg_trgm`; it never used VectorChord (`vchord`). After a
  minor image bump, `ALTER EXTENSION vector UPDATE;` moves the catalog to
  the new pgvector.
- **Moved from the vectorchord StatefulSet on 2026-11-26** with a CNPG
  `microservice` import (PG17 -> PG18): all 35 tables matched row for row.
  The `bootstrap` and `externalClusters` sections of the Cluster only ran at
  creation. Pre-move copies: Longhorn snapshot and VolumeSnapshot
  `streamystats-pre-cnpg-20261126`.
- **Removing the old server** (after a clean run): drop
  `statefulset-vectorchord.yaml`, `service-vectorchord.yaml`, the
  `vectorchord` rules in `networkpolicy.yaml` (including the import egress
  in `streamystats-db-allow-clients`), the `externalClusters` entry, and
  `POSTGRES_PASSWORD`/`DATABASE_URL` from `secret.sops.yaml`. Argo prunes the
  StatefulSet but not its PVC `data-vectorchord-0`: delete that by hand.
- **RustFS admits each CNPG cluster by name**
  (`platform/storage/rustfs/networkpolicy.yaml`). Without the entry, WAL
  archiving times out and a new replica sits in recovery retrying the
  archive instead of streaming.
- **Don't rotate `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`** casually; it logs
  every user out.
- **The model is pulled by a `postStart` hook.** It's a small model and lands
  on the PVC, so later starts are quick. Don't use this pattern for big models:
  kubelet kills long postStart hooks, which causes a restart loop.
- **The web UI needs its own egress to Jellyfin**, not just via the job
  server, because it validates the API key itself.

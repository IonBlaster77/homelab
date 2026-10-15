# Streamystats

Watch statistics and recommendations for Jellyfin: who watched what and when,
library stats, and "more like this" suggestions. Recommendations use text
embeddings generated locally by Ollama, so library metadata and watch history
never leave the cluster.

| | |
|---|---|
| **URL** | https://streamystats.jupitertech.net (web UI, via the Gateway) |
| **Images** | `ghcr.io/fredrikburmester/streamystats-nextjs` and `-job-server`, `tensorchord/vchord-postgres`, `ollama/ollama` |
| **Namespace** | `streamystats` |
| **Storage** | `data-vectorchord-0`, 10Gi Longhorn (`longhorn-ssd`), the database, from the StatefulSet template. `ollama-models`, 20Gi Longhorn (`longhorn-ssd`), the embedding model, re-downloadable |
| **Depends on** | Jellyfin (`media` namespace), Gateway (`homelab-gateway`), Longhorn, the sops-kustomize plugin |

## Components

| Component | Files | What it does |
|---|---|---|
| Web UI | `deployment.yaml`, `service.yaml`, `httproute.yaml`, `referencegrant.yaml` | Next.js dashboard; also validates the Jellyfin API key directly |
| Job server | `deployment-job-server.yaml`, `service-job-server.yaml` | Scheduled syncs from Jellyfin (activity, items, users), embeddings, cleanup. In-cluster only |
| Database | `statefulset-vectorchord.yaml`, `service-vectorchord.yaml` | PostgreSQL 17 + VectorChord: app data and the embedding vectors |
| Embeddings | `deployment-ollama.yaml`, `service-ollama.yaml`, `pvc-ollama.yaml` | CPU-only Ollama serving `nomic-embed-text` over an OpenAI-compatible API |

Shared: `namespace.yaml`, `secret.sops.yaml` (DB password and URL, session
and Next.js keys; SOPS/age encrypted), `networkpolicy.yaml` (default-deny plus
an allow per path between the components, Jellyfin, the Gateway, Homepage and
the internet). `app.yaml` and `kustomization.yaml` as usual.

## Gotchas

- **The database is a plain StatefulSet, not CNPG.** CNPG needs images built
  on its own base; the VectorChord image is upstream Postgres. So it gets
  none of CNPG's backups: it relies on the Longhorn NAS backups.
- **VectorChord is pinned to `pg17-v0.4.1`** on purpose. The extension API
  changed in 1.x and Streamystats' schema targets 0.4.x.
- **`DATABASE_URL` embeds `POSTGRES_PASSWORD`.** Rotate them together.
- **Don't rotate `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`** casually; it logs
  every user out.
- **The model is pulled by a `postStart` hook.** It's a small model and lands
  on the PVC, so later starts are quick. Don't use this pattern for big models:
  kubelet kills long postStart hooks, which causes a restart loop.
- **The web UI needs its own egress to Jellyfin**, not just via the job
  server, because it validates the API key itself.

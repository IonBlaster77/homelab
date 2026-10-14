# Cognee

Self-hosted long-term memory for AI agents. The Cognee MCP server builds a
knowledge graph and vector index from what agents tell it to remember, and
answers recall queries over MCP. Hermes uses it in-cluster. Everything runs
locally: no cloud LLM or vector database.

| | |
|---|---|
| **URL** | https://cognee.jupitertech.net (Gateway), plus `cognee-mcp.cognee:8000` in-cluster |
| **Images** | `cognee/cognee-mcp`, `ollama/ollama`, CloudNativePG Postgres 18 with the pgvector extension image |
| **Namespace** | `cognee` |
| **Storage** | `cognee-db`, a 2-instance CloudNativePG cluster on Longhorn (5Gi each), and `cognee-ollama-models` (30Gi Longhorn) |
| **Backups** | WAL archiving and daily base backups to the in-cluster MinIO (7-day retention), plus Longhorn's NAS backups |
| **Depends on** | CloudNativePG operator, Longhorn, cnpg-backups MinIO, Streamystats' Ollama (embeddings), Gateway |

## How it fits together

```
Hermes / Gateway ──► cognee-mcp ──► cognee-db       (graph, vectors, sessions, metadata)
                          │
                          ├──► cognee-ollama        (LLM: qwen2.5:7b-instruct)
                          └──► streamystats ollama  (embeddings: nomic-embed-text)
```

## Files

| File | What it is |
|---|---|
| `app.yaml` | Argo CD Application for this folder |
| `kustomization.yaml` | Lists the manifests below |
| `namespace.yaml` | Namespace |
| `networkpolicy.yaml` | Default deny, then one rule per allowed flow (19 policies) |
| `secret-db.sops.yaml` | SOPS-encrypted credentials for the `cognee` database role |
| `secret-db-backup.sops.yaml` | SOPS-encrypted S3 credentials for the MinIO backup bucket |
| `database.yaml` | CloudNativePG `Cluster` `cognee-db` with pgvector and Barman backups |
| `database-backup.yaml` | `ScheduledBackup`: daily base backup at 04:00 |
| `monitoring.yaml` | PodMonitor scraping the database's metrics |
| `deployment-mcp.yaml` | The Cognee MCP server and all its provider settings |
| `service-mcp.yaml` | ClusterIP for the MCP server |
| `httproute.yaml` | `cognee.jupitertech.net` → `cognee-mcp` (lives in the `networking` namespace) |
| `referencegrant.yaml` | Lets that cross-namespace route reach `cognee-mcp` |
| `pvc-ollama.yaml` | Model storage for the dedicated Ollama |
| `deployment-ollama.yaml` | Ollama serving the LLM, pinned to the worker node `talos4` |
| `service-ollama.yaml` | ClusterIP for Ollama |

## Gotchas

- **The `cognee` role is a superuser with `CREATEDB`.** Cognee creates a
  database per dataset and runs `CREATE EXTENSION vector` in each. That's
  acceptable only because this CNPG cluster is dedicated to Cognee.
- **Cognee needs each database host set three times.** `DB_*`, `GRAPH_DATABASE_*`
  and `VECTOR_DB_*` are separate config fields with no fallback between them,
  and unset ones default to localhost.
- **`MCP_ALLOWED_HOSTS` is required.** The MCP SDK rejects non-loopback `Host`
  headers with 421 unless they're allowlisted, and port-forward testing hides
  this.
- **Gateway traffic arrives with Cilium's `ingress` identity**, so the policy
  uses `fromEntities: ingress`, not a namespace selector. Policy ports are pod
  ports, because kube-proxy replacement DNATs before policy is enforced.
- **Models are pulled by hand**, with a one-off `ollama pull` against the
  Service. A `postStart` hook gets killed by kubelet before a multi-GB pull
  finishes, which causes a restart loop.
- **Ollama has a `hostAliases` pin for `registry.ollama.ai`.** The cluster has
  no IPv6 egress, and Go's dialer hung on the AAAA record instead of falling
  back to IPv4.
- **The LLM is swappable; the embedding model is not.** Changing
  `EMBEDDING_MODEL` invalidates every stored vector.

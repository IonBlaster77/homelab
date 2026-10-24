# RustFS

S3-compatible object storage, **single node, in-cluster only.** It holds the
CNPG clusters' WAL archives and base backups (Barman Cloud plugin) and, later,
Langfuse's event and media storage. Plan and decisions:
[`docs/projects/agent-observability.md`](../../../../docs/projects/agent-observability.md)
(task #50).

| | |
|---|---|
| **URL** | None. In-cluster only. S3 API: `http://rustfs.rustfs.svc.cluster.local:9000` (path-style addressing) |
| **Console** | Port 9001, no HTTPRoute: `kubectl -n rustfs port-forward svc/rustfs 9001` then http://localhost:9001 |
| **Image** | `rustfs/rustfs:1.0.3`, pinned by digest |
| **Namespace** | `rustfs` (PSA `restricted`) |
| **Storage** | `rustfs-data`, 50Gi Longhorn `longhorn-ssd` (3 replicas) |
| **Credentials** | `rustfs-root` (SOPS): the root access/secret key, for administration only |
| **Depends on** | Longhorn, the sops-kustomize plugin |

## How it's protected

RustFS is one pod with no replication of its own, so its durability is
Longhorn's:

- **In the cluster:** three Longhorn replicas on different nodes. Never move
  `rustfs-data` to a single-copy class (`longhorn-local`, `longhorn-nvme-single`).
- **Off the cluster:** the volume is in Longhorn's `default` recurring-job group,
  so it's backed up to the NAS hourly (keep 24) and daily (keep 30). Check with
  `kubectl get volumes.longhorn.io -n longhorn-system -L recurring-job-group.longhorn.io/default`.
- **What that means for the databases:** point-in-time recovery to any moment
  while the cluster is alive. After losing the whole cluster, restore this
  volume from the NAS first; recovery then reaches the last hourly backup.

**Why not on the NAS or over NFS:** the Synology can't run containers, and an
object store on NFS gets neither the local-disk semantics it needs nor safety
from the hard-NFS hang (see the NAS runbook). Both settled 2026-10-24.

## Files

| File | What it is |
|---|---|
| `app.yaml` | Argo CD Application for this folder. Server-Side Apply |
| `kustomization.yaml` | Lists the manifests below |
| `namespace.yaml` | Namespace with Pod Security `restricted` |
| `secret.sops.yaml` | `rustfs-root`: root access and secret key (SOPS/age encrypted) |
| `pvc.yaml` | `rustfs-data`, the object data |
| `deployment.yaml` | One pod, `Recreate` (RWO volume), UID 10001, read-only root filesystem |
| `service.yaml` | `rustfs`: 9000 (S3) and 9001 (console) |
| `networkpolicy.yaml` | Default-deny; DNS only. Clients are admitted one policy each |

## Bucket lifecycle rules

Lifecycle rules are bucket state, not in git. Re-apply them after rebuilding a
bucket (`PUT /<bucket>?lifecycle` with the root key and a `Content-MD5` header).

| Bucket | Rule | Why |
|---|---|---|
| `langfuse` | `expire-raw-events`: `events/` after 7 days | Raw ingestion blobs; traces live in ClickHouse, pruned after 30 days by `langfuse/trace-retention` |

## Adding a client

1. Create a bucket and a **dedicated access key** with a policy limited to that
   bucket (never hand out the root key).
2. Store the client's key as a SOPS secret in the *client's* folder.
3. Admit the client here with a policy like this:

```yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: rustfs-allow-ingress-from-<client>
  namespace: rustfs
spec:
  endpointSelector:
    matchLabels:
      app: rustfs
  ingress:
    - fromEndpoints:
        - matchLabels:
            io.kubernetes.pod.namespace: <client-namespace>
      toPorts:
        - ports:
            - port: "9000"
              protocol: TCP
```

The client's own namespace also needs an egress policy to
`rustfs/app=rustfs` on 9000, if it is default-deny.

# Redis

A single Redis instance: an in-memory key-value store, typically used by apps
as a cache, job queue or session store. It has no clients right now (Buzz, the
only one, was decommissioned 2026-10-14). It is kept as shared infrastructure
for future apps and as something to learn from.

| | |
|---|---|
| **URL** | None. In-cluster only: `redis.redis.svc.cluster.local:6379` (or `redis-0.redis.redis.svc.cluster.local`) |
| **Image** | `redis:8-alpine`, plus the `oliver006/redis_exporter` sidecar |
| **Namespace** | `redis` (PSA `restricted`) |
| **Storage** | `data-redis-0`, 4Gi Longhorn (`longhorn-ssd`) RWO, from the StatefulSet's volumeClaimTemplate |
| **Depends on** | Longhorn, the sops-kustomize plugin (password secret), kube-prometheus-stack (ServiceMonitor) |

## Files

| File | What it is |
|---|---|
| `app.yaml` | Argo CD Application for this folder |
| `kustomization.yaml` | Lists the manifests below |
| `namespace.yaml` | Namespace with Pod Security `restricted` |
| `secret.sops.yaml` | `redis-credentials`: the password (SOPS/age encrypted) |
| `statefulset.yaml` | Redis plus the metrics exporter sidecar; AOF persistence; the comments explain the design choices |
| `service.yaml` | Headless Service: 6379 (Redis) and 9121 (metrics) |
| `servicemonitor.yaml` | Tells Prometheus to scrape the exporter |
| `networkpolicy.yaml` | Default-deny, DNS egress, and Prometheus ingress on 9121 |

## Adding a client

The namespace is default-deny, so nothing can reach port 6379 until you admit
it. Add a policy like this to `networkpolicy.yaml` (6379 is the pod's port;
Cilium enforces after the Service DNAT, so always use the container port):

```yaml
---
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: redis-allow-ingress-from-<app>
  namespace: redis
spec:
  endpointSelector:
    matchLabels:
      app: redis
  ingress:
    - fromEndpoints:
        - matchLabels:
            io.kubernetes.pod.namespace: <app-namespace>
            app: <app-label>
      toPorts:
        - ports:
            - port: "6379"
              protocol: TCP
```

The client also needs the password. Give it its own copy of the secret in its
namespace (Secrets can't be read across namespaces). Give each app its own
logical database number (`redis://...:6379/<n>`) or key prefix so they don't
collide.

## Gotchas

- **Restart by deleting the pod** (`redis-0`), never `kubectl rollout restart`:
  that edits the spec and Argo's selfHeal reverts it.
- **The password goes on the command line through a shell wrapper.** Redis
  flags can't read a Secret, so the container runs `sh -c` and expands
  `$REDIS_PASSWORD`. The probes use `REDISCLI_AUTH` so the password never
  appears in a probe command.
- **Single replica, no HA.** If talos node maintenance moves the pod, Redis is
  down until the RWO volume reattaches. That's fine with no clients; revisit
  (replica + Sentinel) before anything important depends on it.

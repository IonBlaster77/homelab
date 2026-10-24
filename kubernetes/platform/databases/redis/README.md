# Redis

Highly available Redis: **3 pods, each running Redis + Sentinel, each on a
different node.** One pod is the primary (takes writes), two are live replicas,
and Sentinel promotes a replica automatically if the primary dies. Shared
infrastructure for apps that need a cache, job queue or session store:
Harbor (default user) and Langfuse (its own ACL user).

| | |
|---|---|
| **URL** | None. In-cluster only. Clients use Sentinel: `redis-sentinel.redis.svc.cluster.local:26379`, master name **`mymaster`** |
| **Image** | `redis:8.10.2-alpine` (Redis and Sentinel), plus the `oliver006/redis_exporter` sidecar |
| **Namespace** | `redis` (PSA `restricted`) |
| **Storage** | One 4Gi Longhorn (`longhorn-ssd`) PVC per pod: `data-redis-0/1/2` |
| **Depends on** | Longhorn, the sops-kustomize plugin (password secret), kube-prometheus-stack (ServiceMonitor) |

## How it works

1. **Replication.** The primary streams every write to the two replicas,
   asynchronously. Replicas are read-only copies.
2. **Sentinel.** Each pod also runs a Sentinel. All three watch the primary.
   If it doesn't answer for **5 seconds** and **2 of 3** Sentinels agree
   (the quorum), they elect a leader, promote a replica to primary and
   repoint the other replica at it. Failover takes roughly 5-15 seconds.
3. **Clients follow the primary** by asking Sentinel. A Sentinel-aware client
   is given `redis-sentinel...:26379` and `mymaster`; it asks "who is the
   primary?", connects there on 6379, and re-asks after a failover.
4. **Bootstrap** (the `config` init container): a starting pod asks the other
   pods' Sentinels who the primary is and replicates it. If nobody answers
   (a cold start), `redis-0` becomes primary and the others replicate it.
   Pods start one at a time (`OrderedReady`), `redis-0` first.
5. **Stable names, not IPs.** Pods find and announce each other by their
   StatefulSet DNS names (`redis-N.redis.redis.svc.cluster.local`), with
   Sentinel's `resolve-hostnames` / `announce-hostnames` on, so a pod that
   comes back with a new IP is still the same member.
6. **One pod per node** is a hard rule (required pod anti-affinity on the
   hostname): the scheduler refuses to co-locate two Redis pods. With 4
   nodes, losing any one node costs at most one Redis. The PodDisruptionBudget
   lets drains/upgrades take down only one pod at a time.

## Files

| File | What it is |
|---|---|
| `app.yaml` | Argo CD Application for this folder. Server-Side Apply |
| `kustomization.yaml` | Lists the manifests below |
| `namespace.yaml` | Namespace with Pod Security `restricted` |
| `secret.sops.yaml` | `redis-credentials`: the password (SOPS/age encrypted), shared by Redis, replication and Sentinel |
| `statefulset.yaml` | 3 pods: `config` init container (role discovery), `redis`, `sentinel`, `redis-exporter`; the comments explain each choice |
| `service.yaml` | Headless `redis` (stable pod DNS; 6379, 26379, 9121) and `redis-sentinel` (26379, what clients use) |
| `poddisruptionbudget.yaml` | At most one pod down at a time for voluntary disruptions |
| `servicemonitor.yaml` | Prometheus scrapes each pod's exporter |
| `networkpolicy.yaml` | Default-deny; the pods talk to each other on 6379/26379; Prometheus on 9121 |

## Handy commands

```bash
# Who is the primary right now?
kubectl exec -n redis redis-0 -c sentinel -- redis-cli -p 26379 sentinel get-master-addr-by-name mymaster
# Replication view from the primary (role, connected replicas, offsets)
kubectl exec -n redis redis-0 -c redis -- sh -c 'REDISCLI_AUTH=$REDIS_PASSWORD redis-cli info replication'
# What each Sentinel knows (replicas, other sentinels, quorum)
kubectl exec -n redis redis-0 -c sentinel -- redis-cli -p 26379 sentinel replicas mymaster
```

## Adding a client

The namespace is default-deny. A Sentinel-aware client needs **both** ports:
26379 (to ask Sentinel) and 6379 (to talk to the primary it is pointed at).
Add a policy like this to `networkpolicy.yaml` (container ports; Cilium
enforces after the Service DNAT):

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
            - port: "26379"
              protocol: TCP
```

**Give a new client its own ACL user, not the default password** (Langfuse is
the example). Add a key to `secret.sops.yaml`, an env var for it in the
`config` init container, and a `user <name> on >$PW ~<prefix>:* &* +@all -flushall
-flushdb ...` line in the generated `redis.conf` (`statefulset.yaml`). Then give
the app a copy of the password in its own namespace (Secrets can't be read
across namespaces) and set its key prefix to match. The user can then only
touch its own keys, and can't wipe or reconfigure the server. ACL users aren't
replicated, which is why every pod's config defines them. Adding one
rolling-restarts all three pods (one at a time, with a failover for the
primary).

Harbor predates this and uses the default user. Sentinel itself has no
password; only the network policy decides who can reach it.

| ACL user | App | Keys | Secret key |
|---|---|---|---|
| `langfuse` | Langfuse | `langfuse:*` | `langfuse-password` |

## Gotchas

- **Restart by deleting a pod**, never `kubectl rollout restart` (that edits
  the spec and Argo's selfHeal reverts it). Deleting the primary triggers a
  real failover: that is also how to test it.
- **A full cold start forgets who was primary.** Sentinel state lives in
  memory (its config is an emptyDir), so after every pod restarts at once
  (e.g. a power cut), `redis-0` becomes primary again even if another pod
  had newer data. Acceptable for caches and queues; know it before storing
  anything precious here.
- **Replication is asynchronous**: a failover can lose the last second or so
  of writes.
- **Needs 3 schedulable nodes.** The anti-affinity is required, so with
  fewer than 3 nodes available one pod stays Pending (by design).
- **Configs are generated at start**, by the `config` init container, into an
  in-memory emptyDir, so the password never lands on the PVC. Change settings
  in `statefulset.yaml`, not inside a running pod.

# kube-system

The `kube-system` namespace belongs to Talos (control-plane static pods,
bootstrap RBAC and so on). This app manages two things in it:

1. **CoreDNS, all of it** (Deployment, `kube-dns` Service, RBAC and the
   Corefile): DNS for every pod. Talos's copy is disabled
   (`cluster.coreDNS.disabled: true` in `talos/*.yaml`) since 2026-11-22.
2. **node-uncordon**: puts each node back into service after it boots.

| | |
|---|---|
| **URL** | None |
| **Images** | `registry.k8s.io/coredns/coredns`, `registry.k8s.io/kubectl` (init), `registry.k8s.io/pause` (node-uncordon) |
| **Namespace** | `kube-system` (exists already; `CreateNamespace=false`) |
| **Storage** | None |
| **Depends on** | AdGuard (primary DNS upstream), the router 10.77.20.1 (fallback) |

## Files

| File | What it is |
|---|---|
| `app.yaml` | Argo CD Application for this folder. Server-Side Apply |
| `kustomization.yaml` | Lists the manifests below |
| `configmap-coredns.yaml` | The Corefile: cluster names first, everything else forwarded to AdGuard (10.77.20.53), falling back to the router |
| `deployment-coredns.yaml` | CoreDNS itself: 2 replicas, image tracked by Renovate |
| `service-kube-dns.yaml` | The cluster DNS Service, pinned to 10.96.0.10 (every pod's resolver) |
| `rbac-coredns.yaml` | CoreDNS's ServiceAccount plus read-only list/watch on Services, EndpointSlices, Pods, Namespaces |
| `serviceaccount-`, `clusterrole-`, `clusterrolebinding-node-uncordon.yaml` | Permission to `get` and `patch` nodes, nothing else |
| `daemonset-node-uncordon.yaml` | One pod per node; its init container runs `kubectl uncordon <its node>`, then a tiny pause container keeps the pod present |

## Why node-uncordon exists

A graceful Talos shutdown (e.g. from a UPS or a planned power-off) cordons
the node, and nothing uncordons it on the way back up, so pods would never be
scheduled there again. Because node-uncordon is a DaemonSet, its pod restarts
on every boot, and its init container uncordons that node as it starts.
It tolerates every taint so it runs everywhere, at `system-node-critical`.

## Gotchas

- **Argo CD owns all of CoreDNS; Talos's copy is off.** Before 2026-11-22 Talos
  owned the Deployment and only the ConfigMap was here. Talos 1.13's
  `talosctl upgrade-k8s` re-applies every bootstrap manifest with server-side
  apply and would have reset the Corefile to stock on each Kubernetes upgrade,
  so ownership moved here. Consequences: CoreDNS versions come as Renovate PRs,
  not with Kubernetes upgrades; and never re-enable `cluster.coreDNS` in Talos
  without removing these files first, or the two will fight.
- **Never change the `kube-dns` clusterIP.** Every pod resolves through
  10.96.0.10; the field is immutable and a new IP breaks DNS cluster-wide.
- **`policy sequential` is essential.** Without it, CoreDNS load-balances
  between AdGuard and the router at random, and every query that hits the
  router gets NXDOMAIN for `*.jupitertech.net`.
- **Upstreams are IPs, not names:** CoreDNS can't resolve its own upstream.
- **Changes apply in ~45s** through CoreDNS's `reload` plugin; no restart.
- **Nodes themselves don't use this.** Talos nodes resolve via the router
  directly (`talos/*.yaml`), so a broken CoreDNS doesn't stop nodes booting.
- **A bad Corefile breaks DNS for every pod.** Test changes carefully, and
  watch `coredns_dns_responses_total{rcode="SERVFAIL"}` afterwards.

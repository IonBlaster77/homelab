# kube-system

The `kube-system` namespace belongs to Talos (it installs CoreDNS,
kube-proxy replacement settings, and so on). This app manages only two small
things in it that Talos doesn't:

1. **The CoreDNS config** (`configmap-coredns.yaml`): DNS for every pod.
2. **node-uncordon**: puts each node back into service after it boots.

| | |
|---|---|
| **URL** | None |
| **Images** | `registry.k8s.io/kubectl` (init), `registry.k8s.io/pause` (node-uncordon) |
| **Namespace** | `kube-system` (exists already; `CreateNamespace=false`) |
| **Storage** | None |
| **Depends on** | AdGuard (primary DNS upstream), the router 10.77.20.1 (fallback) |

## Files

| File | What it is |
|---|---|
| `app.yaml` | Argo CD Application for this folder. Server-Side Apply |
| `kustomization.yaml` | Lists the manifests below |
| `configmap-coredns.yaml` | The Corefile: cluster names first, everything else forwarded to AdGuard (10.77.20.53), falling back to the router |
| `serviceaccount-`, `clusterrole-`, `clusterrolebinding-node-uncordon.yaml` | Permission to `get` and `patch` nodes, nothing else |
| `daemonset-node-uncordon.yaml` | One pod per node; its init container runs `kubectl uncordon <its node>`, then a tiny pause container keeps the pod present |

## Why node-uncordon exists

A graceful Talos shutdown (e.g. from a UPS or a planned power-off) cordons
the node, and nothing uncordons it on the way back up, so pods would never be
scheduled there again. Because node-uncordon is a DaemonSet, its pod restarts
on every boot, and its init container uncordons that node as it starts.
It tolerates every taint so it runs everywhere, at `system-node-critical`.

## Gotchas

- **Only the ConfigMap is managed, not the CoreDNS Deployment.** Talos owns
  CoreDNS's version and may reset this ConfigMap to stock during
  `talosctl upgrade-k8s`; Argo CD's selfHeal puts it back.
- **`policy sequential` is essential.** Without it, CoreDNS load-balances
  between AdGuard and the router at random, and every query that hits the
  router gets NXDOMAIN for `*.jupitertech.net`.
- **Upstreams are IPs, not names:** CoreDNS can't resolve its own upstream.
- **Changes apply in ~45s** through CoreDNS's `reload` plugin; no restart.
- **Nodes themselves don't use this.** Talos nodes resolve via the router
  directly (`talos/*.yaml`), so a broken CoreDNS doesn't stop nodes booting.
- **A bad Corefile breaks DNS for every pod.** Test changes carefully, and
  watch `coredns_dns_responses_total{rcode="SERVFAIL"}` afterwards.

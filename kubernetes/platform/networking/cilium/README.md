# Cilium

The cluster's network. Cilium (eBPF) gives every pod its network and enforces
the `CiliumNetworkPolicy` rules, replaces kube-proxy, hands out and announces
**every LoadBalancer IP** on the LAN, implements the **Gateway API** behind the
shared Gateway, and provides Hubble for watching network flows.

If Cilium breaks, *everything* breaks at once: pod networking, AdGuard DNS
(10.77.20.53), the Gateway (10.77.20.60) and therefore remote access.

| | |
|---|---|
| **URL** | Hubble UI at https://hubble.jupitertech.net (via the Gateway) |
| **Chart** | Upstream `cilium` **1.17.0**, vendored in `chart/charts/` inside an umbrella chart |
| **Namespace** | `kube-system` (Helm release `cilium`, installed at bootstrap and adopted by Argo CD) |
| **Sync** | **Manual.** Nothing here changes the cluster until someone syncs this app |
| **Depends on** | Talos (KubePrism on localhost:7445), Gateway API CRDs |

## Files

| File | What it is |
|---|---|
| `app.yaml` | Argo CD Application, **manual sync**, two sources: `chart/` and this folder. Server-Side Apply plus a long, deliberate `ignoreDifferences` list |
| `chart/` | Umbrella chart: `Chart.yaml`/`Chart.lock` (cilium 1.17.0), the vendored `charts/cilium-1.17.0.tgz`, and `values.yaml` (all settings under `cilium:`) |
| `kustomization.yaml` | Lists this folder's own manifests (not `chart/`) |
| `ciliumloadbalancerippool.yaml` | `homelab-pool`: 10.77.20.50–99 for LoadBalancer Services (with the VLAN 20 address map) |
| `ciliuml2announcementpolicy.yaml` | How those IPs are announced on the LAN (ARP from one node per IP) |
| `ciliumbgppeeringpolicy.yaml` | BGP peering (control plane enabled; see its comments) |
| `httproute-hubble.yaml`, `referencegrant-hubble.yaml` | `hubble.jupitertech.net` → Hubble UI |

## Why an umbrella chart in git

Argo CD v3 fails to render charts from a Helm *repository* source with a
semver error ("improper constraint: HEAD"). A chart in git with a vendored
dependency and `Chart.lock` sidesteps it, and Argo CD never needs
helm.cilium.io at sync time.

## The two copies of the values

- `chart/values.yaml` is what Argo CD renders.
- `bootstrap/cilium-values.yaml` is what the bootstrap runbook uses for the
  very first `helm install`, before Argo CD exists.

They must hold the same settings (today they do: same keys, slightly
different order). Change both together.

## Gotchas

- **Never sync this app casually.** Before any sync, `argocd app diff cilium`
  must show exactly what you intend. To change only the IP pool, L2/BGP
  policy or the Hubble route, sync just those resources
  (`argocd app sync cilium --resource cilium.io:CiliumLoadBalancerIPPool:homelab-pool`).
- **Upgrading Cilium:** bump `chart/Chart.yaml`, `helm dependency update`,
  commit the new `.tgz` + `Chart.lock` (delete the old `.tgz`), update
  `bootstrap/cilium-values.yaml` if values change, review the diff, then sync.
  Keep the Gateway API CRD version compatible.
- **Restart the agent and Envoy together.** Restarting `cilium` pods alone can
  leave Envoy's proxy port out of step (a known Cilium bug).
- **`k8sServiceHost: localhost:7445` (KubePrism)**, not the control-plane VIP:
  this is what lets the datapath come up after a full power cut.
- **Network policies use container ports**, and Gateway traffic carries the
  `ingress` identity (`fromEntities: ingress`).
- **Never ping a LoadBalancer IP**; it won't answer ICMP. Test the service port.
- **certgen secrets** (`cilium-ca`, `hubble-*-certs`) render with fresh data
  every time; `ignoreDifferences` hides that, and certgen keeps the live certs.

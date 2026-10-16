# Home Assistant

Home automation hub and the control plane for the whole-home zoned audio
project ([docs/projects/zoned-audio.md](../../../../docs/projects/zoned-audio.md)).
It drives [Music Assistant](../music-assistant/) and talks to ESPHome nodes on
the LAN.

| | |
|---|---|
| **URL** | https://ha.jupitertech.net (Gateway, behind Cloudflare Access), plus `10.77.20.65:8123` on the LAN |
| **Image** | `ghcr.io/home-assistant/home-assistant` |
| **Namespace** | `home-assistant` |
| **Storage** | `home-assistant-config`, 10Gi Longhorn RWO, covered by the hourly/daily NAS backups |
| **Depends on** | Gateway (`homelab-gateway`), Longhorn, Cilium LB-IPAM (pinned LAN address) |

## Files

| File | What it is |
|---|---|
| `app.yaml` | Argo CD Application for this folder. Server-Side Apply |
| `kustomization.yaml` | Lists the manifests below |
| `namespace.yaml` | Namespace with PSA `baseline` (the image runs as root) |
| `pvc.yaml` | All of HA's state: `.storage`, the SQLite recorder DB, custom components |
| `configmap.yaml` | Seed `configuration.yaml` plus empty automations/scripts/scenes files |
| `deployment.yaml` | The server, `Recreate` strategy, with an init container that seeds the include files |
| `service.yaml` | ClusterIP for the Gateway and a pinned LoadBalancer (`10.77.20.65`) for LAN devices |
| `networkpolicy.yaml` | Default deny, then DNS, internet, LAN, Gateway, Homepage and Prometheus allowances |
| `httproute.yaml` | `ha.jupitertech.net` → the Service (lives in the `networking` namespace) |
| `referencegrant.yaml` | Lets that cross-namespace route reach the Service |

## Gotchas

- **`trusted_proxies` is mandatory behind the Gateway.** Without
  `use_x_forwarded_for` and the pod CIDR (`10.0.0.0/8`) as a trusted proxy,
  every request through the Gateway gets HTTP 400 "not allowed".
- **`configuration.yaml` is read-only by design.** It is mounted from the
  ConfigMap via `subPath`, so HA can't rewrite it, and a ConfigMap change needs
  a pod restart to take effect (Argo CD won't restart it for you). UI-managed
  state lives in `/config/.storage` on the PVC and is unaffected.
- **PSA `baseline`, not `restricted`.** The official image runs as root, so
  `restricted` would let the Deployment create while the ReplicaSet silently
  fails with `FailedCreate`.
- **`Recreate`, never `RollingUpdate`.** One RWO volume and one SQLite file:
  two pods must never run at once.
- **The LAN address is pinned.** ESP32 firmware and device configs hardcode
  `10.77.20.65`, so it must not move between Cilium restarts.
  `externalTrafficPolicy: Local` keeps real client IPs for HA's login banning.
- **Network policy ports are pod ports.** With kube-proxy replacement, Cilium
  sees the post-DNAT destination, so rules name `8123`. LAN traffic through the
  LoadBalancer doesn't carry the `ingress` identity, so it has its own rule. The
  LAN egress rule excludes the Kubernetes API VIP (`10.77.20.10`).

# Harbor

The homelab's container registry. Two jobs:

1. **Pull-through cache** for the public registries the cluster pulls from
   (Docker Hub, ghcr.io, quay.io, registry.k8s.io, ...). The first pull of an
   image fetches it from upstream and keeps a copy; later pulls are served
   locally. Protects against Docker Hub rate limits, internet outages and
   upstream images disappearing. Talos nodes use it as their registry mirror,
   with fallback to the real registry if Harbor is down.
2. **Private registry** for images built in-cluster (Argo Workflows).

| | |
|---|---|
| **URL** | https://registry.jupitertech.net (web UI + registry API). **LAN-only**: AdGuard rewrite, no Cloudflare record |
| **Chart** | [`harbor`](https://github.com/goharbor/harbor-helm) from `helm.goharbor.io`, version pinned in `kustomization.yaml` (`helmCharts`) |
| **Namespace** | `harbor` (PSA `restricted`) |
| **Storage** | Image store 150Gi `longhorn-nvme-single` (one replica, NVMe); Trivy cache 5Gi and job logs 1Gi on `longhorn-ssd` |
| **Database** | CloudNativePG `harbor-db` (2 × 5Gi NVMe), database `registry` |
| **Redis** | The HA Redis via Sentinel (`kubernetes/platform/databases/redis`, master `mymaster`, DB indexes 0, 1, 2, 5) |
| **Depends on** | CloudNativePG, Redis, Longhorn, Gateway, the sops-kustomize plugin with `--enable-helm`, AdGuard (DNS) |

## Files

| File | What it is |
|---|---|
| `app.yaml` | Argo CD Application: this folder through the sops-kustomize plugin. Server-Side Apply |
| `kustomization.yaml` | Renders the Harbor chart (`helmCharts`, values `values.yaml` + `values-secret.sops.yaml`) plus the manifests below |
| `values.yaml` | Chart values: exposure, secrets wiring, storage, external DB and Redis, scanning, metrics |
| `values-secret.sops.yaml` | Secret chart values (the Redis password), every value encrypted |
| `secret-harbor.sops.yaml` | `harbor-secrets`: fixed internal secrets, registry credentials, initial admin password |
| `secret-harbor-token.sops.yaml` | `harbor-token`: core's token-signing certificate and key |
| `namespace.yaml` | Namespace with Pod Security `restricted` |
| `cluster-harbor-db.yaml` | CloudNativePG cluster `harbor-db` (password generated into `harbor-db-app`) |
| `httproute.yaml`, `referencegrant.yaml` | `registry.jupitertech.net` → Harbor's nginx |
| `servicemonitor.yaml` | Prometheus scrapes Harbor's metrics (our own: see Gotchas) |
| `networkpolicy.yaml` | Default-deny; see below |

## Network policy

Default-deny. Harbor's components and its database talk freely inside the
namespace; the Gateway reaches only Harbor's nginx; core, jobservice,
registry and Trivy may reach **public** addresses on 443/80 (the upstream
registries and the Trivy vulnerability database); Harbor reaches Redis on
6379/26379; CloudNativePG gets operator and API access; Prometheus scrapes
port 8001.

## Gotchas

- **Every chart-generated secret is pinned.** The chart generates random
  secrets and a token certificate on each render and tries to keep them with
  Helm's `lookup()`, which doesn't work under Argo CD. Unpinned, every sync
  would rotate them. All are supplied from SOPS (`values.yaml`, "Secrets").
  `secretKey` encrypts credentials Harbor stores in its database: **never
  change it**, or stored upstream credentials become unreadable.
- **The Redis password is a chart value, not a Secret reference**, for the
  same `lookup()` reason (with `existingSecret` the Redis URLs came out with
  an empty password). It lives in `values-secret.sops.yaml`; if the Redis
  password ever changes, change it there too. It also ends up in Harbor's
  ConfigMaps in-cluster (the chart puts the Redis URLs there).
- **Rendered through Kustomize, not as a Helm source.** That's what lets the
  secret values file be decrypted. It needs `--enable-helm` in the
  sops-kustomize plugin (`bootstrap/argocd-cmp-sops-kustomize.yaml`).
  Renovate reads the chart version from `kustomization.yaml`.
- **Our own ServiceMonitor:** the chart's already has `release: harbor`, and
  adding `release: monitoring` made a duplicate YAML key Kustomize rejects.
- **The migration hook stays off** (`enableMigrateHelmHook: false`): under
  Argo it would be a PreSync Job. Harbor core migrates its schema at startup.
- **The image store has one replica.** If its node is down, pushes and cache
  pulls fail until it returns; Talos nodes fall back to the real registries,
  but private images built here are unavailable meanwhile.
- **Initial admin login:** user `admin`, password `HARBOR_ADMIN_PASSWORD` in
  `secret-harbor.sops.yaml` (`sops -d` it yourself; it is never printed).
  Sign-in moves to Authentik once the OIDC app exists.

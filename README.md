# Krishna's Homelab

A four-node Kubernetes cluster at home, run entirely through GitOps. Everything
on the cluster is declared in this repository and reconciled by Argo CD. Secrets
are committed encrypted with SOPS/age, and nothing is changed by hand.

> **Status:** this repo is mid-restructure into a layout where every app is
> one self-contained folder. See [Repository layout](#repository-layout).

## Stack

| Layer | Tools |
|---|---|
| OS / Kubernetes | [Talos Linux](https://www.talos.dev/), 3 control-plane nodes + 1 worker |
| Networking | Cilium (eBPF, kube-proxy replacement, L2/BGP load balancing, Gateway API) |
| Ingress & access | Cilium Gateway, cert-manager (Let's Encrypt DNS-01), Cloudflare Tunnel + Cloudflare Access, Authentik SSO |
| GitOps | Argo CD (app-of-apps), Renovate, Argo Workflows for image builds |
| Storage | Longhorn (replicated block storage, backups to NAS), Synology NFS for media |
| Databases | CloudNativePG (Postgres), Redis |
| Observability | kube-prometheus-stack (Prometheus, Alertmanager, Grafana), Loki + Alloy, blackbox probes |
| Secrets | SOPS + age, decrypted inside Argo CD by a config management plugin |

## What runs on it

- **Media:** Jellyfin, Sonarr, Radarr, Prowlarr, Bazarr, Seerr, qBittorrent (behind Gluetun), NZBGet, Recyclarr, Streamystats
- **Home:** Home Assistant, Music Assistant, Homepage dashboard
- **Network:** AdGuard Home (primary + replica, kept in sync), Kea DHCP
- **AI:** Hermes agent with sandboxed tools: an isolated SSH research worker, Playwright browser, SearXNG, Crawl4AI and a read-only infra MCP server

_A full app catalogue with links to each app's folder will be added once the
restructure lands._

## Repository layout

Every app is one folder:

```
kubernetes/
├── platform/<category>/<app>/   # the cluster's foundations: networking, storage,
│                                #   databases, observability, security, system
└── apps/<category>/<app>/       # what runs on it: ai, home, media, network, other
    ├── README.md                # what it is, URL, dependencies, gotchas
    ├── app.yaml                 # the Argo CD Application for this folder
    ├── kustomization.yaml       # lists the manifests below
    ├── values.yaml              # Helm-based apps only (or chart/ for vendored charts)
    └── deployment.yaml, service.yaml, networkpolicy.yaml, httproute.yaml, secret.sops.yaml, …
```

The root Application (`bootstrap/bootstrap-apps.yaml`) picks up every
`kubernetes/**/app.yaml`, so adding an app is adding a folder.

| Path | Contents |
|---|---|
| `kubernetes/` | Every app, one folder each (see above) |
| `bootstrap/` | One-time cluster seed: Argo CD install values, root app, project, bootstrap secrets |
| `talos/` | Talos machine configs (SOPS-encrypted secrets), applied with `talosctl` |
| `docs/` | Runbooks and project notes |
| `scripts/` | Secret scanning (shared by the pre-commit hook and CI) and maintenance scripts |

## Docs

- [Bootstrapping the cluster](docs/runbooks/bootstrap.md)
- [NAS and switch maintenance](docs/runbooks/nas-and-switch-maintenance.md)
- [Moving the rack onto the UPS (rolling)](docs/runbooks/ups-rack-migration.md)
- [Whole-home zoned audio](docs/projects/zoned-audio.md)

## Licence

[MIT](LICENSE)

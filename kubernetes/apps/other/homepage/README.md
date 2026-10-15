# Homepage

The homelab's start page at home.jupitertech.net: a tile for every service,
with live status, plus widgets (Synology, the *arr apps, cluster resources and
so on). Everything on it (tabs, groups, services, widgets, bookmarks) is
configured in `values.yaml`.

| | |
|---|---|
| **URL** | https://home.jupitertech.net (Gateway, behind Cloudflare Access) |
| **Chart** | [`homepage`](https://github.com/jameswynn/helm-charts/tree/main/charts/homepage) 2.1.0 from `jameswynn.github.io/helm-charts`; the app image is pinned in `values.yaml` |
| **Namespace** | `homepage` |
| **Storage** | None (config is rendered into a ConfigMap by the chart) |
| **Depends on** | Gateway (`homelab-gateway`), the sops-kustomize plugin; reads from most other apps for its widgets |

## Files

| File | What it is |
|---|---|
| `app.yaml` | Argo CD Application with two sources: the chart, and this folder |
| `values.yaml` | Image tag, RBAC, env, and the whole dashboard config (`config:` → settings, services, widgets, bookmarks, kubernetes) |
| `kustomization.yaml` | Lists this folder's own manifests |
| `configmap-custom-css.yaml` | `custom.css`, mounted over `/app/config/custom.css` (the per-card brand tints) |
| `secret-synology.sops.yaml` | Synology widget credentials, loaded as env vars (SOPS/age encrypted) |
| `secret-arr-keys.sops.yaml` | API keys for the *arr widgets, loaded as env vars (SOPS/age encrypted) |

The chart makes the Deployment, Service, ConfigMap, ServiceAccount (+ token
Secret) and the ClusterRole/Binding that lets the Kubernetes widgets read
cluster status. The HTTPRoute and ReferenceGrant still live in the `gateway`
app (`clusters/homelab/gateway/`) until the route handoff.

## Editing the dashboard

Change `values.yaml` under `config:` and merge. The chart re-renders the
ConfigMap and Homepage picks it up. Widget secrets are referenced as
`{{HOMEPAGE_VAR_...}}` and come from the two secrets above via `envFrom`.

## Gotchas

- **The image tag is set here, not by the chart.** The chart's default
  appVersion is old; bump `image.tag` in `values.yaml` to upgrade Homepage.
- **History:** until October 2026 this chart was vendored into the repo
  (`gitops/homepage-chart`) to dodge an Argo CD bug resolving its bjw-s
  `common` sub-chart from a git path. Pulling the packaged chart from its Helm
  repo bundles the sub-chart, so the copy was removed.
- **`HOMEPAGE_ALLOWED_HOSTS`** must list every hostname Homepage is reached
  by, or it rejects the request.
- **Widgets call services directly**, bypassing the Gateway, so each app's
  network policy has an "allow from homepage" rule. A new widget usually
  needs one too.
- **Project `default`.** This app still uses the `default` AppProject;
  moving it to `homelab` is a pending cleanup.

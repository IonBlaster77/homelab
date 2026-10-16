# Argo CD

The GitOps engine: it watches this repo and keeps the cluster matching it.
This app is Argo CD **managing itself**: its own Deployments, config and RBAC
come from the chart here, and the root app (`bootstrap/bootstrap-apps.yaml`)
finds every other app's `app.yaml`.

| | |
|---|---|
| **URL** | https://argocd.jupitertech.net (via the Gateway) and http://10.77.20.50 (LAN LoadBalancer) |
| **Chart** | Upstream `argo-cd` **9.5.2**, vendored in `chart/charts/` inside an umbrella chart |
| **Namespace** | `argocd` (Helm release `argocd`, installed at bootstrap and adopted) |
| **Sync** | **Manual.** Nothing here changes until someone syncs this app |
| **Depends on** | Cilium, the Gateway; the SOPS plugin sidecar is configured in `bootstrap/` |

## Files

| File | What it is |
|---|---|
| `app.yaml` | Argo CD Application, **manual sync**, two sources: `chart/` and this folder. Server-Side Apply plus `ignoreDifferences` |
| `chart/` | Umbrella chart: `Chart.yaml`/`Chart.lock` (argo-cd 9.5.2), the vendored `.tgz`, and `values.yaml` (all settings under `argo-cd:`) |
| `kustomization.yaml` | Lists this folder's own manifests (not `chart/`) |
| `httproute.yaml`, `referencegrant.yaml` | `argocd.jupitertech.net` → `argocd-server:80` |

## The two copies of the values

- `chart/values.yaml` is what Argo CD renders when syncing itself.
- `bootstrap/argocd-values.yaml` is the first-install copy from the bootstrap
  runbook. Same settings today (it uses Windows line endings and has one
  extra comment). Change both together.

## Gotchas

- **Never sync this app casually.** A bad self-sync can leave Argo CD unable
  to sync anything, including the fix. Review `argocd app diff argocd`
  first, and keep a `helm` path in mind for recovery
  (`helm upgrade argocd ... -f bootstrap/argocd-values.yaml` from WSL).
- **Changing an Application's own `app.yaml`** needs the root app
  (`bootstrap-apps`) synced first; the target app's "Synced" status alone
  doesn't prove your edit landed.
- **`server.insecure: true`**: Argo CD serves plain HTTP on port 80; TLS ends
  at the Gateway.
- **The `claude-code` account** (`accounts.claude-code: apiKey` in values) is
  the scoped read+sync account used for automation.
- **Upgrading:** bump `chart/Chart.yaml`, `helm dependency update`, commit the
  new `.tgz` and `Chart.lock` (delete the old one), update
  `bootstrap/argocd-values.yaml` if values change, review the diff, sync.

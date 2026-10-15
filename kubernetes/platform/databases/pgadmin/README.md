# pgAdmin

A web UI for managing the cluster's PostgreSQL databases (the CNPG clusters
for Authentik, Grafana and Kea): browse tables, run queries, check activity.

| | |
|---|---|
| **URL** | https://pgadmin.jupitertech.net (Gateway, behind Cloudflare Access) |
| **Chart** | [`pgadmin4`](https://github.com/rowanruseler/helm-charts/tree/main/charts/pgadmin4) from `helm.runix.net`, version pinned in `app.yaml` |
| **Namespace** | `pgadmin` |
| **Storage** | `pgadmin4`, 2Gi Longhorn (`longhorn-ssd`), created by the chart: saved server connections and preferences |
| **Depends on** | Gateway (`homelab-gateway`), Longhorn, the sops-kustomize plugin |

## Files

| File | What it is |
|---|---|
| `app.yaml` | Argo CD Application with two sources: the chart, and this folder |
| `values.yaml` | Chart values: use the existing login secret, 2Gi volume, ClusterIP service, resources |
| `kustomization.yaml` | Lists this folder's own manifests |
| `namespace.yaml` | The `pgadmin` namespace |
| `secret.sops.yaml` | `pgadmin-credentials`: the initial admin login (SOPS/age encrypted) |

The chart makes the Deployment, Service, PVC and a Kubernetes NetworkPolicy.
The HTTPRoute and ReferenceGrant still live in the `gateway` app
(`clusters/homelab/gateway/`) until the route handoff.

## How the two sources fit together

The second source does two jobs. As `ref: values` it lets the chart read
`values.yaml` from this repo (`$values/...`). As a normal path source it
renders this folder through the SOPS plugin, which adds the namespace and the
decrypted secret. Argo CD applies both outputs as one app.

## Gotchas

- **The login secret is only read on first start.** pgAdmin stores the admin
  account in its own database on the PVC. Changing `secret.sops.yaml` later
  does not change the password. Change it in the UI.
- **Server connections live on the PVC**, not in git. Losing the volume
  means re-adding the database servers (the Longhorn NAS backups cover it).
- **The chart has a Helm `test` hook pod.** Argo CD doesn't run Helm tests,
  so it never appears.

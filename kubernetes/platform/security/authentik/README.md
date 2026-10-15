# Authentik

The homelab's identity provider. Its one live job: **Cloudflare Access uses
it (OIDC) for remote logins.** Opening any public `*.jupitertech.net`
hostname from outside the house goes Cloudflare Access → Authentik login →
back to the app. On the LAN, AdGuard points hostnames straight at the
Gateway, so Authentik isn't involved.

| | |
|---|---|
| **URL** | https://auth.jupitertech.net (cloudflared routes it straight here, skipping the Gateway; Access *Bypass* policy) |
| **Chart** | [`authentik`](https://github.com/goauthentik/helm/tree/main/charts/authentik) from `charts.goauthentik.io`, version pinned in `app.yaml` |
| **Namespace** | `authentik` |
| **Storage** | `authentik-db-*`, 2 × 5Gi Longhorn (`longhorn-nvme`), owned by the CNPG `Cluster`: users, MFA, providers, the Cloudflare OIDC client |
| **Depends on** | CloudNativePG, Longhorn, cloudflared, the sops-kustomize plugin |

## Files

| File | What it is |
|---|---|
| `app.yaml` | Argo CD Application with two sources: the chart, and this folder. Uses Server-Side Apply |
| `values.yaml` | External Postgres, secret wiring, 2 server replicas (spread across nodes), 1 worker, metrics |
| `kustomization.yaml` | Lists this folder's own manifests |
| `namespace.yaml` | The `authentik` namespace |
| `secret-authentik.sops.yaml` | `authentik-secret`: Authentik's secret key (SOPS/age encrypted) |
| `cluster-authentik-db.yaml`, `podmonitor-authentik-db.yaml`, `secret-authentik-db.sops.yaml` | Its PostgreSQL (CNPG, 2 instances) and metrics |
| `service-ldap.yaml`, `service-radius.yaml` | LoadBalancers on 10.77.20.61 (LDAP) and .62 (RADIUS), for outposts that don't exist yet |

## Gotchas

- **Remote access depends on this.** If Authentik is down, new remote logins
  to every public hostname fail (existing Cloudflare Access sessions last
  until they expire). Fix it from the LAN. Enabling One-time PIN in Cloudflare
  Access as a second login method would remove that dependency.
- **`auth.` must not sit behind Cloudflare Access.** Access would need
  Authentik to log you into Authentik. That's why it has a Bypass policy and
  its own cloudflared route.
- **Never let Argo CD prune `cluster-authentik-db.yaml`.** The database
  volumes belong to that `Cluster`; deleting it deletes them. There are no
  database-native backups yet, only the Longhorn NAS backups.
- **Don't rotate `AUTHENTIK_SECRET_KEY`** casually: it invalidates sessions
  and signed tokens.
- **The LDAP/RADIUS Services select nothing yet.** Create outposts named
  exactly `ldap` and `radius` in the Authentik UI first; the header of
  `service-ldap.yaml` has the steps.

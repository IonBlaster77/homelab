# cloudflared

The Cloudflare Tunnel connector. It dials **out** to Cloudflare and holds the
tunnel open; Cloudflare sends public `*.jupitertech.net` requests down that
tunnel. Nothing at home listens on the internet: no port forwards, no public IP.

```
browser → Cloudflare (Access login) → tunnel → cloudflared → Cilium Gateway → app
                                                           ↘ auth.jupitertech.net → Authentik directly
```

| | |
|---|---|
| **URL** | None of its own; it carries every public hostname. Metrics on `cloudflared-metrics:2000` |
| **Image** | `cloudflare/cloudflared:latest` (see Gotchas) |
| **Namespace** | `cloudflared` |
| **Storage** | None |
| **Depends on** | Cloudflare (tunnel + Access), the Cilium Gateway, Authentik, the sops-kustomize plugin |

## Files

| File | What it is |
|---|---|
| `app.yaml` | Argo CD Application for this folder |
| `kustomization.yaml` | Lists the manifests below |
| `namespace.yaml` | The `cloudflared` namespace |
| `serviceaccount.yaml` | Token-less ServiceAccount |
| `secret.sops.yaml` | `cloudflared-secret`: the tunnel token (SOPS/age encrypted) |
| `configmap.yaml` | Tunnel ingress rules: `auth.` → Authentik, everything else → the Gateway |
| `deployment.yaml` | 2 replicas, rolling update with `maxUnavailable: 0` |
| `service-metrics.yaml`, `servicemonitor.yaml` | Prometheus scraping of `:2000` |
| `networkpolicy.yaml` | Default-deny; egress to Cloudflare, the Gateway and Authentik; Prometheus in |

## Gotchas

- **This is the front door for remote access.** If it breaks, every public
  hostname fails, including the ones you'd use to fix it. Make changes from
  the LAN.
- **A new public app needs no change here.** The wildcard rule sends it to
  the Gateway; add an HTTPRoute, an AdGuard rewrite, and a Cloudflare Access
  application for the hostname.
- **`auth.jupitertech.net` skips the Gateway on purpose,** so Cloudflare
  Access's OIDC login against Authentik still works if the Gateway has a
  problem. It's also the one hostname with an Access *Bypass* policy.
- **`noTLSVerify` towards the Gateway:** the wildcard cert doesn't match the
  in-cluster service name. Traffic stays inside the cluster.
- **The image is `:latest` with `imagePullPolicy: Always`,** so any restart
  can pull a new cloudflared version. Pinning a tag (and letting Renovate
  bump it) would make upgrades deliberate.
- **Ingress rules are read at start.** After editing `configmap.yaml`, delete
  the pods one at a time (2 replicas keep the tunnel up).

# cert-manager

Gets and renews TLS certificates automatically. The homelab has one: the
**wildcard `*.jupitertech.net`** certificate from Let's Encrypt, which the
Gateway serves for every HTTPS hostname. cert-manager proves domain ownership
with a **DNS-01** challenge: it creates a temporary TXT record through the
Cloudflare API, Let's Encrypt checks it, and the record is removed.

| | |
|---|---|
| **URL** | None |
| **Chart** | [`cert-manager`](https://cert-manager.io/docs/installation/helm/) from `charts.jetstack.io`, version pinned in `app.yaml` |
| **Namespace** | `cert-manager` |
| **Storage** | None (certificates are stored as Secrets) |
| **Depends on** | Cloudflare API, Let's Encrypt, public DNS (1.1.1.1 / 8.8.8.8) |

## Files

| File | What it is |
|---|---|
| `app.yaml` | Argo CD Application with two sources: the chart, and this folder. Server-Side Apply |
| `values.yaml` | Installs the CRDs, uses public resolvers for DNS-01, control-plane tolerations, Prometheus ServiceMonitor |
| `kustomization.yaml` | Lists this folder's own manifests |
| `secret-cloudflare.sops.yaml` | `cloudflare-api-token`: a Cloudflare token scoped to DNS edits (SOPS/age encrypted) |
| `clusterissuer-prod.yaml` | `letsencrypt-prod`: real, browser-trusted certificates |
| `clusterissuer-staging.yaml` | `letsencrypt-staging`: untrusted test certificates, generous rate limits |

The **`Certificate`** object itself (`jupitertech-wildcard`) lives with the
Gateway (`kubernetes/platform/networking/gateway/`), because the resulting TLS Secret must
be in the `networking` namespace next to the Gateway.

## Gotchas

- **Use staging first** when changing issuers or the certificate: production
  is rate-limited (50 certificates per domain per week).
- **DNS-01 uses public resolvers on purpose** (`--dns01-recursive-nameservers`).
  In-cluster DNS returned an empty Cloudflare zone ID during cleanup, so
  challenge records were never deleted and renewals wedged in "Renewing".
- **Stay on v1.17.1 or newer.** Older versions can't clean up challenge
  records with Cloudflare's current API (error 7003).
- **The chart installs cert-manager's CRDs** (`installCRDs: true`), **so this
  app has `prune: false`.** Deleting the `Certificate` CRD would delete the
  certificate object (the TLS Secret survives, but stops renewing), and with
  pruning on, a chart upgrade or values rename that stopped rendering it
  would do exactly that.
- **After every upgrade, check for leftovers.** With pruning off, anything
  the chart drops or renames, and any file you delete from this folder,
  stays in the cluster; Argo CD shows it as "requires pruning". Delete it by
  hand once you've checked it's obsolete. Never tick **Prune** on a manual
  sync of this app without reading the diff.
- **`startupapicheck`** is a chart hook Job that runs on every sync to confirm
  the webhook answers. If a sync hangs, look at it first.
- **Renewal happens ~30 days before expiry.** If HTTPS starts failing near
  expiry, check `kubectl describe certificate -n networking jupitertech-wildcard`
  and the challenge/order objects.

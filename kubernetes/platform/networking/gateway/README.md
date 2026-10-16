# Gateway

The one shared **Gateway** that every web hostname in the homelab goes
through, implemented by Cilium. It listens on **10.77.20.60** (ports 80 and
443), terminates TLS with the wildcard `*.jupitertech.net` certificate, and
hands each request to whichever app's `HTTPRoute` claims the hostname.

```
LAN client ─(AdGuard rewrite)─┐
                              ├─► Gateway 10.77.20.60 ─► HTTPRoute (in each app's folder) ─► Service
Cloudflare tunnel ────────────┘
```

| | |
|---|---|
| **Address** | 10.77.20.60 (Cilium LoadBalancer IP, pinned in `gateway.yaml`) |
| **Namespace** | `networking` (PSA `baseline`); every HTTPRoute lives here |
| **Certificate** | `jupitertech-wildcard` → Secret `jupitertech-wildcard-tls`, from Let's Encrypt via cert-manager (DNS-01) |
| **Depends on** | Gateway API CRDs, Cilium (Gateway API enabled), cert-manager |

## Files

| File | What it is |
|---|---|
| `app.yaml` | Argo CD Application for this folder. Server-Side Apply |
| `kustomization.yaml` | Lists the manifests below |
| `namespace.yaml` | The `networking` namespace |
| `gateway.yaml` | `homelab-gateway`: HTTP (80) and HTTPS (443) listeners; `allowedRoutes: All` namespaces, though by convention every route lives in `networking` |
| `certificate.yaml` | The wildcard `Certificate` (its Secret must sit next to the Gateway, hence here rather than with cert-manager) |
| `httproute-redirect.yaml` | Port 80 → HTTPS redirect for every hostname |
| `httproute-argocd.yaml`, `referencegrant-argocd.yaml` | Argo CD's route, until the argocd app moves |
| `httproute-hubble.yaml`, `referencegrant-hubble.yaml` | Hubble UI's route, until the cilium app moves |

## Adding a web app

Each app owns its route. In the app's folder:

1. `httproute.yaml`: `namespace: networking`, `parentRefs` → `homelab-gateway`
   (`sectionName: https`), the hostname, and the app's Service as backend.
2. `referencegrant.yaml` in the **app's** namespace, allowing `HTTPRoute`s
   from `networking` to reach its Services.
3. Add an AdGuard rewrite (`kubernetes/apps/network/adguard/job-dns-rewrites.yaml`)
   so LAN clients reach the Gateway directly.
4. For remote access, add a Cloudflare Access application for the hostname.
   cloudflared's wildcard rule already sends it here.
5. Add a Cilium network policy allowing `fromEntities: ingress` to the pod's
   **container** port (Gateway traffic carries Cilium's `ingress` identity).

## Gotchas

- **Moving a route between apps:** mark it `argocd.argoproj.io/sync-options:
  Prune=false` first, move the file, sync the new owner and then the old
  one, and remove the mark afterwards. Otherwise the old app prunes the route
  before the new one adopts it (a short 404). This is how routes left this
  folder in October 2026.
- **Never ping 10.77.20.60.** Cilium LoadBalancer IPs don't answer ICMP; test
  with `curl --resolve <host>:443:10.77.20.60`.
- **Port 80 only redirects.** All real routes attach to the `https` listener.

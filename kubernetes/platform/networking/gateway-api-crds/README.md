# Gateway API CRDs

The Custom Resource Definitions for the Kubernetes
[Gateway API](https://gateway-api.sigs.k8s.io/): `GatewayClass`, `Gateway`,
`HTTPRoute`, `GRPCRoute`, `ReferenceGrant` (standard channel) and `TLSRoute`
(experimental channel). They teach Kubernetes what those objects are. Cilium
implements them, and every web hostname in the homelab is an `HTTPRoute`
attached to the one `Gateway`.

| | |
|---|---|
| **Version** | Gateway API v1.2.1, vendored from the upstream release |
| **Namespace** | None (CRDs are cluster-scoped; the destination is just `kube-system`) |
| **Depends on** | Nothing. Cilium (Gateway API support) and the gateway app depend on *it* |

## Files

| File | What it is |
|---|---|
| `app.yaml` | Argo CD Application: `prune: false`, Server-Side Apply |
| `kustomization.yaml` | Lists the two vendored files |
| `crds-standard-v1.2.1.yaml` | Upstream `standard-install.yaml`, unmodified (5 CRDs) |
| `crd-tlsroutes-experimental-v1.2.1.yaml` | Upstream `TLSRoute` CRD from the experimental channel |

## Fresh-cluster sync order

1. **gateway-api-crds** (this app)
2. **cilium**: picks up `gatewayAPI.enabled: true`; Cilium only enables
   Gateway API support if the CRDs exist when it starts
3. **cert-manager**, then its config (issuer, wildcard certificate)
4. **gateway**: the `Gateway` itself, then the routes

## Gotchas

- **`prune: false` is deliberate.** Deleting a CRD deletes every object of
  that kind cluster-wide: the Gateway and all HTTPRoutes would go with it.
  To retire a CRD, delete it by hand after checking nothing uses it.
- **Server-Side Apply is required.** The CRDs are too big for the
  client-side apply annotation.
- **Upgrading:** replace the files with the new release's
  `standard-install.yaml` (and the experimental CRDs you use), rename them
  to the new version, and check Cilium supports that Gateway API version
  first. Cilium and the CRDs must agree.
- **These files are skipped by `scripts/scan-secrets.sh`** (they contain
  words like `secret` and `key` as schema field names). If this folder moves,
  update the path there too.

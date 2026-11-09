# Gateway API CRDs

The Custom Resource Definitions for the Kubernetes
[Gateway API](https://gateway-api.sigs.k8s.io/): `GatewayClass`, `Gateway`,
`HTTPRoute`, `GRPCRoute`, `ReferenceGrant`, `BackendTLSPolicy`, `ListenerSet`,
`TCPRoute`, `UDPRoute` (standard channel) and `TLSRoute` (experimental
channel), plus upstream's `safe-upgrades` ValidatingAdmissionPolicy. They
teach Kubernetes what those objects are. Cilium implements them, and every
web hostname in the homelab is an `HTTPRoute` attached to the one `Gateway`.

| | |
|---|---|
| **Version** | Gateway API v1.6.3, vendored from the upstream release tag |
| **Namespace** | None (CRDs are cluster-scoped; the destination is just `kube-system`) |
| **Depends on** | Nothing. Cilium (Gateway API support) and the gateway app depend on *it* |

## Files

| File | What it is |
|---|---|
| `app.yaml` | Argo CD Application: `prune: false`, Server-Side Apply |
| `kustomization.yaml` | Lists the vendored files |
| `v1.6.3/standard/` | Upstream `config/crd/standard/*.yaml` at the tag, unmodified, **minus TLSRoute**: 9 CRDs + the safe-upgrades VAP and binding. Together that is `standard-install.yaml` without TLSRoute |
| `v1.6.3/experimental/gateway.networking.k8s.io_tlsroutes.yaml` | Upstream experimental-channel `TLSRoute` CRD |

## Why TLSRoute is experimental

From v1.6 the *standard* TLSRoute CRD keeps `v1alpha2` in its version list
but stops serving it. Cilium 1.19 decides whether TLSRoute is installed by
looking for `v1alpha2` in that list (not whether it is served), so with the
standard CRD it would start a TLSRoute controller against an API that
returns 404. The experimental CRD serves `v1alpha2`, `v1alpha3` and `v1`, which
suits Cilium 1.19 (v1alpha2) and 1.20 (v1) alike. Nothing uses TLSRoute today.
Once Cilium is on 1.20+, it can move to the standard file, but only after
backing up any TLSRoutes: objects stored as v1alpha2/v1alpha3 become unreadable.

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
- **The `safe-upgrades` VAP blocks downgrades.** It rejects any Gateway API
  CRD whose bundle version is below v1.5, and experimental CRDs over
  standard ones. Rolling back past v1.5 means deleting the
  `ValidatingAdmissionPolicy` and its binding `safe-upgrades.gateway.networking.k8s.io` first.
- **Upgrading:** download the new tag's `config/crd/standard/*.yaml` (all but
  TLSRoute) and `config/crd/experimental/gateway.networking.k8s.io_tlsroutes.yaml`
  into a new `vX.Y.Z/` folder, point `kustomization.yaml` at it, delete the
  old folder. Check the Cilium release supports that Gateway API version
  first. Cilium and the CRDs must agree (Cilium 1.20 needs at least v1.6.1).
- **These files are skipped by `scripts/scan-secrets.sh`** (they contain
  words like `secret` and `key` as schema field names). If this folder moves,
  update the path there too.

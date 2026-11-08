# Vertical Pod Autoscaler (recommend only)

Suggests CPU and memory requests for the critical workloads, from their real
use. **It never changes anything**: only the recommender runs (no updater,
no admission webhook), and every VPA object is `updateMode: "Off"`.

Part of the OOM-protection work (`docs/projects/oom-protection.md`, "Keeping
sizes right"): the requests and limits set on 2026-11-07 were sized by hand
from Prometheus history; VPA keeps a running second opinion as use changes.

## Reading the recommendations

```bash
kubectl get vpa -A                       # target per workload (CPU, memory)
kubectl -n harbor describe vpa harbor-registry   # lower/target/upper per container
```

Or Grafana → **Resource drift**: per container, real use against the request,
the limit and the VPA target/upper bound. kube-state-metrics turns the VPA
status into `kube_vpa_recommendation_*` metrics (config in
`observability/monitoring/values.yaml`).

- **target**: what VPA would set as the request.
- **upperBound**: a sensible ceiling; compare it with the memory limit.
- Recommendations start within minutes but need about a day of history to
  settle, and VPA weights recent use (half-life 24 h over an 8-day window).

Acting on a recommendation is a normal Git change to that app's requests or
limits. The alerts `CriticalPodOverMemoryRequest` (1-day average above the
request) and `CriticalPodNearMemoryLimit` (above 85% of the limit for 30 min)
in `prometheusrule-infra.yaml` say when one is due.

## What's covered

`verticalpodautoscalers.yaml`: 36 objects, the pods that got requests in the
OOM work: AdGuard, Kea, Argo CD, Authentik, cert-manager, Harbor, the
monitoring stack, all 8 CNPG clusters plus the operator, longhorn-manager,
Cilium (agent, envoy, operator) and CoreDNS.

- Each `targetRef` must be the top-most controller of the pods: the CNPG
  `Cluster`, and the `Prometheus`/`Alertmanager` resources rather than their
  StatefulSets. All of these expose a scale subresource, which VPA needs.
- Talos' static control-plane pods (kube-apiserver, scheduler,
  controller-manager) have no controller, so VPA can't cover them; the
  dashboard still shows them.
- A VPA object for a workload that doesn't exist yet just shows no
  recommendation.

## Notes

- Chart: the official `vertical-pod-autoscaler` chart from
  kubernetes/autoscaler, rendered by Kustomize `helmCharts` (like the
  descheduler). `charts/` is downloaded when you build locally and is
  gitignored.
- One recommender replica, no PDB (a single-replica PDB would block node
  drains). History survives restarts in `VerticalPodAutoscalerCheckpoint`
  objects. `--memory-saver` keeps history only for pods a VPA selects.
- The per-pod recommendation floor is lowered to 16 MB / 5m (defaults
  250 MB / 25m, which clamped most small pods here to exactly 250Mi/25m).
  The floor is per pod and split across its containers.
- The VPA objects carry `SkipDryRunOnMissingResource=true` because the CRD is
  created in the same sync.
- New app: after merging, `argocd app sync bootstrap-apps` so the root app
  creates it.

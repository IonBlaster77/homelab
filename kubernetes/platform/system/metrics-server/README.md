# metrics-server

Serves the Kubernetes **resource metrics API** (`metrics.k8s.io`): the live
CPU and memory numbers behind `kubectl top` and HorizontalPodAutoscalers. It
scrapes each kubelet every 15s and keeps only the latest sample. There's no
history, no dashboards and no alerts; that's Prometheus' job, and the two are
independent.

| | |
|---|---|
| **URL** | None. Registered as an APIService (`v1beta1.metrics.k8s.io`) |
| **Chart** | [`metrics-server`](https://github.com/kubernetes-sigs/metrics-server/tree/master/charts/metrics-server) from `kubernetes-sigs.github.io/metrics-server`, version pinned in `app.yaml` |
| **Namespace** | `kube-system` |
| **Storage** | None |
| **Depends on** | Kubelets on every node (port 10250) |

## Files

| File | What it is |
|---|---|
| `app.yaml` | Argo CD Application: the upstream chart plus this repo as `$values`. Server-Side Apply |
| `values.yaml` | Our chart values |

There are no manifests here: everything comes from the chart.

## Gotchas

- **`--kubelet-insecure-tls`.** Talos kubelets serve self-signed certificates,
  so metrics-server can't verify them. The alternative is enabling kubelet
  serving-cert rotation in Talos and approving the CSRs.
- **`--kubelet-preferred-address-types=InternalIP`.** Talos node names don't
  resolve in cluster DNS, so it connects by node IP.
- **Upgrading:** bump `targetRevision` in `app.yaml`, and check the chart's
  changelog for renamed values first.
- **If `kubectl top` says "metrics not available",** check
  `kubectl get apiservice v1beta1.metrics.k8s.io` before anything else.

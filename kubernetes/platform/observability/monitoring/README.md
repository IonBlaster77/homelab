# Monitoring

Metrics, dashboards and alerting for the whole homelab, built on
kube-prometheus-stack:

- **Prometheus** scrapes metrics from everything (60 targets) and evaluates
  the alert rules.
- **Alertmanager** routes alerts. Right now it routes to `"null"`: there is
  **no alert channel** until one is chosen (see Gotchas).
- **Grafana** shows dashboards for metrics (Prometheus) and logs (Loki).
- **node-exporter** (per node) and **kube-state-metrics** feed host and
  Kubernetes-object metrics; the **Prometheus operator** turns
  `ServiceMonitor`/`PodMonitor`/`Probe`/`PrometheusRule` objects into config.

| | |
|---|---|
| **URL** | https://grafana.jupitertech.net (Grafana, via the Gateway). Prometheus and Alertmanager are in-cluster only |
| **Chart** | [`kube-prometheus-stack`](https://github.com/prometheus-community/helm-charts/tree/main/charts/kube-prometheus-stack) from `prometheus-community.github.io/helm-charts`, version pinned in `app.yaml` |
| **Namespace** | `monitoring` (PSA `privileged`, for node-exporter's host access) |
| **Storage** | Prometheus 50Gi (60d / 45GB retention), Alertmanager 2Gi, Grafana DB 2 × 5Gi (CNPG). All Longhorn, all created by operators, not Argo |
| **Depends on** | Longhorn, CloudNativePG, the sops-kustomize plugin, Loki (Grafana datasource) |

## Files

| Files | What they are |
|---|---|
| `app.yaml`, `values.yaml` | The Application (chart + this folder, Server-Side Apply) and the chart values |
| `kustomization.yaml` | Lists this folder's own manifests, grouped by component |
| `namespace.yaml` | The `monitoring` namespace and its PSA labels |
| `cluster-grafana-db.yaml`, `podmonitor-grafana-db.yaml`, `secret-grafana-db.sops.yaml` | Grafana's PostgreSQL (CNPG, 2 instances) and its metrics |
| `secret-grafana-admin.sops.yaml` | Grafana admin login |
| `httproute-grafana.yaml`, `referencegrant-grafana.yaml` | `grafana.jupitertech.net` → Grafana (route lives in the `networking` namespace) |
| `podmonitor-cnpg.yaml`, `prometheusrule-cnpg.yaml` | CNPG operator metrics and upstream CNPG alert rules |
| `prometheusrule-{argocd,authentik,hubble,infra}.yaml` | Our alert rules |
| `*-blackbox-exporter.yaml` | Active probes for things with no `/metrics`: AdGuard DNS, Kea API, NAS NFS, the Cilium Gateway |
| `*-mikrotik-exporter*` | MikroTik router metrics |
| `*-unifi-poller*` | UniFi network metrics |
| `cronjob-log-digest.yaml`, `secret-log-digest-webhook.sops.yaml` | Daily log summary to a webhook (suspended) |

## Gotchas

- **No alert channel.** Alertmanager routes to `"null"` and the log-digest
  CronJob is `suspend: true`. To turn alerts on: add a receiver and routes
  under `alertmanager.config` in `values.yaml`, point
  `secret-log-digest-webhook.sops.yaml` at the channel, and unsuspend the CronJob.
- **Argo CD must never prune `cluster-grafana-db.yaml`.** The database
  volumes belong to that CNPG `Cluster`; deleting it deletes them.
- **blackbox-exporter doesn't reload config.** After editing
  `configmap-blackbox-exporter.yaml`, delete its pod (never
  `kubectl rollout restart`; Argo reverts spec edits).
- **Talos hides etcd, scheduler, controller-manager and kube-proxy metrics,**
  so those scrapes are disabled in `values.yaml`.
- **The `ignoreDifferences` entry** in `app.yaml` hides a StatefulSet status
  field that newer Kubernetes adds, which otherwise shows as OutOfSync.
- **The chart's admission-webhook Jobs** (hooks) re-run on every sync; if a
  sync hangs, check those Jobs first.

# Monitoring

Metrics, dashboards and alerting for the whole homelab, built on
kube-prometheus-stack:

- **Prometheus** scrapes metrics from everything (60 targets) and evaluates
  the alert rules.
- **Alertmanager** routes critical and warning alerts to Matrix
  (#alerts-critical, #alerts-warning) through the in-cluster
  `matrix-alertmanager-receiver` bridge; everything else goes to `"null"`.
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
| `cronjob-log-digest.yaml`, `secret-log-digest-matrix.sops.yaml` | Fallback daily error-count digest to Matrix #log-digest (see Gotchas) |

## Gotchas

- **The log digest is only a fallback.** Hermes' `daily-health-review`
  (22:00 UTC, see `apps/ai/hermes/README.md`) is the real daily report. At
  23:00 UTC the CronJob checks #log-digest for Hermes' report (its closing
  line "End of daily health review.") and posts its own counts only if that
  is missing. Its noise filter must match `ERROR_FILTER` in
  `apps/ai/infra-mcp/configmap.yaml`.
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

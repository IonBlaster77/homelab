# kube-prometheus-stack upgrade: 83.7.0 → 92.x

Plan written 2026-10-25. Upgrades the `monitoring` app (Prometheus,
Alertmanager, Grafana, node-exporter, kube-state-metrics, Prometheus
operator) nine chart majors, **one major per step**, with a check between
each. Renovate's [#213](https://github.com/IonBlaster77/homelab/pull/213)
(straight to 92.13.1) is replaced by these steps; close it once step 1 lands.

## Why it's careful but low risk to users

Nothing user-facing runs through monitoring, so a broken step costs
visibility, not service. What is at risk:

- **The CRDs** (`ServiceMonitor`, `PodMonitor`, `Probe`, `PrometheusRule`):
  24 + 7 + 4 + 35 objects across many apps use them. Argo CD applies the
  chart's CRDs itself (field manager `argocd-controller`, Server-Side
  Apply), so the operator-version steps update them automatically; no
  manual `kubectl apply`.
- **Alerting** goes quiet while Prometheus or Alertmanager is down.
- **Grafana's database** (CNPG `grafana-db`): Grafana migrates its schema
  on start, one-way. Restore point: Barman backup to RustFS
  (`grafana-db-manual-20261024`, plus `grafana-db-daily`).
- **Prometheus history** (~50 days, 50Gi volume): kept across restarts; at
  risk only if the StatefulSet's volume claim were recreated.

## What changes, step by step

Latest chart in each major as of 2026-10-25. Prometheus moves 3.11 → 3.15
(minor releases); Alertmanager and node-exporter are unchanged.

| Step | Chart | What changes | Watch |
|---|---|---|---|
| 1 | **84.5.0** | Grafana **12.4 → 13.0**, Grafana chart 11 → 12 | Grafana DB migration, dashboards, datasources, login |
| 2 | 85.4.0 | Prometheus + node-exporter images go **distroless** (no shell/wget in them); kube-state-metrics 2.19 | Targets, node metrics. Use the API proxy for checks, never `kubectl exec ... wget` into Prometheus |
| 3 | 86.3.2 | Operator **v0.91** (CRDs updated) | CRD versions, operator log, targets/rules counts |
| 4 | 87.21.0 | Operator **v0.92**, Grafana 13.1 | same |
| 5 | 88.6.5 | Operator **v0.93**, Grafana 13.2, kube-state-metrics 2.20 | same |
| 6 | 89.2.4 | Grafana chart **13**: read-only root filesystem, distroless Grafana image, `/tmp` an emptyDir | Grafana starts; the 8 grafana.com dashboards still download (init container) |
| 7 | 90.2.0 | Kubelet/API-server scrapes switch from the token file to a token **Secret** (`prometheus.serviceAccount.createTokenSecret`) | The 12 kubelet + 3 apiserver targets stay up (container CPU/memory metrics come from these) |
| 8 | 91.9.0 | Operator **v0.94**; its ClusterRole loses wildcard verbs | Operator log free of `forbidden` errors |
| 9 | 92.13.1 | Chart workloads get `nodeSelector: kubernetes.io/os: linux`; Grafana chart **14** validates values against a schema | Sync succeeds (a schema error fails the render); pods restart once |

Our `values.yaml` doesn't set any of the values removed in 90.x (the
control-plane scrapes it would affect are disabled for Talos), uses
`envValueFrom` rather than `GF_*__FILE` (rejected with distroless Grafana in
chart 13), and has no `extraVolumeMounts` for `/tmp`.

## Before step 1

1. Note the baseline (2026-10-25): **72/72 targets up**, **41 rule groups /
   244 rules, 0 errors**, Grafana 12.4.3 `database: ok`. Already firing:
   CPUThrottlingHigh ×2, LonghornBackupFailed, NodeDiskIOSaturation,
   NodeSystemSaturation (plus Watchdog/InfoInhibitor). Don't blame these on
   the upgrade.
2. Fresh `grafana-db` backup (Barman, see `scheduledbackup-grafana-db.yaml`)
   and confirm it reaches `completed`.
3. Close Renovate #213 so it can't be merged by accident; Renovate will keep
   proposing the latest 92.x on its own.

## Each step

1. PR: bump `targetRevision` in `kubernetes/platform/observability/monitoring/app.yaml`.
2. After merging: **sync `bootstrap-apps` first**, then `monitoring` (the
   chart version lives in the Application's own YAML; `monitoring` showing
   Synced in between doesn't mean the new version is in).
3. Wait for the operator, Prometheus, Alertmanager and Grafana rollouts.
4. Check, through the API-server proxy (works with distroless images):

   ```bash
   P=/api/v1/namespaces/monitoring/services/http:monitoring-kube-prometheus-prometheus:9090/proxy
   kubectl get --raw "$P/api/v1/targets?state=active" | grep -o '"health":"[a-z]*"' | sort | uniq -c
   kubectl get --raw "$P/api/v1/rules" | grep -o '"health":"[a-z]*"' | sort | uniq -c
   kubectl get --raw /api/v1/namespaces/monitoring/services/http:monitoring-grafana:80/proxy/api/health
   kubectl get crd prometheuses.monitoring.coreos.com -o jsonpath='{.metadata.annotations.operator\.prometheus\.io/version}'
   kubectl logs -n monitoring deploy/monitoring-kube-prometheus-operator --since=10m | grep -iE 'error|forbidden'
   ```

   Pass: targets back to 72 up, rules 0 errors, Grafana `database: ok`,
   CRD version matches the step, operator log clean, Watchdog still firing
   (it's the always-on alert; Alertmanager receives it).
5. Steps 1 and 6: also open Grafana, load a dashboard (Longhorn, CNPG) and
   Explore → Loki.

Each step restarts Prometheus once (a 1–2 minute gap in metrics).

## Rolling back

- **Steps 2–9:** revert `targetRevision` and sync as above. Newer CRDs stay
  installed; an older operator works with them.
- **Grafana DB (steps 1, 4–6, 9):** if Grafana won't start after a version
  change, reverting the chart isn't enough: the database is already on the
  newer schema. Restore `grafana-db` from the Barman backup taken before the
  step (CNPG recovery into a new cluster, then point Grafana at it).

# Alloy

Grafana Alloy, the cluster's log collector. One pod per node (DaemonSet)
gathers two streams and pushes them both to Loki:

1. **Pod logs**: tails `/var/log/pods` on its node (CRI format).
2. **Kubernetes events**: scheduling, restarts, failed pulls and so on.

Logs that are *pushed* at the cluster (network-device syslog, Talos machine and
kernel logs) are received by the [log-receiver](../log-receiver/README.md) app
instead. Until 2026-11-13 Alloy had a syslog listener behind `alloy-syslog`
(10.77.20.64, TCP only); no device was ever pointed at it.

| | |
|---|---|
| **URL** | None. Pushes to `loki.logging.svc:3100` |
| **Chart** | [`alloy`](https://github.com/grafana/alloy/tree/main/operations/helm/charts/alloy) from `grafana.github.io/helm-charts`, version pinned in `app.yaml` |
| **Namespace** | `logging` (PSA `privileged`; shared with Loki and log-receiver) |
| **Storage** | None (reads the node's `/var/log`) |
| **Depends on** | Loki; the Kubernetes API (for discovery and events) |

## Files

| File | What it is |
|---|---|
| `app.yaml` | Argo CD Application with two sources: the chart, and this folder. Server-Side Apply |
| `values.yaml` | DaemonSet with control-plane tolerations, the `/var/log` mount, and the Alloy pipeline itself (`alloy.configMap.content`) |
| `kustomization.yaml` | Lists this folder's own manifests |
| `namespace.yaml` | The `logging` namespace, PSA `privileged` |

## How the pipeline reads

The config in `values.yaml` is Alloy's own language: blocks wired together
with `forward_to`. For pod logs: `discovery.kubernetes` finds pods →
`discovery.relabel` turns metadata into labels and the log file path →
`loki.source.file` tails the files → `loki.process` parses the CRI format →
`loki.write` pushes to Loki.

## Gotchas

- **The `logging` namespace is `privileged`** because Alloy mounts the host's
  `/var/log` (hostPath), which `baseline` forbids. Loki shares the namespace
  but is a plain non-root workload. The namespace lives here because Alloy is
  the reason for the label.
- **Tolerations matter.** talos1–3 are control-plane nodes and tainted;
  without the tolerations, their pod logs would be missed.

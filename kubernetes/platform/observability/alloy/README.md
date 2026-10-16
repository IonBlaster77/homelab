# Alloy

Grafana Alloy, the cluster's log collector. One pod per node (DaemonSet)
gathers three streams and pushes them all to Loki:

1. **Pod logs**: tails `/var/log/pods` on its node (CRI format).
2. **Kubernetes events**: scheduling, restarts, failed pulls and so on.
3. **Syslog** from network gear (RFC5424 over TCP), via a LAN LoadBalancer.

| | |
|---|---|
| **URL** | None. Syslog in on `10.77.20.64:514/TCP` (LoadBalancer); pushes to `loki.logging.svc:3100` |
| **Chart** | [`alloy`](https://github.com/grafana/alloy/tree/main/operations/helm/charts/alloy) from `grafana.github.io/helm-charts`, version pinned in `app.yaml` |
| **Namespace** | `logging` (PSA `privileged`; shared with Loki) |
| **Storage** | None (reads the node's `/var/log`) |
| **Depends on** | Loki; the Kubernetes API (for discovery and events) |

## Files

| File | What it is |
|---|---|
| `app.yaml` | Argo CD Application with two sources: the chart, and this folder. Server-Side Apply |
| `values.yaml` | DaemonSet with control-plane tolerations, the `/var/log` mount, the syslog port, and the Alloy pipeline itself (`alloy.configMap.content`) |
| `kustomization.yaml` | Lists this folder's own manifests |
| `namespace.yaml` | The `logging` namespace, PSA `privileged` |
| `service-syslog.yaml` | `alloy-syslog` LoadBalancer: LAN `:514` → Alloy `:1514` |

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
- **Syslog uses `externalTrafficPolicy: Local`** so the sending device's IP
  survives and shows up as a label. The flip side: only nodes running an
  Alloy pod answer on the VIP, which is all of them (DaemonSet).
- **No devices send syslog yet.** To start, point a device at
  `10.77.20.64:514`, TCP, RFC5424. Logs show up in Loki with `job="syslog"`.
- **Tolerations matter.** talos1–3 are control-plane nodes and tainted;
  without the tolerations, their pod logs would be missed.

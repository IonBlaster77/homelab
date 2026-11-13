# log-receiver

[Vector](https://vector.dev), receiving logs that are **pushed** at the cluster
from outside Kubernetes and forwarding them to Loki:

1. **Talos machine logs** (machined, apid, kubelet, etcd, ...) from every node's
   `machine.logging.destinations`, as JSON lines over TCP.
2. **Talos kernel logs** from every node's `KmsgLogConfig` document, same port.
3. **Syslog** from network devices: UDP or TCP, RFC3164 or RFC5424.

Why it exists: on 2026-11-13 talos3 and talos4 ran a graceful shutdown and
stayed off for 5 hours. Talos keeps its own logs in RAM only, so whatever
triggered the shutdown (a power-button press, an API call made straight to a
node) was lost at power-off. Now each node streams those logs off-node as they
happen.

| | |
|---|---|
| **URL** | `10.77.20.64` (LoadBalancer): Talos `:6050/TCP`, syslog `:514/UDP+TCP` |
| **Image** | `timberio/vector` distroless, pinned by tag and digest in `deployment.yaml` |
| **Namespace** | `logging` (owned by the alloy app) |
| **Storage** | None. In-memory buffers (100k events per sink) ride out a Loki outage |
| **Depends on** | Loki (`loki.logging.svc:3100`) |

## Querying

| What | LogQL |
|---|---|
| Everything one node said | `{job="talos", node="talos3"}` |
| One Talos service | `{job="talos", service="machined"}` |
| Kernel log | `{job="talos", service="kernel"}` |
| Shutdown/reboot trail | `{job="talos"} \|~ "(?i)shutdown\|reboot\|power button\|sequence"` |
| Network devices | `{job="syslog"}` (labels: `hostname`, `appname`) |

Lines are stored as the full JSON event, so `| json` exposes every Talos field
(`talos-level`, `talos-time`, `msg`, ...).

## Gotchas

- **Two replicas, required anti-affinity, PDB `minAvailable: 1`.** A node that
  is shutting down reaches the LoadBalancer IP from its host network, where
  Cilium's socket LB picks any backend, so its last lines can land on a
  receiver on another node.
- **Kernel lines carry no node name.** The node label comes from the sender's
  IP (`talos_shape` in `configmap.yaml`). Add new nodes to that map.
- **Config changes need a pod roll:** bump `homelab/config-rev` in
  `deployment.yaml` alongside any `configmap.yaml` change.
- **Network devices are not configured yet.** Point each at `10.77.20.64:514`
  (UDP is fine): MikroTik `/system logging action`, the Dell switch's
  `logging` host, the UniFi controller's remote syslog setting.

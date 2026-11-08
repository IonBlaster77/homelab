# Protecting critical pods from OOM kills

**Started:** 2026-11-07. That day, Trivy Operator's first full scan set off Talos'
OOM controller on talos1: 16 kills in two waves, at 05:30:56Z and 05:38:16Z.

The victims were:
- kube-apiserver (the API VIP refused connections for about a minute)
- the Longhorn instance-manager (every volume on talos1 detached; about 11 pods
  restarted; 24 volumes rebuilt)
- longhorn-manager, Grafana, argocd-application-controller and trivy-operator

Trivy is now limited to one scan job at a time (#379). This project is about
protecting the cluster from the next spike, whatever causes it.

## How it happened

- **What Talos watched:** not free RAM. More than 9 GiB stayed available. On
  v1.12.6, Talos fires on memory *stall* in its **podruntime** cgroup, which holds
  containerd, the kubelet and etcd. That stall was 9.8% while the node as a whole
  was at 0.88%. Evidence: `talosctl -n <node> get oomactions -o yaml` stores the
  metrics behind every kill. It keeps the last 50 and loses them on reboot.
- **Why podruntime stalled:**
  - The page cache fills RAM, which is normal.
  - A scan burst allocated about 1.5 GiB in under a minute, with about 700 MiB of
    dirty/writeback pages.
  - containerd, the kubelet and etcd were pushed into direct reclaim.
  - Their parent cgroup had **no memory protection**, so their own reservations
    didn't count. Fixed upstream in v1.12.11.
- **What it kills:** pods with no memory limit, ranked by QoS class × memory use.
  A big pod with requests (kube-apiserver) could outrank a small pod with none.
  Fixed upstream in v1.12.9 with strict QoS ordering.
- **Why 16 kills:** the trigger had no cooldown, so it killed again every 500 ms.
  That made things worse, because containerd and the kubelet couldn't keep up
  cleaning up. Fixed upstream in v1.12.10 ([#13622](https://github.com/siderolabs/talos/issues/13622)).

## Current exposure (2026-11-07)

Ranking every pod the way the controller does put critical infrastructure first
on every node:
- kube-apiserver
- the Longhorn instance-manager and longhorn-manager
- Prometheus, the Argo CD controller and Grafana
- every CNPG Postgres pod, plus Authentik

Unprotected pods: talos1 31/42, talos2 18/39, talos3 37/47, talos4 29/43.

These household-critical pods have **no requests at all** (BestEffort): AdGuard
primary DNS, Kea DHCP and its DB, cert-manager and cilium-operator.

The scheduler is blind to much of the memory in use. On talos1, requests add up to
21% of RAM while about 45% is used.

kubelet settings today:
- `systemReserved` 512Mi, no `kubeReserved`
- `evictionHard memory.available` 100Mi

So kubelet eviction never acts before Talos does.

## Plan

1. **Upgrade Talos to v1.12.12** (agreed 2026-11-07). This fixes all three failure
   modes above and also brings:
   - containerd 2.1.6 → 2.2.7. 2.1.x is EOL and affected by CVE-2026-46680.
   - runc 1.3.6
   - kernel 6.18.18 → 6.18.49
   - the "kubelet stuck restarting" fix, etcd fixes and API hardening

   Kubernetes was then moved from 1.35.0 to 1.35.8 as a separate step with
   `talosctl upgrade-k8s` (done 2026-11-07; it also bumped CoreDNS to 1.14.2 and
   reset its ConfigMap, which Argo selfHeal restored). Runbook below.
2. **Memory requests for critical pods**, via Git. Proposed tiers:
   - **Tier 0:** apiserver, Cilium, CoreDNS, Longhorn.
   - **Tier 1:** AdGuard, Kea and its DB, CNPG clusters, Authentik, cert-manager,
     cloudflared, Argo CD, Prometheus and Alertmanager, Harbor.

   CNPG clusters get Guaranteed QoS, as the CNPG docs recommend. Spiky pods get
   requests only. Sizes come from the 7–30-day peak in Prometheus, checked against
   each node's capacity; talos2 is tight (16 GiB, 11 GiB 7-day peak).
3. **Talos OOMConfig tuning**, only if still needed after 1 and 2 (v1.14 defaults
   are the reference).
4. **kubelet reservations and eviction** (decided 2026-11-07, design below):
   2 GiB reserved, soft eviction at 1 Gi free, hard eviction at 500 Mi free.
5. **PriorityClasses** for tiers 0 and 1, with `preemptionPolicy: Never`.
6. **Alerting:** ship Talos service logs (machined `controller-runtime`) to Alloy and
   Loki, and alert on OOM-controller kills. Today there is no signal at all.

Decisions 2, 3, 5 and 6 are still open; see the 2026-11-07 session notes.

## Step 4 design: kubelet reservations and eviction

Set in `machine.kubelet.extraConfig` in every `talos/*.yaml`, the same on all nodes:

| Setting | Value | Why |
|---|---|---|
| `systemReserved` | memory 512Mi; cpu 50m, ephemeral-storage 256Mi, pid 100 | Talos default memory for control planes (workers were 384Mi). The other three restate Talos' defaults: Talos only fills `systemReserved` when the map is empty, so setting memory alone would drop them. |
| `kubeReserved` | memory 1536Mi | podruntime (etcd, kubelet, containerd) uses 1.5–2.2 GiB at steady state. |
| `evictionHard` | memory.available 500Mi, plus the default disk thresholds | 500Mi is the Kubernetes docs' example. |
| `mergeDefaultEvictionSettings` | true | Without it, any threshold not listed becomes 0, so disk eviction would silently stop. |
| `evictionSoft` | memory.available 1Gi for 1m30s | Graceful eviction (up to 60 s) before the hard limit. |
| `evictionMinimumReclaim` | memory.available 256Mi | Avoids evicting one small pod at a time. |

Effect: pods' allocatable memory drops by about 2.4 GiB (23.3 → 20.8 GiB; talos2
15.4 → 12.9 GiB). The kubepods cgroup cap drops by about 1.5 GiB. Requests were at
most 8 GiB per node when this was set. In the previous 30 days free memory never went
below 9 GiB on any node except talos2 during its kernel leak (3 GiB), so eviction
should not fire in normal use.

Sources and reasoning:
- Kubernetes docs ("Reserve Compute Resources", "Node-pressure Eviction"):
  `Allocatable = capacity − kubeReserved − systemReserved − evictionHard`.
  Enforce only `pods`. Hard-capping system/kube reserved can OOM critical daemons.
- Sizing comparison: GKE's tiered formula would reserve about 3.1 GiB on 24 GiB
  (2.6 on 16). GKE's newer formula and EKS's are pod-density based, about 0.6–1.7 GiB.
  This design is sized from the measured podruntime use instead.
- Not used: `kernelMemcgNotification`. It relies on cgroup v1 memcg thresholds, and
  Talos runs cgroup v2.

Caveats:
- Hard eviction ignores PodDisruptionBudgets and kills immediately; soft eviction
  allows up to `evictionMaxPodGracePeriod`.
- Victims are pods using more than they requested, sorted by priority. Every
  BestEffort pod counts as over its request, so Prometheus and the CNPG databases are
  the first candidates until step 2 (requests) and step 5 (PriorityClasses) land.
- The kubelet counts `active_file` page cache as used (kubernetes#43916). It is
  0.35–1.8 GiB per node today, so keep the soft threshold modest.
- This covers the case where a node really runs out of memory. The 2026-11-07 storms
  were memory-*stall* triggers with about 9 GiB free, which the v1.12.12 upgrade and
  step 2 address.
- Alerts: kube-prometheus-stack's `KubeNodeEviction` and `KubeNodePressure` (warning)
  already cover evictions and MemoryPressure.

Apply: one node at a time with `talosctl apply-config` (dry-run says "without a
reboot"; only the kubelet restarts). Check node allocatable, the kubelet configz and
the podruntime cgroup's memory.min/low on each node afterwards.

## Steps 2 and 5 design: requests, limits and priorities

Decided with the user on 2026-11-07:

- **Databases (CNPG):** memory request = limit (384Mi; authentik and paperclip
  512Mi, about 2× their 30-day peak) plus a CPU request and **no CPU limit**.
  So they are Burstable, not the Guaranteed QoS the CNPG docs recommend: CPU is
  the scarce resource here (4 cores per node). Any memory limit already exempts
  a pod from the Talos OOM controller's ranking.
- **Steady pods** (Argo CD, Authentik, Harbor, AdGuard, Kea, cert-manager,
  Grafana, the CNPG operator, trivy-operator): a memory request from 7-day use,
  and a memory limit of about 2× the 30-day peak, with a 128Mi floor.
- **Request only**, no limit: kube-apiserver, Cilium, longhorn-manager and
  Prometheus. Their use tracks load, and killing them hurts most.
- **CPU:** requests from the 7-day average on every critical pod. Never CPU
  limits.
- **Capacity:** everything must fit with one node down. Memory fits (86%).
  CPU comes to about 106% with one node down, which the user accepted until
  two more nodes are added.
- **Priorities:** `homelab-critical` (1e8, below longhorn-critical) for tier 1
  and `homelab-batch` (-1000) for Trivy scan jobs. Neither preempts.
  Tier 0 keeps system-*-critical and longhorn-critical.
- **Keeping sizes right:** alerts for "over request for a day" and "above 85%
  of limit", a Grafana panel, and the Vertical Pod Autoscaler in recommend-only
  mode (CNPG treats `spec.resources` as the source of truth).
- **Scope:** critical pods only. The rest get defaults later, through Kyverno.
- **Rollout:** five batches, in a night window. The PriorityClasses ship and
  sync first, because a pod that names a missing class is rejected.
  1. PriorityClasses, cert-manager, CNPG operator, AdGuard, Kea, Harbor,
     trivy-operator.
  2. Prometheus, Grafana, Argo CD, Authentik.
  3. The CNPG databases, two or three at a time (one primary switchover each).
  4. Cilium (manual sync; agent and envoy together) and longhorn-manager.
  5. kube-apiserver request (2Gi) in the Talos config, via sops.

### Batch 5: kube-apiserver (2026-11-08)

`cluster.apiServer.resources.requests` in talos/controlplane.yaml and
talos1-3.yaml: **cpu 250m, memory 2Gi**, no limit (was the Talos default
200m / 512Mi).

Measured before the change (Prometheus, working set):

| | talos1 | talos2 | talos3 |
|---|---|---|---|
| now | 4.20 GiB | 4.25 GiB | 4.19 GiB |
| 7-day average | 3.61 GiB | 3.69 GiB | 3.11 GiB |
| 7-day minimum | 2.11 GiB | 2.30 GiB | 1.49 GiB |
| 30-day peak | 4.72 GiB | 5.07 GiB | 4.26 GiB |
| CPU, 7-day average | 267m | 255m | 241m |

2Gi is deliberately below real use. talos3 was already 84% memory-requested,
so 2Gi takes it to about 91%; 3.5Gi (the 7-day average) would take it to about
99%, leaving no room to schedule there and making the kubelet evict pods to
admit the static pod if requests grow. Raise it to about 3.5Gi once the two
new nodes join. The request mainly fixes scheduler accounting: since Talos
1.12.9 the OOM controller already ranks Burstable pods after BestEffort ones.

Apply: dry-run shows only the `resources` block, "without a reboot". Apply one
control-plane node at a time; the apiserver static pod restarts on that node
(the other two keep serving). Check the static pod's requests, `/livez` on the
node, and etcd 3/3 before the next node.

### Keeping sizes right: drift alerts, dashboard, VPA (2026-11-08)

- **Alerts** (`prometheusrule-infra.yaml`, group `resource-drift`, severity
  warning):
  - `CriticalPodOverMemoryRequest`: a container's 1-day average working set
    is above its memory request, for 1 h.
  - `CriticalPodNearMemoryLimit`: working set above 85% of the memory limit
    for 30 min.
  - Scope: pods in the priority classes homelab-critical, longhorn-critical
    and system-*-critical that have a request/limit. Talos' static
    control-plane pods are left out of the request alert: their requests are
    Talos defaults, and kube-apiserver is deliberately under-requested (batch
    5). Checked against live data on 2026-11-08: neither alert would fire;
    harbor-registry reached 89% of its limit once in the previous 7 days.
- **Dashboard**: Grafana → "Resource drift" (`configmap-dashboard-resource-drift.yaml`).
- **VPA**: recommender only, `kubernetes/platform/system/vpa` (README there).
  36 `updateMode: "Off"` objects for the critical workloads; their
  recommendations reach Prometheus through kube-state-metrics'
  custom-resource config.

## Step 1 runbook: Talos v1.12.6 → v1.12.12

Installer:
`factory.talos.dev/installer/203464d7568ceebc8d7d6f16811629d1722c3e1a4d4f2979c85587f19367f17b:v1.12.12`
(same schematic: iscsi-tools, nfs-utils, util-linux-tools).

Notes:
- **EPHEMERAL is kept.** Since Talos 1.8, upgrades never wipe the system disk and
  `--preserve` is always on (the flag is gone from talosctl 1.12). Longhorn data
  under `/var/lib/longhorn` survives.
- **The node does the drain itself.** It cordons and drains, reboots once into the
  new image, then makes it permanent and uncordons. Talos refuses to upgrade a
  control-plane node if that would lose etcd quorum.
- **Rollback:** `talosctl -n <node> rollback`. A node that fails to boot rolls back
  automatically.

**Before:**
- Update the talosctl client in WSL to 1.12.12 (recommended to match).
- `talosctl -n 10.77.20.11 etcd status` and `etcd members`: 3 members, no errors.
- All Longhorn volumes `healthy`.
- `kubectl get nodes`: all Ready.
- Argo CD apps all Healthy.
- Don't run it during a Trivy full scan, or on a day the UPS matters. The UPS is
  still out of service.

**Order:**
1. talos4 (worker, no etcd)
2. talos1
3. talos2 (16 GiB)
4. talos3 last: Harbor's registry PVC is single-replica on talos3, so the registry
   is down while it reboots. Nodes fall back to upstream registries.

Per node:
```bash
talosctl -n <ip> upgrade --image factory.talos.dev/installer/203464d7568ceebc8d7d6f16811629d1722c3e1a4d4f2979c85587f19367f17b:v1.12.12
talosctl -n <ip> version            # Tag: v1.12.12
kubectl get nodes                   # Ready, uncordoned
kubectl -n longhorn-system get volumes.longhorn.io   # wait until all healthy before the next node
talosctl -n 10.77.20.11 etcd status # control-plane nodes: all members back, no errors
```

Never run `talosctl bootstrap` on a reboot.

**After:**
- Dry-run each node's config against `talos/<node>.yaml`, which now says v1.12.12.
  Grep key/crt/token lines out of the dry-run diff, because it prints decrypted
  secrets.
- Recheck `get oomactions`.
- Check Grafana for talos2's memory trend (watching whether the kernel update
  changes its leak).

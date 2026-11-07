# Descheduler

Nightly rebalancing of pods across nodes. Added 2026-11-07 after the OOM
protection rollout (docs/projects/oom-protection.md) left talos3 at 84% of its
memory requested while the other nodes sat at 40–47%.

## Why

The Kubernetes scheduler only places a pod when it starts, on the node with
the most unreserved room, and never moves it afterwards. So a wave of restarts
(an upgrade, a node drain, a resources change) piles pods onto whichever node
was emptiest at that moment, and they stay there.

The descheduler evicts a few pods from over-full nodes. The normal scheduler
then restarts them on emptier nodes.

## What it does here

- Runs as a CronJob at **03:30 Australia/Adelaide**, nightly.
- **LowNodeUtilization on memory requests only.** Nodes over 70% memory
  requested give up pods; only nodes under 50% receive them. CPU is left out
  because CPU requests sit near 85% on three nodes, so a CPU threshold would
  find nowhere to move anything.
- **RemoveDuplicates** and **RemovePodsViolatingTopologySpreadConstraint**,
  so replicas of one app don't stay stacked on one node.
- At most **2 evictions per node and 5 in total per run**: the cluster
  converges over a few nights instead of churning.
- `nodeFit: true`: a pod is only evicted if it fits on another node.

## What it never touches

- kube-system, longhorn-system, adguard (DNS) and kea (DHCP). AdGuard and Kea
  use Recreate Deployments, so an eviction would be an outage. trivy-system is
  also excluded, to avoid scan churn.
- System-critical pods, DaemonSet pods and bare pods (DefaultEvictor
  defaults).
- Anything a PodDisruptionBudget protects. The CNPG primary PDB allows 0, so
  **database primaries never move**: rebalance those by hand with
  `kubectl cnpg promote <cluster> <standby>`. The `CNPGPrimariesConcentrated`
  alert (prometheusrule-cnpg.yaml) fires when more than 3 sit on one node.

Pods with PVCs **are** allowed to move (Prometheus, Harbor, CNPG standbys):
Longhorn re-attaches the volume on the new node, which takes about 30–60 s.
Prometheus takes a few minutes to replay its WAL.

## Operating it

- Run it now: `kubectl -n descheduler create job --from=cronjob/descheduler descheduler-manual-$(date +%s)`,
  then read the job's log. It names every eviction and the node usage it saw.
- Pause it: set `suspend: true` in values.yaml.
- Upgrades: bump `version` in kustomization.yaml. Descheduler minors track
  Kubernetes minors (0.35.x for Kubernetes 1.35).
